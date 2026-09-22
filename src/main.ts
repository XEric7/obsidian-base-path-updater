import {
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  type SettingDefinitionItem,
} from 'obsidian';
import { updateBase } from './base-document';
import { movePath } from './expressions';
import {
  historySize,
  MAX_HISTORY_BYTES,
  MAX_OPERATIONS,
  readHistory,
  applyUndo,
  type FileChange,
  type HistoryData,
  type Operation,
} from './history';
import { mayContainBaseFence, updateMarkdownBases } from './markdown-bases';
import { HistoryModal } from './ui';
import { PluginError, serializeError } from './errors';
import { formatError, HISTORY_SEARCH_TERMS, t, type MessageKey } from './i18n';
import { runWrite, waitForWrites } from './write-coordinator';

const INDEX_YIELD = 20;
const BENIGN_SECTIONS = new Set([
  'yaml',
  'paragraph',
  'heading',
  'list',
  'blockquote',
  'table',
  'thematicBreak',
  'html',
  'footnoteDefinition',
  'callout',
  'text',
]);

/** Tracks folder moves, journals Base updates, and provides conflict-safe undo. */
export default class BasePathUpdater extends Plugin {
  data: HistoryData = { version: 2, operations: [] };
  private bases = new Set<TFile>();
  private queue: Promise<void> = Promise.resolve();
  private mdBackfill: Promise<void> = Promise.resolve();
  private stopped = false;
  private ready = false;
  private storageFailed = false;

