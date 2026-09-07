import type { PathChange } from './expressions';

export interface FileChange {
  path: string;
  before: string;
  after: string;
  changes: PathChange[];
  undone: boolean;
  missing?: boolean;
  error?: string;
}

export interface Operation {
  id: string;
  timestamp: number;
  oldPath: string;
  newPath: string;
  files: FileChange[];
  errors: string[];
}

export interface HistoryData {
  version: 1;
  operations: Operation[];
}

export const MAX_OPERATIONS = 30;
export const MAX_HISTORY_BYTES = 5 * 1024 * 1024;

export function historySize(data: HistoryData): number {
  return new TextEncoder().encode(JSON.stringify(data)).length;
}

// Do not silently overwrite an unrecognized or corrupted journal.
export function readHistory(value: unknown): HistoryData {
  if (value == null) return { version: 1, operations: [] };
  const data = value as HistoryData;
  if (data.version !== 1 || !Array.isArray(data.operations))
    throw new Error('历史记录格式不受支持');
  for (const operation of data.operations) {
    if (
      typeof operation.id !== 'string' ||
      typeof operation.timestamp !== 'number' ||
      typeof operation.oldPath !== 'string' ||
      typeof operation.newPath !== 'string' ||
      !Array.isArray(operation.errors) ||
      !operation.errors.every((error) => typeof error === 'string') ||
      !Array.isArray(operation.files)
    )
      throw new Error('历史记录损坏');
    for (const file of operation.files) {
      if (
        typeof file.path !== 'string' ||
        typeof file.before !== 'string' ||
        typeof file.after !== 'string' ||
        typeof file.undone !== 'boolean' ||
        !Array.isArray(file.changes) ||
        !file.changes.every(
          (change) => typeof change?.before === 'string' && typeof change?.after === 'string',
        )
      ) {
        throw new Error('历史记录损坏');
      }
    }
  }
  return data;
}

export function undoContent(current: string, change: FileChange): string {
  if (current === change.before) return current;
  if (current !== change.after)
    throw new Error('文件已被后续修改，未覆盖；请先撤回较新的操作或手动检查');
  return change.before;
}
