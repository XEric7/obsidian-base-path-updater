/** Language-independent plugin failures that do not need interpolation parameters. */
const SIMPLE_CODES = [
  'invalidYaml',
  'updatedYamlInvalid',
  'historyUnsupported',
  'historyCorrupt',
  'undoConflict',
  'concurrentEdit',
  'missingBase',
] as const;

/** Serializable failure details; external messages remain verbatim. */
export type StoredError =
  | { code: (typeof SIMPLE_CODES)[number] }
  | { code: 'historyLimit'; params: { limitMiB: number } }
  | { code: 'external'; params: { message: string } };

/** Associates an operation failure with its event-time path, when known. */
export interface OperationError {
  path?: string;
  error: StoredError;
}

/** Carries serializable failure details through exception-based control flow. */
export class PluginError extends Error {
  /** Stores the supplied failure details and uses its stable code as the message. */
  constructor(public readonly detail: StoredError) {
    super(detail.code);
    this.name = 'PluginError';
  }
}

/** Returns whether an unknown value is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates persisted failure codes and their required parameter types. */
export function isStoredError(value: unknown): value is StoredError {
  if (!isRecord(value)) return false;
  if (value.code === 'external')
    return isRecord(value.params) && typeof value.params.message === 'string';
  if (value.code === 'historyLimit')
    return (
      isRecord(value.params) &&
      typeof value.params.limitMiB === 'number' &&
      Number.isFinite(value.params.limitMiB) &&
      value.params.limitMiB > 0
    );
  return SIMPLE_CODES.some((code) => code === value.code) && value.params === undefined;
}

/** Converts a caught exception to structured plugin details or an unchanged external message. */
export function serializeError(error: unknown): StoredError {
  return error instanceof PluginError
    ? error.detail
    : {
        code: 'external',
        params: { message: error instanceof Error ? error.message : String(error) },
      };
}

// Exact v1 messages only: never guess translations for arbitrary external errors.
const LEGACY_ERRORS: Record<string, StoredError> = {
  'Base YAML 无效，已跳过': { code: 'invalidYaml' },
  '更新后的 YAML 校验失败，已跳过': { code: 'updatedYamlInvalid' },
  历史记录格式不受支持: { code: 'historyUnsupported' },
  历史记录损坏: { code: 'historyCorrupt' },
  '文件已被后续修改，未覆盖；请先撤回较新的操作或手动检查': { code: 'undoConflict' },
  '文件在更新期间发生变化，已跳过': { code: 'concurrentEdit' },
  '原 Base 已删除或不再是 .base 文件，无法撤回': { code: 'missingBase' },
  '本次操作超过 5 MiB 历史容量，未修改此文件': { code: 'historyLimit', params: { limitMiB: 5 } },
};

/** Converts an exact v1 error string, preserving unknown messages as external details. */
export function migrateLegacyError(message: string): StoredError {
  return Object.hasOwn(LEGACY_ERRORS, message)
    ? structuredClone(LEGACY_ERRORS[message]!)
    : { code: 'external', params: { message } };
}

/** Separates a v1 operation path from a known error suffix; preserves ambiguous text verbatim. */
export function migrateLegacyOperationError(message: string): OperationError {
  for (const [text, error] of Object.entries(LEGACY_ERRORS)) {
    const suffix = `：${text}`;
    if (message.endsWith(suffix))
      return { path: message.slice(0, -suffix.length), error: structuredClone(error) };
  }
  return { error: migrateLegacyError(message) };
}
