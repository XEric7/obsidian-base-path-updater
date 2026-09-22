import { updateBase, type BaseUpdate } from './base-document';
import type { StoredError } from './errors';
import { serializeError } from './errors';
import type { SnapshotRegion } from './history';

/** Cheap probe used to maintain the Markdown Base index without parsing YAML. */
export function mayContainBaseFence(source: string): boolean {
  return /(?:^|[\r\n]) {0,3}(?:`{3,}|~{3,})[ \t]*base(?:[ \t\r\n]|$)/i.test(source);
}

/** Updated Markdown text, path changes, fence snapshots, and per-fence failures. */
export interface MarkdownBaseUpdate extends BaseUpdate {
  regions: SnapshotRegion[];
  errors: StoredError[];
}

interface Line {
  start: number;
  end: number;
  content: string;
}

interface OpenFence {
  start: number;
  bodyStart: number;
  marker: string;
  base: boolean;
}

/** Rewrites supported path references inside Markdown `base` fences and returns spliced text. */
export function updateMarkdownBases(
  source: string,
  oldPath: string,
  newPath: string,
): MarkdownBaseUpdate {
  if (!mayContainBaseFence(source)) return { text: source, changes: [], regions: [], errors: [] };
  if (!source.includes(oldPath) && !source.includes('\\')) {
    return { text: source, changes: [], regions: [], errors: [] };
  }
  const fences = findBaseFences(source);
  const edits: { start: number; end: number; value: string; region: SnapshotRegion }[] = [];
  const changes: BaseUpdate['changes'] = [];
  const errors: StoredError[] = [];
  for (const fence of fences) {
    const body = source.slice(fence.bodyStart, fence.bodyEnd);
    try {
      const result = updateBase(body, oldPath, newPath);
      if (!result.changes.length) continue;
      const before = source.slice(fence.start, fence.end);
      const after =
        source.slice(fence.start, fence.bodyStart) +
        result.text +
        source.slice(fence.bodyEnd, fence.end);
      edits.push({ start: fence.start, end: fence.end, value: after, region: { before, after } });
      changes.push(...result.changes);
    } catch (error) {
      errors.push(serializeError(error));
    }
  }
  let text = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  }
  return {
    text,
    changes,
    regions: edits
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((edit) => edit.region),
    errors,
  };
}

/** Locates complete `base` fences, skipping examples wrapped in a longer outer fence. */
export function findBaseFences(
  source: string,
): { start: number; bodyStart: number; bodyEnd: number; end: number }[] {
  const fences: { start: number; bodyStart: number; bodyEnd: number; end: number }[] = [];
  let open: OpenFence | undefined;
  for (const line of iterateLines(source)) {
    if (!open) {
      const opening = openingFence(line.content);
      if (!opening) continue;
      open = {
        start: line.start,
        bodyStart: line.end,
        marker: opening.marker,
        base: opening.language.toLowerCase() === 'base',
      };
      continue;
    }
    if (!isClosingFence(line.content, open.marker)) continue;
    if (open.base) {
      fences.push({
        start: open.start,
        bodyStart: open.bodyStart,
        bodyEnd: line.start,
        end: line.end,
      });
    }
    open = undefined;
  }
  if (open?.base) {
    fences.push({
      start: open.start,
      bodyStart: open.bodyStart,
      bodyEnd: source.length,
      end: source.length,
    });
  }
  return fences;
}

function iterateLines(source: string): Line[] {
  const lines: Line[] = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index++;
    const content = source.slice(start, index);
    if (source[index] === '\r' && source[index + 1] === '\n') index += 2;
    else if (index < source.length) index += 1;
    lines.push({ start, end: index, content });
  }
  return lines;
}

function openingFence(line: string): { marker: string; language: string } | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const marker = match[2]!;
  const info = match[3]!;
  if (marker.startsWith('`') && info.includes('`')) return null;
  return { marker, language: info.trim().split(/[ \t]+/, 1)[0] ?? '' };
}

function isClosingFence(line: string, marker: string): boolean {
  const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!match) return false;
  const closing = match[2]!;
  return closing[0] === marker[0] && closing.length >= marker.length;
}
