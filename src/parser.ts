import type { ExpansionResult, ProtectedRange, SnippetReader, SnippetReference, SnippetLogger } from "./types.ts";

const REFERENCE_PATTERN =
  /(?<![\p{L}\p{N}_#/\\&.-])#([A-Za-z0-9][A-Za-z0-9_-]*)(?![\p{L}\p{N}_#/\\-])(?!\.[A-Za-z0-9])/gu;

interface Line {
  start: number;
  contentEnd: number;
  next: number;
}

function readLine(text: string, start: number): Line {
  const newline = text.indexOf("\n", start);
  if (newline === -1) {
    return { start, contentEnd: text.length, next: text.length };
  }
  return { start, contentEnd: newline, next: newline + 1 };
}

function findFencedCodeRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  const openingFence = /^ {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(?:>[ \t]?)* {0,3}(`{3,}|~{3,})(.*)$/;
  const closingFence = /^ {0,3}(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?(?:>[ \t]?)* {0,3}(`{3,}|~{3,})[ \t]*$/;
  let position = 0;

  while (position < text.length) {
    const line = readLine(text, position);
    const content = text.slice(line.start, line.contentEnd);
    const opening = openingFence.exec(content);

    if (!opening) {
      position = line.next;
      continue;
    }

    const marker = opening[1] ?? "";
    const fenceChar = marker[0];
    const fenceLength = marker.length;
    if (fenceChar === "`" && (opening[2] ?? "").includes("`")) {
      position = line.next;
      continue;
    }

    let fenceEnd: number | undefined;
    let scan = line.next;
    while (scan < text.length) {
      const closingLine = readLine(text, scan);
      const closingContent = text.slice(closingLine.start, closingLine.contentEnd);
      const closing = closingFence.exec(closingContent);
      const closingMarker = closing?.[1] ?? "";
      if (
        closing &&
        closingMarker[0] === fenceChar &&
        closingMarker.length >= fenceLength
      ) {
        fenceEnd = closingLine.next;
        break;
      }
      scan = closingLine.next;
    }

    const end = fenceEnd ?? text.length;
    ranges.push({ start: line.start, end });
    position = end;
  }

  return ranges;
}

function findInlineCodeInSegment(text: string, start: number, end: number, ranges: ProtectedRange[]): void {
  let index = start;

  while (index < end) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }

    if (text[index] !== "`") {
      index += 1;
      continue;
    }

    let openingLength = 1;
    while (index + openingLength < end && text[index + openingLength] === "`") {
      openingLength += 1;
    }

    let scan = index + openingLength;
    let closed = false;

    while (scan < end) {
      if (text[scan] !== "`") {
        scan += 1;
        continue;
      }

      let closingLength = 1;
      while (scan + closingLength < end && text[scan + closingLength] === "`") {
        closingLength += 1;
      }

      if (closingLength === openingLength) {
        ranges.push({ start: index, end: scan + closingLength });
        index = scan + closingLength;
        closed = true;
        break;
      }

      scan += closingLength;
    }

    if (!closed) {
      index += openingLength;
    }
  }
}

function findInlineCodeRanges(text: string, start: number, end: number): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  let segmentStart = start;

  while (segmentStart < end) {
    const blankLine = /\n[ \t]*\n/g;
    blankLine.lastIndex = segmentStart;
    const match = blankLine.exec(text);
    const segmentEnd = match && match.index < end ? match.index : end;

    findInlineCodeInSegment(text, segmentStart, segmentEnd, ranges);

    if (!match || match.index >= end) {
      break;
    }
    segmentStart = match.index + match[0].length;
  }

  return ranges;
}

function mergeRanges(ranges: ProtectedRange[]): ProtectedRange[] {
  if (ranges.length <= 1) {
    return ranges;
  }

  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const first = sorted[0];
  if (!first) {
    return [];
  }
  const merged: ProtectedRange[] = [first];

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = merged[merged.length - 1];
    if (!current || !previous) {
      continue;
    }
    if (current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

export function findProtectedRanges(text: string): ProtectedRange[] {
  const fenced = findFencedCodeRanges(text);
  const ranges = [...fenced];
  let cursor = 0;

  for (const range of fenced) {
    if (cursor < range.start) {
      ranges.push(...findInlineCodeRanges(text, cursor, range.start));
    }
    cursor = range.end;
  }

  if (cursor < text.length) {
    ranges.push(...findInlineCodeRanges(text, cursor, text.length));
  }

  return mergeRanges(ranges);
}

function collectReferences(text: string, start: number, end: number, references: SnippetReference[]): void {
  const pattern = new RegExp(REFERENCE_PATTERN.source, REFERENCE_PATTERN.flags);
  const segment = text.slice(start, end);

  for (const match of segment.matchAll(pattern)) {
    const name = match[1];
    const offset = match.index;
    if (!name) {
      continue;
    }
    references.push({
      name,
      raw: match[0],
      start: start + offset,
      end: start + offset + match[0].length,
    });
  }
}

export function parseSnippetReferences(text: string): SnippetReference[] {
  const references: SnippetReference[] = [];
  let cursor = 0;

  for (const range of findProtectedRanges(text)) {
    if (cursor < range.start) {
      collectReferences(text, cursor, range.start, references);
    }
    cursor = range.end;
  }

  if (cursor < text.length) {
    collectReferences(text, cursor, text.length, references);
  }

  return references;
}

export async function expandSnippetReferences(
  text: string,
  readSnippet: SnippetReader,
  logger?: SnippetLogger,
): Promise<ExpansionResult> {
  const references = parseSnippetReferences(text);
  if (references.length === 0) {
    return { text, expanded: 0 };
  }

  let output = "";
  let cursor = 0;
  let expanded = 0;

  for (const reference of references) {
    let content: string | undefined;
    try {
      content = await readSnippet(reference.name);
    } catch (error) {
      logger?.(`Failed to read snippet "${reference.name}"`, error);
      continue;
    }

    if (content === undefined) {
      continue;
    }

    output += text.slice(cursor, reference.start);
    output += content;
    cursor = reference.end;
    expanded += 1;
  }

  if (expanded === 0) {
    return { text, expanded: 0 };
  }

  output += text.slice(cursor);
  return { text: output, expanded };
}
