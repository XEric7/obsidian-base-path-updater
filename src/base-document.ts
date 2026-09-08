import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { updateExpression, type PathChange } from './expressions';
import { PluginError } from './errors';

/** Contains updated YAML text and the path changes applied to its expressions. */
export interface BaseUpdate {
  text: string;
  changes: PathChange[];
}

/** Rewrites supported references from oldPath to newPath in source YAML and returns text plus changes. */
export function updateBase(source: string, oldPath: string, newPath: string): BaseUpdate {
  // Escaped paths may not appear literally in the source; do not reject those.
  if (!source.includes(oldPath) && !source.includes('\\')) return { text: source, changes: [] };
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) throw new PluginError({ code: 'invalidYaml' });
  const edits: { start: number; end: number; value: string }[] = [];
  const changes: PathChange[] = [];
  const visited = new Set<unknown>();

  /** Adds edits for a supported scalar node, leaving unrelated or shared nodes untouched. */
  const expression = (node: unknown) => {
    if (
      !isScalar(node) ||
      typeof node.value !== 'string' ||
      !node.range ||
      node.anchor ||
      node.tag ||
      visited.has(node)
    )
      return;
    visited.add(node);
    const result = updateExpression(node.value, oldPath, newPath);
    if (!result.changes.length) return;
    const [start, end] = node.range;
    // Replace only the scalar span. Unrelated YAML, comments and CRLF stay intact.
    const original = source.slice(start, end);
    const newline = original.endsWith('\r\n') ? '\r\n' : original.endsWith('\n') ? '\n' : '';
    // Block scalar headers can carry comments: preserve them on the new scalar.
    const headerComment = /^[>|][^\r\n]*?(\s+#.*)/.exec(original)?.[1] ?? '';
    edits.push({ start, end, value: JSON.stringify(result.text) + headerComment + newline });
    changes.push(...result.changes);
  };
  /** Visits an unknown filter node and collects edits from supported logical branches. */
  const filters = (node: unknown) => {
    if (isScalar(node)) expression(node);
    else if (isSeq(node)) node.items.forEach(filters);
    else if (isMap(node)) {
      for (const key of ['and', 'or', 'not']) filters(node.get(key, true));
    }
  };
  const root = document.contents;
  if (isMap(root)) {
    filters(root.get('filters', true));
    const formulas = root.get('formulas', true);
    if (isMap(formulas)) formulas.items.forEach((pair) => expression(pair.value));
    const views = root.get('views', true);
    if (isSeq(views)) {
      views.items.forEach((view) => {
        if (isMap(view)) filters(view.get('filters', true));
      });
    }
  }
  let text = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  }
  if (edits.length && parseDocument(text).errors.length)
    throw new PluginError({ code: 'updatedYamlInvalid' });
  return { text, changes };
}
