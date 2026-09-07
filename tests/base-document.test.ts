import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { updateBase } from '../src/base-document';
import { movePath, updateExpression } from '../src/expressions';

describe('path expressions', () => {
  it('skips malformed hexadecimal escapes', () => {
    const expression = 'file.inFolder("Old/\\uZZZZ")';
    expect(updateExpression(expression, 'Old', 'New').text).toBe(expression);
  });

  it.each([
    ['file.inFolder("Work/Research")', 'file.inFolder("Archive/Research")'],
    ["file.inFolder('Work/Research/Sub')", "file.inFolder('Archive/Research/Sub')"],
    ['file.path == "Work/Research/note.md"', 'file.path == "Archive/Research/note.md"'],
    ['"Work/Research/note.md" == file.path', '"Archive/Research/note.md" == file.path'],
    ['file.path.startsWith("Work/Research/")', 'file.path.startsWith("Archive/Research/")'],
    [
      '!file.inFolder("Work/Research") && file.path == "Work/Research/a.md"',
      '!file.inFolder("Archive/Research") && file.path == "Archive/Research/a.md"',
    ],
    ['file.inFolder("Work\\u002fResearch")', 'file.inFolder("Archive/Research")'],
  ])('updates %s', (input, expected) => {
    expect(updateExpression(input, 'Work/Research', 'Archive/Research').text).toBe(expected);
  });

  it.each([
    'file.inFolder("Work/Researcher")',
    'this.file.inFolder("Work/Research")',
    'myfile.inFolder("Work/Research")',
    'note.file.path == "Work/Research"',
    '"file.inFolder(\\"Work/Research\\")"',
    'note.path == "Work/Research"',
    'file.inFolder("Work/Research" + suffix)',
    'file.path == "Work/Research" + suffix',
    'file.path == "Work/Research".lower()',
    'prefix + file.path == "Work/Research"',
    'file.path.contains("Work/Research")',
    'file.inFolder(folder)',
    'file.path.replace(/file.inFolder("Work/Research")/, "x")',
  ])('leaves ambiguous or unrelated expression unchanged: %s', (input) => {
    expect(updateExpression(input, 'Work/Research', 'Archive').text).toBe(input);
  });

  it('handles quote characters, unicode and dollar signs as literal paths', () => {
    const result = updateExpression("file.inFolder('旧目录')", '旧目录', "New/O'Brien/$&");
    expect(result.text).toBe("file.inFolder('New/O\\'Brien/$&')");
    expect(movePath('Work2/a', 'Work', 'New')).toBe('Work2/a');
  });
});

describe('Base YAML', () => {
  it('updates global filters, nested view filters and formulas only', () => {
    const source = `# Work/Research\nfilters:\n  and:\n    - file.inFolder("Work/Research") # keep\n    - or:\n      - file.path == "Work/Research/a.md"\nformulas:\n  location: 'if(file.inFolder("Work/Research"), "yes", "no")'\nproperties:\n  title:\n    displayName: 'file.inFolder("Work/Research")'\nviews:\n  - type: table\n    name: Work/Research\n    filters: 'file.path.startsWith("Work/Research/")'\n`;
    const result = updateBase(source, 'Work/Research', 'Archive');
    const base = parse(result.text);
    expect(result.changes).toHaveLength(4);
    expect(base.filters.and[0]).toBe('file.inFolder("Archive")');
    expect(base.properties.title.displayName).toBe('file.inFolder("Work/Research")');
    expect(base.views[0].name).toBe('Work/Research');
    expect(result.text).toContain('# Work/Research');
    expect(result.text).toContain('# keep');
  });

  it.each(['|', '>-', '|+'])('preserves valid block YAML and header comments: %s', (style) => {
    const source = `filters: ${style} # explanation\r\n  file.inFolder("Old")\r\nviews: []\r\n`;
    const result = updateBase(source, 'Old', 'New');
    expect(parse(result.text).filters.trim()).toBe('file.inFolder("New")');
    expect(result.text).toContain('# explanation');
    expect(result.text).toContain('views: []\r\n');
  });

  it('handles flow YAML and escaped YAML paths', () => {
    const source = 'filters: {and: ["file.inFolder(\\"Old\\")"]}\n';
    expect(parse(updateBase(source, 'Old', 'New').text).filters.and[0]).toBe(
      'file.inFolder("New")',
    );
    const escaped = 'filters: "file.inFolder(\\"\\u004fld\\")"';
    expect(parse(updateBase(escaped, 'Old', 'New').text).filters).toBe('file.inFolder("New")');
  });

  it('does not mutate anchors shared with other fields', () => {
    const source = 'filters: &shared file.inFolder("Old")\nname: *shared\n';
    expect(updateBase(source, 'Old', 'New').text).toBe(source);
  });

  it('rejects invalid YAML and keeps no-match files byte-identical', () => {
    expect(() => updateBase('filters: [Old', 'Old', 'New')).toThrow();
    const source = '# Old\r\nfilters: file.hasTag("Old")\r\n';
    expect(updateBase(source, 'Old', 'New').text).toBe(source);
  });
});
