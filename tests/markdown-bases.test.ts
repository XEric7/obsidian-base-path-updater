import { describe, expect, it } from 'vitest';
import { findBaseFences, mayContainBaseFence, updateMarkdownBases } from '../src/markdown-bases';

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
});
