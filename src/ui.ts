import { Modal, Setting } from 'obsidian';
import type BasePathUpdater from './main';

export class HistoryModal extends Modal {
  constructor(private plugin: BasePathUpdater) {
    super(plugin.app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    this.contentEl.addClass('base-path-updater-history');
    this.contentEl.createEl('h2', { text: 'Base 更新历史' });
    this.contentEl.createEl('p', {
      text: '撤回只恢复 Base 内容，不移动文件夹。文件如有后续修改，会跳过并说明原因。连续操作请从最新一条开始撤回。',
    });
    new Setting(this.contentEl).addButton((button) =>
      button.setButtonText('刷新').onClick(() => this.render()),
    );
    if (!this.plugin.data.operations.length) {
      this.contentEl.createEl('p', {
        text: '暂无更新记录。移动或重命名被 Base 引用的文件夹后，记录会出现在这里。',
        cls: 'base-path-updater-muted',
      });
    }
    for (const operation of this.plugin.data.operations) {
      const card = this.contentEl.createDiv({ cls: 'base-path-updater-operation' });
      new Setting(card)
        .setName(`${operation.oldPath} → ${operation.newPath}`)
        .setDesc(new Date(operation.timestamp).toLocaleString())
        .addButton((button) =>
          button
            .setButtonText('撤回 Base 修改')
            .setDisabled(!operation.files.some((file) => !file.undone))
            .onClick(async () => {
              button.setDisabled(true);
              await this.plugin.undo(operation);
              this.render();
            }),
        );
      for (const file of operation.files) {
        const details = card.createEl('details');
        details.createEl('summary', {
          text: `${file.path}${file.undone ? ' · 已撤回' : file.error ? ' · 需要检查' : ' · 已记录'}`,
        });
        for (const change of file.changes) {
          const line = details.createDiv({ cls: 'base-path-updater-change' });
          line.createEl('code', { text: change.before });
          line.createSpan({ text: ' → ' });
          line.createEl('code', { text: change.after });
        }
        if (file.error) details.createEl('p', { text: file.error, cls: 'base-path-updater-error' });
      }
      if (operation.errors.length) {
        const errors = card.createEl('details');
        errors.createEl('summary', { text: `处理时的异常（${operation.errors.length}）` });
        operation.errors.forEach((error) =>
          errors.createEl('p', { text: error, cls: 'base-path-updater-error' }),
        );
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
