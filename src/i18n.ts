import { getLanguage } from 'obsidian';
import type { OperationError, StoredError } from './errors';

const en = {
  openHistory: 'View update history / undo',
  historyName: 'Update history',
  historyDescription:
    'Review path changes and undo them. Keeps up to 30 operations and about 5 MiB of snapshots.',
  historyButton: 'View history / undo',
  historyTitle: 'Base update history',
  historyHelp:
    'Undo restores Base content only; it does not move folders. Files with later edits are skipped with an explanation. Undo consecutive operations from newest to oldest.',
  refresh: 'Refresh',
  emptyHistory:
    'No updates yet. Records appear after you move or rename a folder referenced by a Base.',
  undoButton: 'Undo Base changes',
  undone: 'Undone',
  needsReview: 'Needs review',
  recorded: 'Recorded',
  operationErrors: 'Errors during processing ({count})',
  loadFailed: 'Could not read history. Automatic updates are paused.',
  operationFailed: 'Operation incomplete. Check the history and console for details.',
  saveFailed:
    'Could not save history. Further updates are paused. Check storage and re-enable the plugin.',
  updateComplete: 'Processed {count} Base file(s). Review or undo changes in update history.',
  updateWithErrors:
    'Processed {count} Base file(s), with {errors} error(s). Review or undo changes in update history.',
  undoComplete:
    'Undo check complete. Conflicting or missing files were left unchanged. See history for details.',
  invalidYaml: 'Invalid Base YAML; skipped.',
  updatedYamlInvalid: 'Updated YAML failed validation; skipped.',
  historyUnsupported: 'Unsupported history format.',
  historyCorrupt: 'History data is corrupted.',
  undoConflict:
    'The file has later edits and was not overwritten. Undo newer operations first or inspect it manually.',
  concurrentEdit: 'The file changed during the update; skipped.',
  missingBase: 'The original Base was deleted or is no longer a .base file; cannot undo.',
  historyLimit:
    'This operation exceeds the {limitMiB} MiB history limit. This file was not modified.',
  historyCapacitySkipped:
    'Skipped {count} Base file(s): their snapshots exceed the history limit. Existing undo history was kept.',
  external: '{message}',
};

/** Keys shared by all supported UI and error translations. */
export type MessageKey = keyof typeof en;

const zh: Record<MessageKey, string> = {
  openHistory: '查看更新历史 / 撤回',
  historyName: '更新历史',
  historyDescription: '查看路径变化并撤回。最多保留最近 30 次操作，快照容量约 5 MiB。',
  historyButton: '查看历史 / 撤回',
  historyTitle: 'Base 更新历史',
  historyHelp:
    '撤回只恢复 Base 内容，不移动文件夹。文件如有后续修改，会跳过并说明原因。连续操作请从最新一条开始撤回。',
  refresh: '刷新',
  emptyHistory: '暂无更新记录。移动或重命名被 Base 引用的文件夹后，记录会出现在这里。',
  undoButton: '撤回 Base 修改',
  undone: '已撤回',
  needsReview: '需要检查',
  recorded: '已记录',
  operationErrors: '处理时的异常（{count}）',
  loadFailed: '无法读取历史，自动更新已暂停',
  operationFailed: '操作未完成，请查看历史记录及控制台',
  saveFailed: '历史保存失败，后续自动更新已暂停；请检查存储后重新启用插件',
  updateComplete: '处理 {count} 个 Base。可在更新历史中查看 / 撤回。',
  updateWithErrors: '处理 {count} 个 Base，{errors} 项异常。可在更新历史中查看 / 撤回。',
  undoComplete: '撤回检查完成。冲突或缺失的文件会保留原样，请查看历史详情。',
  invalidYaml: 'Base YAML 无效，已跳过',
  updatedYamlInvalid: '更新后的 YAML 校验失败，已跳过',
  historyUnsupported: '历史记录格式不受支持',
  historyCorrupt: '历史记录损坏',
  undoConflict: '文件已被后续修改，未覆盖；请先撤回较新的操作或手动检查',
  concurrentEdit: '文件在更新期间发生变化，已跳过',
  missingBase: '原 Base 已删除或不再是 .base 文件，无法撤回',
  historyLimit: '本次操作超过 {limitMiB} MiB 历史容量，未修改此文件',
  historyCapacitySkipped: '已跳过 {count} 个 Base：快照超过历史容量限制。已有撤回历史保持不变。',
  external: '{message}',
};

export const HISTORY_SEARCH_TERMS = ['history', 'undo', '更新历史', '撤回', 'Base Path Updater'];

/** Returns the supported locale for the current Obsidian language, defaulting to English. */
export function locale(): 'zh-CN' | 'en' {
  return /^zh(?:[-_]|$)/i.test(getLanguage()) ? 'zh-CN' : 'en';
}

/** Translates a message key and interpolates the supplied literal string or number parameters. */
export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const message = (locale() === 'zh-CN' ? zh : en)[key];
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

/** Formats stored failure details in the current UI language without mutating history. */
export function formatError(error: StoredError): string {
  return t(error.code, 'params' in error ? error.params : {});
}

/** Formats an operation failure with its unchanged path, when one was recorded. */
export function formatOperationError(entry: OperationError): string {
  const message = formatError(entry.error);
  return entry.path === undefined ? message : `${entry.path}: ${message}`;
}

/** Formats a stored timestamp using the UI locale and the user's local time zone. */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(locale());
}
