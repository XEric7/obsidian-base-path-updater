import type { PathChange } from './expressions';
import {
  isRecord,
  isStoredError,
  migrateLegacyError,
  migrateLegacyOperationError,
  PluginError,
  type OperationError,
  type StoredError,
} from './errors';

/** Stores an exact before/after replacement used by undo. */
export interface SnapshotRegion {
  before: string;
  after: string;
}

/** Stores a Base snapshot pair, path changes, and optional structured failure details. */
export interface FileChange {
  path: string;
  before?: string;
  after?: string;
  regions?: SnapshotRegion[];
  changes: PathChange[];
  undone: boolean;
  missing?: boolean;
  error?: StoredError;
}

/** Groups file snapshots and failures for one folder move. */
export interface Operation {
  id: string;
  timestamp: number;
  oldPath: string;
  newPath: string;
  files: FileChange[];
  errors: OperationError[];
}

/** Versioned journal with language-independent failure details. */
export interface HistoryData {
  version: 2;
  operations: Operation[];
}

/** Legacy journal layout, used only after validation during the v1-to-v2 conversion. */
interface LegacyHistoryData {
  version: 1;
  operations: (Omit<Operation, 'errors' | 'files'> & {
    errors: string[];
    files: (Omit<FileChange, 'error'> & { error?: string })[];
  })[];
}

export const MAX_OPERATIONS = 30;
export const MAX_HISTORY_BYTES = 5 * 1024 * 1024;

/** Returns the UTF-8 byte size of the supplied journal's JSON representation. */
export function historySize(data: HistoryData): number {
  return new TextEncoder().encode(JSON.stringify(data)).length;
}

/** Validates a v1/v2 journal and returns a detached v2 copy, preserving snapshots exactly. */
export function readHistory(value: unknown): HistoryData {
  if (value == null) return { version: 2, operations: [] };
  if (
    !isRecord(value) ||
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.operations)
  )
    throw new PluginError({ code: 'historyUnsupported' });
  const data = value;
  for (const operation of value.operations) {
    if (
      !isRecord(operation) ||
      typeof operation.id !== 'string' ||
      typeof operation.timestamp !== 'number' ||
      !Number.isFinite(operation.timestamp) ||
      typeof operation.oldPath !== 'string' ||
      typeof operation.newPath !== 'string' ||
      !Array.isArray(operation.errors) ||
      !operation.errors.every((error) =>
        data.version === 1
          ? typeof error === 'string'
          : isRecord(error) &&
            (error.path === undefined || typeof error.path === 'string') &&
            isStoredError(error.error),
      ) ||
      !Array.isArray(operation.files)
    )
      throw new PluginError({ code: 'historyCorrupt' });
    for (const file of operation.files) {
      if (
        !isRecord(file) ||
        typeof file.path !== 'string' ||
        typeof file.undone !== 'boolean' ||
        (file.missing !== undefined && typeof file.missing !== 'boolean') ||
        (file.error !== undefined &&
          !(data.version === 1 ? typeof file.error === 'string' : isStoredError(file.error))) ||
        !Array.isArray(file.changes) ||
        !file.changes.every(isSnapshotPair) ||
        (file.regions !== undefined &&
          !(Array.isArray(file.regions) && file.regions.every(isSnapshotPair))) ||
        !hasUndoSnapshot(file)
      ) {
        throw new PluginError({ code: 'historyCorrupt' });
      }
    }
  }
  // Migration stays in memory until the next normal journal save succeeds.
  const result = structuredClone(data) as unknown as HistoryData | LegacyHistoryData;
  if (result.version === 2) return result;
  return {
    ...result,
    version: 2,
    operations: result.operations.map((operation) => ({
      ...operation,
      errors: operation.errors.map(migrateLegacyOperationError),
      files: operation.files.map((file) => {
        const { error, ...snapshot } = file;
        return error === undefined ? snapshot : { ...snapshot, error: migrateLegacyError(error) };
      }),
    })),
  };
}

/** Returns whether a journal file entry has a whole-file snapshot or fence regions. */
function hasUndoSnapshot(file: Record<string, unknown>): boolean {
  const wholeFile = typeof file.before === 'string' && typeof file.after === 'string';
  const regions = Array.isArray(file.regions) && file.regions.length > 0;
  return wholeFile || regions;
}

/** Returns whether a value is a before/after text pair rather than an array or primitive. */
function isSnapshotPair(value: unknown): value is SnapshotRegion {
  return isRecord(value) && typeof value.before === 'string' && typeof value.after === 'string';
}

/** Applies a safe undo and reports whether some recorded regions could not be matched. */
export function applyUndo(
  current: string,
  change: FileChange,
): { text: string; conflict: boolean } {
  if (change.regions?.length) return undoRegions(current, change.regions);
  if (current === change.before) return { text: current, conflict: false };
  if (current !== change.after) return { text: current, conflict: true };
  return { text: change.before!, conflict: false };
}

/** Returns the original snapshot only when current text matches a safe undo state; otherwise throws. */
export function undoContent(current: string, change: FileChange): string {
  const result = applyUndo(current, change);
  if (result.conflict && result.text === current) throw new PluginError({ code: 'undoConflict' });
  return result.text;
}

/** Restores matching fence snapshots, leaving unmatched regions in place when others can still undo. */
function undoRegions(
  current: string,
  regions: SnapshotRegion[],
): { text: string; conflict: boolean } {
  let text = current;
  let applied = false;
  let conflict = false;
  const ordered = regions
    .map((region, index) => ({ region, index }))
    .sort((a, b) => b.region.after.length - a.region.after.length || a.index - b.index);
  for (const { region } of ordered) {
    const index = text.indexOf(region.after);
    if (index !== -1) {
      text = text.slice(0, index) + region.before + text.slice(index + region.after.length);
      applied = true;
      continue;
    }
    if (text.includes(region.before)) continue;
    conflict = true;
  }
  if (applied || !conflict) return { text, conflict };
  return { text: current, conflict: true };
}
