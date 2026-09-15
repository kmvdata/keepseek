import { composeWebviewFragments, INPUT_STYLE_FRAGMENTS } from './composition';
import { getNewAccountDialogStyles } from './newAccountDialog';

/** Compatibility entry point; feature styles keep their legacy cascade order. */
export function getInputStyles(): string {
  return `\n${composeWebviewFragments(INPUT_STYLE_FRAGMENTS)}${getNewAccountDialogStyles()}`;
}