  /** Loads history and registers localized entry points and vault event handlers. */
  async onload(): Promise<void> {
    try {
      await waitForWrites(this.app);
      if (this.stopped) return;
      this.data = readHistory(await this.loadData());
    } catch (error) {
      this.storageFailed = true;
      this.report('loadFailed', error);
    }
    if (this.stopped) return;
    this.addRibbonIcon('folder-sync', 'Base Path Updater', (event) => {
      new Menu()
        .addItem((item) =>
          item
            .setTitle(t('openHistory'))
            .setIcon('history')
            .onClick(() => this.openHistory()),
        )
        .showAtMouseEvent(event);
    });
    this.addCommand({
      id: 'open-history',
      name: t('openHistory'),
      callback: () => this.openHistory(),
    });
    this.addSettingTab(new HistorySettingTab(this));
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (!this.ready || !(file instanceof TFile)) return;
        if (file.extension === 'base') this.bases.add(file);
        else if (file.extension === 'md') void this.inspectMarkdown(file, false);
      }),
    );
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (this.ready && file instanceof TFile && file.extension === 'md') {
          void this.inspectMarkdown(file, false);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile) this.bases.delete(file);
        const path = file.path;
        void this.enqueue(async () => {
          let changed = false;
          for (const operation of this.data.operations) {
            for (const entry of operation.files) {
              if (
                entry.path === path ||
                (file instanceof TFolder && entry.path.startsWith(`${path}/`))
              ) {
                entry.missing = true;
                changed = true;
              }
            }
          }
          if (changed) await this.persist();
        });
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        const newPath = file.path;
        if (file instanceof TFile) {
          if (file.extension === 'base') this.bases.add(file);
          else if (file.extension === 'md') void this.inspectMarkdown(file, false);
          else this.bases.delete(file);
        }
        if (!this.ready) return;
        const folder = file instanceof TFolder;
        void this.enqueue(async () => {
          await this.mdBackfill;
          if (this.stopped) return;
          let changed = false;
          for (const operation of this.data.operations) {
            for (const entry of operation.files) {
              if (entry.missing) continue;
              const moved = folder
                ? movePath(entry.path, oldPath, newPath)
                : entry.path === oldPath
                  ? newPath
                  : entry.path;
              if (moved !== entry.path) {
                entry.path = moved;
                changed = true;
              }
            }
          }
          if (changed) await this.persist();
          if (folder) await this.updateFolder(oldPath, newPath, [...this.bases]);
        });
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      this.bases = new Set(this.app.vault.getFiles().filter((file) => file.extension === 'base'));
      this.ready = true;
      this.mdBackfill = this.scanMarkdownIndex();
    });
  }

  /** Stops queued work and releases the cached file references. */
  onunload(): void {
    this.stopped = true;
    this.bases.clear();
  }

  /** Opens the history modal in the current app language. */
  openHistory(): void {
    new HistoryModal(this).open();
  }

  /** Displays the supplied message key and logs the caught error with translated details. */
  private report(key: MessageKey, error: unknown): void {
    if (this.stopped) return;
    console.error(`[Base Path Updater] ${t(key)} ${formatError(serializeError(error))}`, error);
    new Notice(`Base Path Updater: ${t(key)}`);
  }

  /** Serializes the supplied async task and returns its completion promise, reporting failures. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (!this.stopped && !this.storageFailed) await task();
      })
      .catch((error) => this.report('operationFailed', error));
    return this.queue;
  }

  /** Saves the journal if active, returning false after unload and pausing work on storage failure. */
  private async persist(): Promise<boolean> {
    if (this.stopped || this.storageFailed) return false;
    try {
      return await runWrite(this.app, async () => {
        if (this.stopped || this.storageFailed) return false;
        await this.saveData(this.data);
        return !this.stopped;
      });
    } catch (error) {
      this.storageFailed = true;
      this.report('saveFailed', error);
      throw error;
    }
  }

  /** Returns Markdown files from the host listing, falling back to a full vault filter. */
  private markdownFiles(): TFile[] {
    if (typeof this.app.vault.getMarkdownFiles === 'function')
      return this.app.vault.getMarkdownFiles();
    return this.app.vault.getFiles().filter((file) => file.extension === 'md');
  }

  /** Waits until metadata caches exist or the host signals that initial indexing finished. */
  private waitForMetadata(): Promise<void> {
    const cache = this.app.metadataCache;
    if (!cache) return Promise.resolve();
    const ready = () => {
      const files = this.markdownFiles();
      return files.length === 0 || files.every((file) => cache.getFileCache(file) != null);
    };
    if (ready()) return Promise.resolve();
    if (typeof cache.on !== 'function') return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => resolve();
      this.registerEvent(cache.on('resolved', finish));
      if (ready()) finish();
    });
  }

  /** Returns whether a cached note still needs a content read to detect `base` fences. */
  private shouldReadMarkdown(file: TFile): boolean {
    const cached = this.app.metadataCache?.getFileCache(file);
    if (cached == null) return true;
    return (cached.sections ?? []).some(
      (section) => section.type === 'code' || !BENIGN_SECTIONS.has(section.type),
    );
  }

  /** Adds or removes a Markdown file from the candidate set using a cheap fence probe. */
  private async inspectMarkdown(file: TFile, useCache: boolean): Promise<void> {
    if (this.stopped || file.extension !== 'md') return;
    if (this.app.vault.getAbstractFileByPath(file.path) !== file) {
      this.bases.delete(file);
      return;
    }
    if (useCache && !this.shouldReadMarkdown(file)) {
      this.bases.delete(file);
      return;
    }
    try {
      const text = await this.app.vault.cachedRead(file);
      if (this.stopped) return;
      if (this.app.vault.getAbstractFileByPath(file.path) !== file) {
        this.bases.delete(file);
        return;
      }
      if (mayContainBaseFence(text)) this.bases.add(file);
      else this.bases.delete(file);
    } catch {
      // Leave membership unchanged when the host cannot read the note.
    }
  }

  /** Reads Markdown notes once after layout is ready and records those with `base` fences. */
  private async scanMarkdownIndex(): Promise<void> {
    try {
      await this.waitForMetadata();
      if (this.stopped) return;
      const files = this.markdownFiles();
      for (let index = 0; index < files.length; index++) {
        if (this.stopped) return;
        await this.inspectMarkdown(files[index]!, true);
        if ((index + 1) % INDEX_YIELD === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    } catch {
      // Folder moves still proceed with whatever has been indexed.
    }
  }

  /** Updates candidate Bases for the supplied folder move and persists snapshots and failure codes. */
  private async updateFolder(oldPath: string, newPath: string, candidates: TFile[]): Promise<void> {
    const operation: Operation = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: Date.now(),
      oldPath,
      newPath,
      files: [],
      errors: [],
    };
    for (const file of candidates) {
      if (this.stopped || this.storageFailed) break;
      if (
        (file.extension !== 'base' && file.extension !== 'md') ||
        this.app.vault.getAbstractFileByPath(file.path) !== file
      )
        continue;
      let entry: FileChange | undefined;
      try {
        const before = await this.app.vault.read(file);
        if (this.stopped) return;
        const update =
          file.extension === 'base'
            ? { ...updateBase(before, oldPath, newPath), regions: undefined, errors: [] }
            : updateMarkdownBases(before, oldPath, newPath);
        for (const error of update.errors) operation.errors.push({ path: file.path, error });
        if (!update.changes.length) continue;
        const candidate: FileChange = {
          path: file.path,
          changes: update.changes,
          undone: false,
          ...(update.regions?.length
            ? { regions: update.regions }
            : { before, after: update.text }),
        };
        // Check the active operation alone before changing any existing history.
        const proposed = { ...operation, files: [...operation.files, candidate] };
        if (historySize({ version: 2, operations: [proposed] }) > MAX_HISTORY_BYTES) {
          throw new PluginError({
            code: 'historyLimit',
            params: { limitMiB: MAX_HISTORY_BYTES / (1024 * 1024) },
          });
        }
        entry = candidate;
        operation.files.push(entry);
        if (!this.data.operations.includes(operation)) {
          this.data.operations.unshift(operation);
          this.data.operations.splice(MAX_OPERATIONS);
        }
        while (historySize(this.data) > MAX_HISTORY_BYTES && this.data.operations.length > 1) {
          this.data.operations.pop();
        }
        // Write-ahead snapshot survives a crash between the vault write and status save.
        if (!(await this.persist()) || this.stopped) return;
        await runWrite(this.app, async () => {
          if (this.stopped) return;
          await this.app.vault.process(file, (current) => {
            if (this.stopped) return current;
            if (current !== before) throw new PluginError({ code: 'concurrentEdit' });
            return update.text;
          });
        });
        if (this.stopped) return;
      } catch (error) {
        if (this.stopped) return;
        const detail = serializeError(error);
        if (entry) entry.error = detail;
        operation.errors.push({ path: file.path, error: detail });
      }
    }
    if (this.stopped || this.storageFailed) return;
    // A rejected oversized operation must not consume an undo-history slot.
    if (
      !operation.files.length &&
      operation.errors.length &&
      operation.errors.every((entry) => entry.error.code === 'historyLimit')
    ) {
      new Notice(t('historyCapacitySkipped', { count: operation.errors.length }));
      return;
    }
    if (operation.files.length || operation.errors.length) {
      if (!this.data.operations.includes(operation)) this.data.operations.unshift(operation);
      this.data.operations.splice(MAX_OPERATIONS);
      if (!(await this.persist()) || this.stopped) return;
      new Notice(
        `Base Path Updater: ${t(operation.errors.length ? 'updateWithErrors' : 'updateComplete', {
          count: operation.files.length,
          errors: operation.errors.length,
        })}`,
      );
    }
  }

  /** Restores matching snapshots for the supplied operation and returns the queued completion promise. */
  undo(operation: Operation): Promise<void> {
    return this.enqueue(async () => {
      if (!this.data.operations.includes(operation)) return;
      for (const entry of operation.files) {
        if (this.stopped) return;
        if (entry.undone) continue;
        try {
          const file = this.app.vault.getAbstractFileByPath(entry.path);
          if (entry.missing || !(file instanceof TFile) || !canUndoFile(file, entry)) {
            throw new PluginError({ code: 'missingBase' });
          }
          let conflict = false;
          await runWrite(this.app, async () => {
            if (this.stopped) return;
            await this.app.vault.process(file, (current) => {
              if (this.stopped) return current;
              const result = applyUndo(current, entry);
              conflict = result.conflict;
              if (result.conflict && result.text === current) {
                throw new PluginError({ code: 'undoConflict' });
              }
              return result.text;
            });
          });
          if (this.stopped) return;
          if (conflict) entry.error = { code: 'undoConflict' };
          else {
            entry.undone = true;
            delete entry.error;
          }
        } catch (error) {
          if (this.stopped) return;
          entry.error = serializeError(error);
        }
        if (!(await this.persist()) || this.stopped) return;
      }
      new Notice(t('undoComplete'));
    });
  }
}

/** Returns whether the live file can still receive the recorded snapshot. */
function canUndoFile(file: TFile, entry: FileChange): boolean {
  if (file.extension === 'base') return true;
  return (
    file.extension === 'md' &&
    (Boolean(entry.regions?.length) ||
      (typeof entry.before === 'string' && typeof entry.after === 'string'))
  );
}

/** Exposes searchable history access, with legacy settings rendering as a fallback. */
class HistorySettingTab extends PluginSettingTab {
  /** Binds the settings tab to the supplied plugin instance. */
  constructor(private updater: BasePathUpdater) {
    super(updater.app, updater);
  }

  /** Returns searchable history metadata and its action for Obsidian 1.13+. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: t('historyName'),
        desc: t('historyDescription'),
        aliases: [...HISTORY_SEARCH_TERMS],
        // Open history only when activated, never during search indexing.
        action: () => this.updater.openHistory(),
      },
    ];
  }

  /** Renders the history button on Obsidian versions older than 1.13. */
  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName(t('historyName'))
      .setDesc(t('historyDescription'))
      .addButton((button) =>
        button.setButtonText(t('historyButton')).onClick(() => this.updater.openHistory()),
      );
  }
}
