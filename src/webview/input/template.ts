import { composeWebviewFragments, INPUT_TEMPLATE_FRAGMENTS } from './composition';
import { getNewAccountDialogTemplate } from './newAccountDialog';

/** Compatibility entry point; feature templates keep their legacy DOM order. */
export function getInputTemplate(): string {
  return `\n${composeWebviewFragments(INPUT_TEMPLATE_FRAGMENTS)}${getNewAccountDialogTemplate()}`;
}
