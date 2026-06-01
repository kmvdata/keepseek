export function isStandaloneReferenceLine(text: string, referenceStart: number, referenceEnd: number): boolean {
  const start = Math.max(0, referenceStart);
  const end = Math.max(start, referenceEnd);
  const lineStart = getLineStart(text, start);
  const lineEnd = getLineEnd(text, end);
  return !text.slice(lineStart, start).trim() && !text.slice(end, lineEnd).trim();
}

export function isInsideMarkdownFence(text: string, index: number): boolean {
  const value = String(text || '');
  const position = Math.max(0, Math.min(value.length, index));
  let cursor = 0;
  let openFence: MarkdownFence | undefined;

  while (cursor <= value.length) {
    const lineEnd = getLineEnd(value, cursor);
    const nextLineStart = getNextLineStart(value, lineEnd);
    const fence = parseMarkdownFenceLine(value.slice(cursor, lineEnd));

    if (openFence) {
      if (position < nextLineStart) {
        return true;
      }
      if (fence && fence.marker === openFence.marker && fence.length >= openFence.length && !fence.language) {
        openFence = undefined;
      }
    } else {
      if (fence) {
        if (position < nextLineStart) {
          return false;
        }
        openFence = fence;
      } else if (position < nextLineStart) {
        return false;
      }
    }

    if (nextLineStart <= cursor) {
      break;
    }
    cursor = nextLineStart;
  }

  return Boolean(openFence);
}

export function hasUnsafeReferenceTargetCharacters(value: string): boolean {
  if (!value.trim() || /["'`]/u.test(value) || /\s+\S+=/u.test(value)) {
    return true;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function getLineStart(text: string, index: number): number {
  const before = Math.max(0, index - 1);
  return Math.max(text.lastIndexOf('\n', before), text.lastIndexOf('\r', before)) + 1;
}

function getLineEnd(text: string, index: number): number {
  const lineFeed = text.indexOf('\n', index);
  const carriageReturn = text.indexOf('\r', index);
  if (lineFeed < 0) {
    return carriageReturn < 0 ? text.length : carriageReturn;
  }
  if (carriageReturn < 0) {
    return lineFeed;
  }
  return Math.min(lineFeed, carriageReturn);
}

function getNextLineStart(text: string, lineEnd: number): number {
  let cursor = lineEnd;
  if (text.charAt(cursor) === '\r') {
    cursor += 1;
  }
  if (text.charAt(cursor) === '\n') {
    cursor += 1;
  }
  return cursor;
}

interface MarkdownFence {
  marker: string;
  length: number;
  language: string;
}

function parseMarkdownFenceLine(line: string): MarkdownFence | undefined {
  const text = String(line || '');
  let index = 0;
  while (index < text.length && index < 3 && text.charAt(index) === ' ') {
    index += 1;
  }

  const marker = text.charAt(index);
  if (marker !== '`' && marker !== '~') {
    return undefined;
  }

  let length = 0;
  while (text.charAt(index + length) === marker) {
    length += 1;
  }
  if (length < 3) {
    return undefined;
  }

  return {
    marker,
    length,
    language: text.slice(index + length).trim()
  };
}
