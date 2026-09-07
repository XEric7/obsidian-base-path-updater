import { describe, expect, it, vi } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import BasePathUpdater from '../src/main';
import type { HistoryData } from '../src/history';

type TestPlugin = BasePathUpdater & { persisted: unknown; saved: HistoryData[]; failSave: boolean };

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
    expect(restarted.plugin.data.operations[0]!.files[0]!.error).toContain('后续修改');
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
    expect(h.plugin.data.operations[0]!.errors[0]).toContain('更新期间');
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
    expect(h.plugin.data.operations[0]!.files[0]!.error).toContain('已删除');
  });

  it('ignores work queued after unload', async () => {
    const h = await setup();
    h.folderMove('Old', 'New');
    h.plugin.onunload();
    await h.flush();
    expect(h.vault.process).not.toHaveBeenCalled();
  });
});
