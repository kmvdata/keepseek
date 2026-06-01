export function estimateTokenCount(value: string): number {
  let estimate = 0;
  for (const character of String(value || '')) {
    const codePoint = character.codePointAt(0) ?? 0;
    estimate += estimateCharacterTokens(codePoint);
  }
  return Math.ceil(estimate);
}

function estimateCharacterTokens(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 0.3;
  }
  if (isCjkCodePoint(codePoint)) {
    return 1;
  }
  return 0.75;
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ebef) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  );
}
