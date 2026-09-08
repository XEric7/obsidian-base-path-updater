import { expect, it } from 'vitest';
import { readHistory, undoContent, type FileChange } from '../src/history';
import { migrateLegacyError, serializeError, PluginError } from '../src/errors';

/** Returns a legacy journal with supplied error fields and exact undo snapshots. */
function legacyHistory(error = '文件已被后续修改，未覆盖；请先撤回较新的操作或手动检查') {
  return {
    version: 1,
    operations: [
      {
        id: 'old-operation',
        timestamp: 123,
        oldPath: 'Old',
        newPath: 'New',
        files: [
          { ...change, before: 'old\r\n# 注释', after: 'new\r\n# 注释', missing: true, error },
        ],
        errors: ['目录：a.base：Base YAML 无效，已跳过', 'unrecognized host error: EIO'],
      },
    ],
  };
}

const change: FileChange = {
  path: 'a.base',
  before: 'old',
  after: 'new',
  changes: [],
  undone: false,
};

it('restores a matching snapshot and tolerates an interrupted undo', () => {
  expect(undoContent('new', change)).toBe('old');
  expect(undoContent('old', change)).toBe('old');
});

it('never overwrites subsequent edits', () => {
  expect(() => undoContent('new plus user edits', change)).toThrow('undoConflict');
});

it('validates persisted history before allowing automatic writes', () => {
  expect(readHistory(null)).toEqual({ version: 2, operations: [] });
  expect(() => readHistory({ version: 3, operations: [] })).toThrow();
  expect(() => readHistory({ version: 1, operations: [{}] })).toThrow();
});

it('migrates v1 failures without changing snapshots, flags, or the original journal', () => {
  const input = legacyHistory();
  const original = structuredClone(input);
  const migrated = readHistory(input);
  expect(input).toEqual(original);
  expect(migrated.version).toBe(2);
  const operation = migrated.operations[0]!;
  const file = operation.files[0]!;
  expect(file).toEqual({ ...input.operations[0]!.files[0], error: { code: 'undoConflict' } });
  expect(operation.errors).toEqual([
    { path: '目录：a.base', error: { code: 'invalidYaml' } },
    { error: { code: 'external', params: { message: 'unrecognized host error: EIO' } } },
  ]);
  expect(undoContent(file.after, file)).toBe(file.before);
  expect(() => undoContent(file.after + 'edited', file)).toThrow('undoConflict');
  expect(readHistory(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated);
});

it('preserves unknown legacy text, including prototype-like names', () => {
  for (const message of ['磁盘错误: EIO', 'toString', '__proto__', '']) {
    expect(migrateLegacyError(message)).toEqual({ code: 'external', params: { message } });
    expect(readHistory(legacyHistory(message)).operations[0]!.files[0]!.error).toEqual({
      code: 'external',
      params: { message },
    });
  }
});

it.each([
  ['Base YAML 无效，已跳过', 'invalidYaml'],
  ['更新后的 YAML 校验失败，已跳过', 'updatedYamlInvalid'],
  ['历史记录格式不受支持', 'historyUnsupported'],
  ['历史记录损坏', 'historyCorrupt'],
  ['文件在更新期间发生变化，已跳过', 'concurrentEdit'],
  ['原 Base 已删除或不再是 .base 文件，无法撤回', 'missingBase'],
])('recognizes legacy plugin failure: %s', (message, code) => {
  expect(migrateLegacyError(message)).toEqual({ code });
});

it('stores parameterized plugin failures separately from external messages', () => {
  const detail = { code: 'historyLimit', params: { limitMiB: 5 } } as const;
  expect(migrateLegacyError('本次操作超过 5 MiB 历史容量，未修改此文件')).toEqual(detail);
  expect(serializeError(new PluginError(detail))).toEqual(detail);
  expect(serializeError(new Error('Disk full'))).toEqual({
    code: 'external',
    params: { message: 'Disk full' },
  });
});

it.each([
  null,
  'old text',
  {},
  { code: 'futureError' },
  { code: 'external' },
  { code: 'external', params: { message: 123 } },
  { code: 'historyLimit', params: { limitMiB: '5' } },
  { code: 'historyLimit', params: { limitMiB: -1 } },
  { code: 'invalidYaml', params: [] },
])('rejects malformed v2 error details: %j', (error) => {
  const data = readHistory(legacyHistory()) as unknown as ReturnType<typeof legacyHistory>;
  data.operations[0]!.files[0]!.error = error as never;
  expect(() => readHistory(data)).toThrow('historyCorrupt');
});

it('rejects corrupt operation errors and null entries before migration', () => {
  const data = readHistory(legacyHistory());
  expect(() => readHistory({ ...data, operations: [null] })).toThrow('historyCorrupt');
  const operation = data.operations[0]!;
  expect(() => readHistory({ ...data, operations: [{ ...operation, files: [null] }] })).toThrow(
    'historyCorrupt',
  );
  expect(() =>
    readHistory({
      ...data,
      operations: [{ ...operation, errors: [{ path: 4, error: { code: 'invalidYaml' } }] }],
    }),
  ).toThrow('historyCorrupt');
});
