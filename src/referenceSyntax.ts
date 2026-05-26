export function isStandaloneReferenceLine(text: string, referenceStart: number, referenceEnd: number): boolean {
  const start = Math.max(0, referenceStart);
  const end = Math.max(start, referenceEnd);
  const lineStart = getLineStart(text, start);
  const lineEnd = getLineEnd(text, end);
  return !text.slice(lineStart, start).trim() && !text.slice(end, lineEnd).trim();
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
