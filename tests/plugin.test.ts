import { describe, expect, it, vi } from 'vitest';
import { TFile, TFolder, type PluginSettingTab, type SettingDefinitionAction } from 'obsidian';
import * as obsidian from 'obsidian';
import type { TestElement } from './obsidian-mock';
import { Notice } from './obsidian-mock';
import { t } from '../src/i18n';
import BasePathUpdater from '../src/main';
import { MAX_HISTORY_BYTES, MAX_OPERATIONS, historySize, type HistoryData } from '../src/history';

type TestPlugin = BasePathUpdater & { persisted: unknown; saved: HistoryData[]; failSave: boolean };

/** Returns a promise and its resolver for deterministic async lifecycle tests. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Creates a plugin with the supplied files and stored journal, returning event and storage controls. */
async function setup(
  initial: Record<string, string> = { 'view.base': 'filters: file.inFolder("Old")\n' },
  persisted: unknown = null,
) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const contents = new Map<TFile, string>();
  for (const [path, text] of Object.entries(initial)) {
    const file = new TFile();
    file.path = path;
    contents.set(file, text);
  }
  const vault = {
    on: (name: string, callback: (...args: unknown[]) => void) => listeners.set(name, callback),
    getFiles: () => [...contents.keys()],
    getAbstractFileByPath: (path: string) =>
      [...contents.keys()].find((file) => file.path === path),
    read: vi.fn(async (file: TFile) => contents.get(file)!),
    process: vi.fn(async (file: TFile, callback: (content: string) => string) => {
      const result = callback(contents.get(file)!);
      contents.set(file, result);
      return result;
    }),
  };
  const plugin = new BasePathUpdater(
    { vault, workspace: { onLayoutReady: (callback: () => void) => callback() } } as never,
    {} as never,
  ) as TestPlugin;
  plugin.app = {
    vault,
    workspace: { onLayoutReady: (callback: () => void) => callback() },
  } as never;
  plugin.persisted = persisted;
  await plugin.onload();
  const flush = () => (plugin as unknown as { queue: Promise<void> }).queue;
  const folderMove = (oldPath: string, newPath: string) => {
    for (const file of contents.keys()) {
      if (file.path.startsWith(`${oldPath}/`))
        file.path = newPath + file.path.slice(oldPath.length);
    }
    const folder = new TFolder();
    folder.path = newPath;
    listeners.get('rename')!(folder, oldPath);
  };
  return { plugin, vault, contents, listeners, flush, folderMove };
}

