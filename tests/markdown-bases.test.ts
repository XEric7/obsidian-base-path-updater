import { describe, expect, it } from 'vitest';
import { findBaseFences, mayContainBaseFence, updateMarkdownBases } from '../src/markdown-bases';
import { undoContent } from '../src/history';

const note = (body: string, marker = '```') =>
  `# Heading\n\n${marker}base\n${body}\n${marker}\n\nTrailing text.\n`;

describe('Markdown base fences', () => {
  it('detects backtick and tilde fences and ignores similar info strings', () => {
    expect(mayContainBaseFence('```base\nfilters: x\n```')).toBe(true);
    expect(mayContainBaseFence('~~~base\nfilters: x\n~~~')).toBe(true);
    expect(mayContainBaseFence('```BASE\nfilters: x\n```')).toBe(true);
    expect(mayContainBaseFence('```base64\nfilters: x\n```')).toBe(false);
    expect(mayContainBaseFence('Use a base file instead.')).toBe(false);
  });

  it('updates a fenced Base and leaves surrounding Markdown unchanged', () => {
    const source = note('filters: file.inFolder("Old")');
    const result = updateMarkdownBases(source, 'Old', 'New');
    expect(result.changes).toEqual([{ before: 'Old', after: 'New' }]);
    expect(result.text).toContain('# Heading');
    expect(result.text).toContain('Trailing text.');
    expect(result.text).toContain('inFolder(\\"New\\")');
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]!.before).toContain('Old');
    expect(result.regions[0]!.after).toContain('New');
    expect(result.regions[0]!.before.startsWith('```base')).toBe(true);
  });

  it('updates tilde fences and indented fences', () => {
    const tilde = updateMarkdownBases(
      'Intro\n~~~base\nfilters: file.inFolder("Old")\n~~~\n',
      'Old',
      'New',
    );
    expect(tilde.text).toContain('inFolder(\\"New\\")');
    const indented = updateMarkdownBases(
      '1. item\n   ```base\n   filters: file.inFolder("Old")\n   ```\n',
      'Old',
      'New',
    );
    expect(indented.text).toContain('inFolder(\\"New\\")');
    expect(indented.regions[0]!.after.startsWith('   ```base')).toBe(true);
  });

  it('skips examples wrapped in a longer outer fence', () => {
    const source = '````markdown\n```base\nfilters: file.inFolder("Old")\n```\n````\n';
    const result = updateMarkdownBases(source, 'Old', 'New');
    expect(result.changes).toHaveLength(0);
    expect(result.text).toBe(source);
    expect(findBaseFences(source)).toHaveLength(0);
  });

  it('updates one fence when another fence in the same note has invalid YAML', () => {
    const source = [
      '```base\nfilters: file.inFolder("Old")\n```',
      '```base\nfilters: [Old\n```',
    ].join('\n\n');
    const result = updateMarkdownBases(source, 'Old', 'New');
    expect(result.changes).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe('invalidYaml');
    expect(result.text).toContain('inFolder(\\"New\\")');
    expect(result.text).toContain('filters: [Old');
  });

  it('preserves CRLF around an updated fence', () => {
    const source = 'Note\r\n```base\r\nfilters: file.inFolder("Old")\r\n```\r\n';
    const result = updateMarkdownBases(source, 'Old', 'New');
    expect(result.text).toContain('\r\n```base\r\n');
    expect(result.text).toContain('inFolder(\\"New\\")');
  });

  it('does not rewrite notes that only mention the old path outside a Base fence', () => {
    const source = 'Old path lives here.\n```js\nfile.inFolder("Old")\n```\n';
    expect(updateMarkdownBases(source, 'Old', 'New').text).toBe(source);
  });

  it('does not rewrite a Base fence inside an HTML comment or raw HTML block', () => {
    const commented = '<!--\n```base\nfilters: file.inFolder("Old")\n```\n-->\n';
    const script = '<script>\n```base\nfilters: file.inFolder("Old")\n```\n</script>\n';
    const active = '```base\nfilters: file.inFolder("Old")\n```\n';
    expect(updateMarkdownBases(commented + '\n' + active, 'Old', 'New').text).toBe(
      commented + '\n```base\nfilters: "file.inFolder(\\"New\\")"\n```\n',
    );
    expect(updateMarkdownBases(script, 'Old', 'New').text).toBe(script);
    expect(findBaseFences(commented)).toHaveLength(0);
  });

  it('restores the fence that changed when another fence already has the new text', () => {
    const source = [
      '```base',
      'filters: file.inFolder("New")',
      '```',
      '',
      '```base',
      'filters: file.inFolder("Old")',
      '```',
      '',
    ].join('\n');
    const updated = updateMarkdownBases(source, 'Old', 'New');
    expect(updated.regions).toHaveLength(1);
    expect(updated.regions[0]!.prefix).toBeTruthy();
    const restored = undoContent(updated.text, {
      path: 'note.md',
      regions: updated.regions,
      changes: updated.changes,
      undone: false,
    });
    expect(restored).toBe(source);
  });
});
