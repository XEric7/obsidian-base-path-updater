import { Menu, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder } from 'obsidian';
import { updateBase } from './base-document';
import { movePath } from './expressions';
import {
  historySize,
  MAX_HISTORY_BYTES,
  MAX_OPERATIONS,
  readHistory,
  undoContent,
  type FileChange,
  type HistoryData,
  type Operation,
} from './history';
import { HistoryModal } from './ui';

export default class BasePathUpdater extends Plugin {
  data: HistoryData = { version: 1, operations: [] };
  private bases = new Set<TFile>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  private ready = false;
  private storageFailed = false;

  async onload(): Promise<void> {
    try {
      this.data = readHistory(await this.loadData());
    } catch (error) {
      this.storageFailed = true;
      this.report('无法读取历史，自动更新已暂停', error);
    }
    this.addRibbonIcon('folder-sync', 'Base Path Updater', (event) => {
      new Menu()
        .addItem((item) =>
          item
            .setTitle('查看更新历史 / 撤回')
            .setIcon('history')
            .onClick(() => this.openHistory()),
        )
        .showAtMouseEvent(event);
    });
    this.addCommand({
      id: 'open-history',
      name: '查看更新历史 / 撤回',
      callback: () => this.openHistory(),
    });
    this.addSettingTab(new HistorySettingTab(this));
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (this.ready && file instanceof TFile && file.extension === 'base') this.bases.add(file);
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
          else this.bases.delete(file);
        }
        if (!this.ready) return;
        const folder = file instanceof TFolder;
        // Capture the event-time list, but retain TFile identities through subsequent moves.
        const candidates = [...this.bases];
        void this.enqueue(async () => {
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
          if (folder) await this.updateFolder(oldPath, newPath, candidates);
        });
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      this.bases = new Set(this.app.vault.getFiles().filter((file) => file.extension === 'base'));
      this.ready = true;
    });
  }

  onunload(): void {
    this.stopped = true;
    this.bases.clear();
  }

  openHistory(): void {
    new HistoryModal(this).open();
  }

  private report(message: string, error: unknown): void {
    console.error(`[Base Path Updater] ${message}`, error);
    new Notice(`Base Path Updater：${message}`);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (!this.stopped && !this.storageFailed) await task();
      })
      .catch((error) => this.report('操作未完成，请查看历史记录及控制台', error));
    return this.queue;
  }

  private async persist(): Promise<void> {
    try {
      await this.saveData(this.data);
    } catch (error) {
      this.storageFailed = true;
      this.report('历史保存失败，后续自动更新已暂停；请检查存储后重新启用插件', error);
      throw error;
    }
  }

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
      if (file.extension !== 'base' || this.app.vault.getAbstractFileByPath(file.path) !== file)
        continue;
      let entry: FileChange | undefined;
      try {
        const before = await this.app.vault.read(file);
        const update = updateBase(before, oldPath, newPath);
        if (!update.changes.length) continue;
        if (!this.data.operations.includes(operation)) {
          this.data.operations.unshift(operation);
          this.data.operations.splice(MAX_OPERATIONS);
        }
        entry = {
          path: file.path,
          before,
          after: update.text,
          changes: update.changes,
          undone: false,
        };
        operation.files.push(entry);
        // Keep the active operation intact. Refuse a write that cannot be journaled.
        while (historySize(this.data) > MAX_HISTORY_BYTES && this.data.operations.length > 1) {
          this.data.operations.pop();
        }
        if (historySize(this.data) > MAX_HISTORY_BYTES) {
          operation.files.pop();
          entry = undefined;
          throw new Error('本次操作超过 5 MiB 历史容量，未修改此文件');
        }
        // Write-ahead snapshot survives a crash between the vault write and status save.
        await this.persist();
        if (this.stopped) break;
        await this.app.vault.process(file, (current) => {
          if (current !== before) throw new Error('文件在更新期间发生变化，已跳过');
          return update.text;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (entry) entry.error = message;
        operation.errors.push(`${file.path}：${message}`);
      }
    }
    if (this.storageFailed) return;
    if (operation.files.length || operation.errors.length) {
      if (!this.data.operations.includes(operation)) this.data.operations.unshift(operation);
      this.data.operations.splice(MAX_OPERATIONS);
      await this.persist();
      new Notice(
        `Base Path Updater：处理 ${operation.files.length} 个 Base${operation.errors.length ? `，${operation.errors.length} 项异常` : ''}。可在更新历史中查看 / 撤回。`,
      );
    }
  }

  undo(operation: Operation): Promise<void> {
    return this.enqueue(async () => {
      if (!this.data.operations.includes(operation)) return;
      for (const entry of operation.files) {
        if (this.stopped || entry.undone) continue;
        try {
          const file = this.app.vault.getAbstractFileByPath(entry.path);
          if (entry.missing || !(file instanceof TFile) || file.extension !== 'base') {
            throw new Error('原 Base 已删除或不再是 .base 文件，无法撤回');
          }
          await this.app.vault.process(file, (current) => undoContent(current, entry));
          entry.undone = true;
          delete entry.error;
        } catch (error) {
          entry.error = error instanceof Error ? error.message : String(error);
        }
        await this.persist();
      }
      new Notice('撤回检查完成。冲突或缺失的文件会保留原样，请查看历史详情。');
    });
  }
}

class HistorySettingTab extends PluginSettingTab {
  constructor(private updater: BasePathUpdater) {
    super(updater.app, updater);
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName('更新历史')
      .setDesc('查看路径变化并撤回。最多保留最近 30 次操作，快照容量约 5 MiB。')
      .addButton((button) =>
        button.setButtonText('查看历史 / 撤回').onClick(() => this.updater.openHistory()),
      );
  }
}