describe('plugin lifecycle and safe writes', () => {
  it('does not save or write after an unloaded instance finishes reading a Base', async () => {
    const h = await setup();
    const started = deferred<void>();
    const pending = deferred<string>();
    h.vault.read.mockImplementationOnce(async () => {
      started.resolve();
      return pending.promise;
    });
    h.folderMove('Old', 'New');
    await started.promise;
    h.plugin.onunload();
    const replacement = await setup();
    replacement.folderMove('Old', 'Final');
    await replacement.flush();
    const newHistory = structuredClone(replacement.plugin.persisted);
    const lateSave = vi.spyOn(h.plugin, 'saveData').mockImplementation(async (data) => {
      replacement.plugin.persisted = structuredClone(data);
    });
    pending.resolve('filters: file.inFolder("Old")\n');
    await h.flush();
    expect(lateSave).not.toHaveBeenCalled();
    expect(h.vault.process).not.toHaveBeenCalled();
    expect(replacement.plugin.persisted).toEqual(newHistory);
  });

  it('waits for an in-flight old journal save before a replacement instance loads history', async () => {
    const h = await setup();
    const started = deferred<void>();
    const pending = deferred<void>();
    const save = vi.spyOn(h.plugin, 'saveData').mockImplementationOnce(async (data) => {
      started.resolve();
      await pending.promise;
      h.plugin.persisted = structuredClone(data);
    });
    h.folderMove('Old', 'New');
    await started.promise;
    h.plugin.onunload();
    const replacement = new BasePathUpdater(h.plugin.app, {} as never);
    replacement.app = h.plugin.app;
    const load = vi
      .spyOn(replacement, 'loadData')
      .mockImplementation(async () => structuredClone(h.plugin.persisted));
    const loading = replacement.onload();
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([loading, h.flush()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(replacement.data.operations[0]!.oldPath).toBe('Old');
    expect(save).toHaveBeenCalledTimes(1);
    expect(h.vault.process).not.toHaveBeenCalled();
  });

  it.each(['update', 'undo'])(
    'does not change a Base if unloaded before the %s process callback runs',
    async (mode) => {
      const h = await setup();
      if (mode === 'undo') {
        h.folderMove('Old', 'New');
        await h.flush();
      }
      const started = deferred<void>();
      const pending = deferred<void>();
      h.vault.process.mockImplementationOnce(async (file, callback) => {
        started.resolve();
        await pending.promise;
        const result = callback(h.contents.get(file)!);
        h.contents.set(file, result);
        return result;
      });
      const before = [...h.contents.values()];
      if (mode === 'undo') void h.plugin.undo(h.plugin.data.operations[0]!);
      else h.folderMove('Old', 'New');
      await started.promise;
      h.plugin.onunload();
      const saved = structuredClone(h.plugin.saved);
      pending.resolve();
      await h.flush();
      expect([...h.contents.values()]).toEqual(before);
      expect(h.plugin.saved).toEqual(saved);
    },
  );

  it('leaves a full undo journal unchanged when the only candidate exceeds snapshot capacity', async () => {
    const journal: HistoryData = {
      version: 2,
      operations: Array.from({ length: MAX_OPERATIONS }, (_, index) => ({
        id: `previous-${index}`,
        timestamp: index,
        oldPath: 'A',
        newPath: 'B',
        errors: [],
        files: [
          { path: `previous-${index}.base`, before: 'A', after: 'B', changes: [], undone: false },
        ],
      })),
    };
    const huge = 'filters: file.inFolder("Old")\n# ' + 'x'.repeat(MAX_HISTORY_BYTES / 2 + 1);
    const h = await setup({ 'huge.base': huge }, journal);
    h.folderMove('Old', 'New');
    await h.flush();
    expect(h.vault.process).not.toHaveBeenCalled();
    expect(h.plugin.data).toEqual(journal);
    expect(h.plugin.persisted).toEqual(journal);
    expect(h.plugin.saved).toHaveLength(0);
    expect(Notice.messages.at(-1)).toBe(t('historyCapacitySkipped', { count: 1 }));
  });

  it('skips oversized candidates and still journals and undoes subsequent small updates', async () => {
    const huge = 'filters: file.inFolder("Old")\n# ' + 'x'.repeat(MAX_HISTORY_BYTES / 2 + 1);
    const h = await setup({ 'huge.base': huge, 'small.base': 'filters: file.inFolder("Old")' });
    h.folderMove('Old', 'New');
    await h.flush();
    expect(h.vault.process).toHaveBeenCalledTimes(1);
    expect(h.plugin.data.operations[0]!.files.map((file) => file.path)).toEqual(['small.base']);
    expect(h.plugin.data.operations[0]!.errors[0]!.error.code).toBe('historyLimit');
    expect(historySize(h.plugin.data)).toBeLessThan(MAX_HISTORY_BYTES);
    await h.plugin.undo(h.plugin.data.operations[0]!);
    expect([...h.contents.values()]).toEqual([huge, 'filters: file.inFolder("Old")']);
  });

  it('loads v1 history without saving and persists v2 only when a real undo occurs', async () => {
    const persisted = {
      version: 1,
      operations: [
        {
          id: 'legacy',
          timestamp: 123,
          oldPath: 'Old',
          newPath: 'New',
          errors: [],
          files: [
            {
              path: 'view.base',
              before: 'old\r\n',
              after: 'new\r\n',
              changes: [],
              undone: false,
              error: '文件已被后续修改，未覆盖；请先撤回较新的操作或手动检查',
            },
          ],
        },
      ],
    };
    const h = await setup({ 'view.base': 'new\r\n' }, persisted);
    expect(h.plugin.saved).toHaveLength(0);
    expect(h.plugin.persisted).toEqual(persisted);
    expect(h.plugin.data.version).toBe(2);
    await h.plugin.undo(h.plugin.data.operations[0]!);
    expect([...h.contents.values()]).toEqual(['old\r\n']);
    expect(h.plugin.saved.at(-1)!.version).toBe(2);
    expect(h.plugin.saved.at(-1)!.operations[0]!.files[0]!.error).toBeUndefined();
  });

  it('pauses automatic writes when structured history contains an unrecognized failure', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = await setup(undefined, {
        version: 2,
        operations: [
          {
            id: 'bad',
            timestamp: 1,
            oldPath: 'Old',
            newPath: 'New',
            files: [],
            errors: [{ error: { code: 'futureError' } }],
          },
        ],
      });
      h.folderMove('Old', 'New');
      await h.flush();
      expect(h.vault.process).not.toHaveBeenCalled();
      expect(h.plugin.saved).toHaveLength(0);
      expect(Notice.messages.at(-1)).toContain('Could not read history');
    } finally {
      log.mockRestore();
    }
  });

  it.each(['en', 'zh'])(
    'localizes update notifications in %s while persisting only failure codes',
    async (language) => {
      const languageSpy = vi.spyOn(obsidian, 'getLanguage').mockReturnValue(language);
      try {
        const h = await setup({ 'bad.base': 'filters: [Old' });
        h.folderMove('Old', 'New');
        await h.flush();
        expect(Notice.messages.at(-1)).toBe(
          `Base Path Updater: ${t('updateWithErrors', { count: 0, errors: 1 })}`,
        );
        expect(h.plugin.saved.at(-1)!.operations[0]!.errors).toEqual([
          { path: 'bad.base', error: { code: 'invalidYaml' } },
        ]);
      } finally {
        languageSpy.mockRestore();
      }
    },
  );

  it.each(['en', 'zh'])(
    'localizes commands and both settings renderers in %s without I/O during indexing',
    async (language) => {
      vi.spyOn(obsidian, 'getLanguage').mockReturnValue(language);
      const register = vi.spyOn(BasePathUpdater.prototype, 'addSettingTab');
      const command = vi.spyOn(BasePathUpdater.prototype, 'addCommand');
      try {
        const h = await setup();
        const openHistory = vi.spyOn(h.plugin, 'openHistory').mockImplementation(() => {});
        const tab = register.mock.calls[0]![0] as PluginSettingTab;
        const definitions = tab.getSettingDefinitions();
        const history = definitions[0] as SettingDefinitionAction;
        expect(history.name).toBe(t('historyName'));
        expect(command.mock.calls[0]![0].name).toBe(t('openHistory'));
        expect(command.mock.calls[0]![0].id).toBe('open-history');
        expect(history.aliases).toEqual(expect.arrayContaining(['history', 'undo', '撤回']));
        expect(openHistory).not.toHaveBeenCalled();
        expect(h.vault.read).not.toHaveBeenCalled();
        history.action({} as HTMLElement, 0);
        expect(openHistory).toHaveBeenCalledTimes(1);
        tab.display();
        const sink = tab.containerEl as unknown as TestElement;
        expect(sink.texts).toContain(history.name);
        expect(sink.texts).toContain(history.desc);
        expect(sink.buttons[0]!.text).toBe(t('historyButton'));
        sink.buttons[0]!.click();
        expect(openHistory).toHaveBeenCalledTimes(2);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it('does no reads on startup or edits and only inspects cached Bases on folder rename', async () => {
    const h = await setup({ 'view.base': 'filters: file.inFolder("Old")', 'note.md': 'Old' });
    expect(h.vault.read).not.toHaveBeenCalled();
    expect(h.listeners.has('modify')).toBe(false);
    h.folderMove('Old', 'New');
    await h.flush();
    expect(h.vault.read).toHaveBeenCalledTimes(1);
    expect(h.vault.process).toHaveBeenCalledTimes(1);
    expect(h.plugin.saved[0]!.operations[0]!.files[0]!.before).toContain('Old');
    const operation = h.plugin.data.operations[0]!;
    await h.plugin.undo(operation);
    expect(operation.files[0]!.undone).toBe(true);
    expect([...h.contents.values()][0]).toContain('Old');
  });

  it('serializes rapid folder moves and restores in reverse order', async () => {
    const h = await setup({ 'Old/view.base': 'filters: file.inFolder("Old")' });
    h.folderMove('Old', 'Middle');
    h.folderMove('Middle', 'New');
    await h.flush();
    expect([...h.contents.values()][0]).toContain('New');
    expect(h.plugin.data.operations).toHaveLength(2);
    expect(
      h.plugin.data.operations.every((operation) => operation.files[0]!.path === 'New/view.base'),
    ).toBe(true);
    await h.plugin.undo(h.plugin.data.operations[0]!);
    await h.plugin.undo(h.plugin.data.operations[1]!);
    expect([...h.contents.values()][0]).toBe('filters: file.inFolder("Old")');
  });

  it('preserves manual edits on undo and supports persisted history after restart', async () => {
    const h = await setup();
    h.folderMove('Old', 'New');
    await h.flush();
    const restarted = await setup(
      Object.fromEntries([...h.contents].map(([file, text]) => [file.path, text])),
      h.plugin.persisted,
    );
    const file = [...restarted.contents.keys()][0]!;
    restarted.contents.set(file, restarted.contents.get(file)! + '# manual edit');
    await restarted.plugin.undo(restarted.plugin.data.operations[0]!);
    expect(restarted.contents.get(file)).toContain('# manual edit');
    expect(restarted.plugin.data.operations[0]!.files[0]!.error).toEqual({ code: 'undoConflict' });
  });

  it('refuses file writes when the undo journal cannot be saved', async () => {
    const h = await setup();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.plugin.failSave = true;
    h.folderMove('Old', 'New');
    await h.flush();
    expect(h.vault.process).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('skips concurrent edits between read and process', async () => {
    const h = await setup();
    const original = h.vault.read.getMockImplementation()!;
    h.vault.read.mockImplementation(async (file) => {
      const before = await original(file);
      h.contents.set(file, before + '# edited');
      return before;
    });
    h.folderMove('Old', 'New');
    await h.flush();
    expect([...h.contents.values()][0]).toContain('# edited');
    expect(h.plugin.data.operations[0]!.errors[0]!.error).toEqual({ code: 'concurrentEdit' });
  });

  it('continues past a malformed Base and never writes unchanged Bases', async () => {
    const h = await setup({
      'bad.base': 'filters: [Old',
      'good.base': 'filters: file.inFolder("Old")',
      'other.base': 'filters: file.hasTag("Old")',
    });
    h.folderMove('Old', 'New');
    await h.flush();
    expect(h.vault.process).toHaveBeenCalledTimes(1);
    expect(h.plugin.data.operations[0]!.errors).toHaveLength(1);
  });

  it('does not undo into a replacement file at the same path after deletion', async () => {
    const h = await setup();
    h.folderMove('Old', 'New');
    await h.flush();
    const file = [...h.contents.keys()][0]!;
    h.listeners.get('delete')!(file);
    await h.flush();
    h.contents.delete(file);
    const replacement = new TFile();
    replacement.path = file.path;
    h.contents.set(replacement, h.plugin.data.operations[0]!.files[0]!.after);
    await h.plugin.undo(h.plugin.data.operations[0]!);
    expect(h.plugin.data.operations[0]!.files[0]!.error).toEqual({ code: 'missingBase' });
  });

  it('ignores work queued after unload', async () => {
    const h = await setup();
    h.folderMove('Old', 'New');
    h.plugin.onunload();
    await h.flush();
    expect(h.vault.process).not.toHaveBeenCalled();
  });
});
