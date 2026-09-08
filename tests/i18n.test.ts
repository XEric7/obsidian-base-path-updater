import { afterEach, expect, it, vi } from 'vitest';
import * as obsidian from 'obsidian';
import { formatError, formatOperationError, formatTimestamp, locale, t } from '../src/i18n';
import { readHistory, type HistoryData } from '../src/history';
import { HistoryModal } from '../src/ui';
import type BasePathUpdater from '../src/main';
import type { TestElement } from './obsidian-mock';

afterEach(() => vi.restoreAllMocks());

it.each(['en', 'fr', 'de', '', 'unknown'])(
  'uses English for unsupported app language %s',
  (language) => {
    vi.spyOn(obsidian, 'getLanguage').mockReturnValue(language);
    expect(locale()).toBe('en');
    expect(t('openHistory')).toBe('View update history / undo');
  },
);

it.each(['zh', 'zh-CN', 'zh-TW', 'zh_Hans'])(
  'uses simplified Chinese for app language %s',
  (language) => {
    vi.spyOn(obsidian, 'getLanguage').mockReturnValue(language);
    expect(locale()).toBe('zh-CN');
    expect(t('historyName')).toBe('更新历史');
  },
);

it('translates a persisted error after language changes without rewriting its stored details', () => {
  const language = vi.spyOn(obsidian, 'getLanguage').mockReturnValue('zh');
  const stored = JSON.parse(JSON.stringify({ code: 'historyLimit', params: { limitMiB: 5 } }));
  const snapshot = JSON.stringify(stored);
  expect(formatError(stored)).toBe('本次操作超过 5 MiB 历史容量，未修改此文件');
  language.mockReturnValue('en');
  expect(formatError(stored)).toBe(
    'This operation exceeds the 5 MiB history limit. This file was not modified.',
  );
  expect(JSON.stringify(stored)).toBe(snapshot);
});

it('preserves literal external messages and file paths in either language', () => {
  const message = 'EIO: 目录/$&/{count}/<script>';
  const language = vi.spyOn(obsidian, 'getLanguage');
  for (const value of ['en', 'zh']) {
    language.mockReturnValue(value);
    expect(formatError({ code: 'external', params: { message } })).toBe(message);
    expect(formatOperationError({ path: '目录：x.base', error: { code: 'invalidYaml' } })).toBe(
      `目录：x.base: ${t('invalidYaml')}`,
    );
  }
});

it.each(['en', 'zh'])('formats counts and dates using the %s UI language', (language) => {
  vi.spyOn(obsidian, 'getLanguage').mockReturnValue(language);
  expect(t('updateWithErrors', { count: 2, errors: 3 })).not.toMatch(/\{\w+\}/);
  expect(t('operationErrors', { count: 4 })).toContain('4');
  expect(formatTimestamp(123456789)).toBe(
    new Date(123456789).toLocaleString(language === 'zh' ? 'zh-CN' : 'en'),
  );
});

it('renders migrated errors and status labels in the selected language, and keeps undo functional', async () => {
  const language = vi.spyOn(obsidian, 'getLanguage').mockReturnValue('en');
  const data: HistoryData = readHistory({
    version: 1,
    operations: [
      {
        id: 'legacy',
        timestamp: 123,
        oldPath: 'Old',
        newPath: 'New',
        files: [
          {
            path: '目录/view.base',
            before: 'old',
            after: 'new',
            changes: [{ before: 'Old', after: 'New' }],
            undone: false,
            error: '文件已被后续修改，未覆盖；请先撤回较新的操作或手动检查',
          },
        ],
        errors: ['目录/view.base：Base YAML 无效，已跳过', 'EIO: raw host error'],
      },
    ],
  });
  const undo = vi.fn(async () => {
    data.operations[0]!.files[0]!.undone = true;
  });
  const plugin = { app: {}, data, undo } as unknown as BasePathUpdater;
  const modal = new HistoryModal(plugin);
  modal.onOpen();
  const sink = modal.contentEl as unknown as TestElement;
  expect(sink.texts).toContain('Base update history');
  expect(sink.texts).toContain('目录/view.base · Needs review');
  expect(sink.texts).toContain('目录/view.base: Invalid Base YAML; skipped.');
  expect(sink.texts).toContain('EIO: raw host error');
  expect(sink.texts).toContain(t('undoConflict'));
  const stored = JSON.stringify(data);
  language.mockReturnValue('zh');
  sink.buttons.find((button) => button.text === 'Refresh')!.click();
  expect(sink.texts).toContain('Base 更新历史');
  expect(sink.texts).toContain('目录/view.base · 需要检查');
  expect(sink.texts).toContain('目录/view.base: Base YAML 无效，已跳过');
  expect(JSON.stringify(data)).toBe(stored);
  await sink.buttons.find((button) => button.text === '撤回 Base 修改')!.click();
  expect(undo).toHaveBeenCalledWith(data.operations[0]);
  expect(sink.texts).toContain('目录/view.base · 已撤回');
  expect(sink.buttons.find((button) => button.text === '撤回 Base 修改')!.disabled).toBe(true);
});

it.each(['en', 'zh'])('renders the empty history state in %s', (language) => {
  vi.spyOn(obsidian, 'getLanguage').mockReturnValue(language);
  const modal = new HistoryModal({
    app: {},
    data: { version: 2, operations: [] },
  } as unknown as BasePathUpdater);
  modal.onOpen();
  const sink = modal.contentEl as unknown as TestElement;
  expect(sink.texts).toContain(t('emptyHistory'));
  modal.onClose();
  expect(sink.texts).toEqual([]);
});
