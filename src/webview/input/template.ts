import { composeWebviewFragments, INPUT_TEMPLATE_FRAGMENTS } from './composition';
import { getNewAccountDialogTemplate } from './newAccountDialog';

/** Composed input template; fragment order defines DOM initialization. */
export function getInputTemplate(): string {
  return `\n${composeWebviewFragments(INPUT_TEMPLATE_FRAGMENTS)}${getNewAccountDialogTemplate()}`;
}
