import { Modal, Setting } from 'obsidian';
import type BasePathUpdater from './main';
import { formatError, formatOperationError, formatTimestamp, t } from './i18n';

/** Presents localized history, snapshot changes, and undo controls. */
export class HistoryModal extends Modal {
  /** Binds the modal to the supplied plugin's history and undo actions. */
  constructor(private plugin: BasePathUpdater) {
    super(plugin.app);
  }

  /** Renders the current history when the modal opens. */
  onOpen(): void {
    this.render();
  }

  /** Rebuilds history controls and translates stored failures at display time. */
  private render(): void {
    this.contentEl.empty();
    this.contentEl.addClass('base-path-updater-history');
    this.contentEl.createEl('h2', { text: t('historyTitle') });
    this.contentEl.createEl('p', {
      text: t('historyHelp'),
    });
    new Setting(this.contentEl).addButton((button) =>
      button.setButtonText(t('refresh')).onClick(() => this.render()),
    );
    if (!this.plugin.data.operations.length) {
      this.contentEl.createEl('p', {
        text: t('emptyHistory'),
        cls: 'base-path-updater-muted',
      });
    }
    for (const operation of this.plugin.data.operations) {
      const card = this.contentEl.createDiv({ cls: 'base-path-updater-operation' });
      new Setting(card)
        .setName(`${operation.oldPath} → ${operation.newPath}`)
        .setDesc(formatTimestamp(operation.timestamp))
        .addButton((button) =>
          button
            .setButtonText(t('undoButton'))
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
          text: `${file.path} · ${t(file.undone ? 'undone' : file.error ? 'needsReview' : 'recorded')}`,
        });
        for (const change of file.changes) {
          const line = details.createDiv({ cls: 'base-path-updater-change' });
          line.createEl('code', { text: change.before });
          line.createSpan({ text: ' → ' });
          line.createEl('code', { text: change.after });
        }
        if (file.error)
          details.createEl('p', { text: formatError(file.error), cls: 'base-path-updater-error' });
      }
      if (operation.errors.length) {
        const errors = card.createEl('details');
        errors.createEl('summary', {
          text: t('operationErrors', { count: operation.errors.length }),
        });
        operation.errors.forEach((error) =>
          errors.createEl('p', {
            text: formatOperationError(error),
            cls: 'base-path-updater-error',
          }),
        );
      }
    }
  }

  /** Releases the rendered history elements when the modal closes. */
  onClose(): void {
    this.contentEl.empty();
  }
}
