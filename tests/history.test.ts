import { expect, it } from 'vitest';
import { readHistory, undoContent, type FileChange } from '../src/history';

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
  expect(() => undoContent('new plus user edits', change)).toThrow('后续修改');
});

it('validates persisted history before allowing automatic writes', () => {
  expect(readHistory(null)).toEqual({ version: 1, operations: [] });
  expect(() => readHistory({ version: 2, operations: [] })).toThrow();
  expect(() => readHistory({ version: 1, operations: [{}] })).toThrow();
});
