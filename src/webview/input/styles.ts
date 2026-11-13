import { composeWebviewFragments, INPUT_STYLE_FRAGMENTS } from './composition';
import { getNewAccountDialogStyles } from './newAccountDialog';

/** Composed input styles; fragment order defines the CSS cascade. */
export function getInputStyles(): string {
  return `\n${composeWebviewFragments(INPUT_STYLE_FRAGMENTS)}${getNewAccountDialogStyles()}`;
}
