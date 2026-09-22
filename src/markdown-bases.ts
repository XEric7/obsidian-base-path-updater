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
      edits.push({
        start: fence.start,
        end: fence.end,
        value: after,
        region: { before, after, ...fenceContext(source, fence.start, fence.end, after) },
      });
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

/** Locates complete `base` fences, skipping examples wrapped in a longer outer fence or HTML comment. */
export function findBaseFences(
  source: string,
): { start: number; bodyStart: number; bodyEnd: number; end: number }[] {
  const fences: { start: number; bodyStart: number; bodyEnd: number; end: number }[] = [];
  let open: OpenFence | undefined;
  let comment = false;
  let rawClose: string | undefined;
  for (const line of iterateLines(source)) {
    if (comment || rawClose) {
      if (comment && line.content.includes('-->')) comment = false;
      if (rawClose && line.content.toLowerCase().includes(rawClose)) rawClose = undefined;
      continue;
    }
    if (!open) {
      const opening = openingFence(line.content);
      if (opening) {
        open = {
          start: line.start,
          bodyStart: line.end,
          marker: opening.marker,
          base: opening.language.toLowerCase() === 'base',
        };
        continue;
      }
      const commentAt = line.content.indexOf('<!--');
      if (commentAt !== -1 && !line.content.includes('-->', commentAt + 4)) {
        comment = true;
        continue;
      }
      const raw = /^ {0,3}<(script|pre|style|textarea)(?=[\s>/])/i.exec(line.content);
      if (raw && raw[1]) {
        rawClose = `</${raw[1].toLowerCase()}>`;
        if (line.content.toLowerCase().includes(rawClose)) rawClose = undefined;
      }
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
  if (open?.base && !comment && !rawClose) {
    fences.push({
      start: open.start,
      bodyStart: open.bodyStart,
      bodyEnd: source.length,
      end: source.length,
    });
  }
  return fences;
}

/** Returns the shortest nearby text that makes this updated fence unique in the source. */
function fenceContext(
  source: string,
  start: number,
  end: number,
  after: string,
): { prefix?: string; suffix?: string } {
  const beforeText = source.slice(0, start);
  const afterText = source.slice(end);
  let prefixLength = 0;
  let suffixLength = 0;
  while (
    occurrences(
      source,
      beforeText.slice(beforeText.length - prefixLength) + after + afterText.slice(0, suffixLength),
    ) !== 1
  ) {
    if (prefixLength >= beforeText.length && suffixLength >= afterText.length) break;
    if (prefixLength < beforeText.length)
      prefixLength = Math.min(beforeText.length, prefixLength + 32);
    else suffixLength = Math.min(afterText.length, suffixLength + 32);
  }
  const prefix = beforeText.slice(beforeText.length - prefixLength);
  const suffix = afterText.slice(0, suffixLength);
  return {
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  };
}

/** Counts non-overlapping occurrences of needle in text. */
function occurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index <= text.length) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count++;
    index = found + needle.length;
  }
  return count;
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
