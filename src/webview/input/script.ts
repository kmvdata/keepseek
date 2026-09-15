import { composeWebviewFragments, INPUT_SCRIPT_FRAGMENTS } from './composition';

/** Compatibility entry point; feature code is assembled in composition.ts. */
export function getInputScript(): string {
  return `\n${composeWebviewFragments(INPUT_SCRIPT_FRAGMENTS)}`;
}
