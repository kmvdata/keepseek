import { composeWebviewFragments, type WebviewFragment } from '../../input/composition';
import { workspaceLayoutStylesFragment } from './layout';
import { railStylesFragment } from './rail';
import { drawerStylesFragment } from './drawer';
import { cardStylesFragment } from './card';
import { detailStylesFragment } from './detail';
import { ringStylesFragment } from './ring';
import { tooltipStylesFragment } from './tooltip';
import { viewStatusStylesFragment } from './viewStatus';
import { a11yStylesFragment } from './a11y';

// Order is the cascade contract: it must stay byte-identical to the original
// single project-task style block. Only the first fragment opens with a newline,
// every fragment ends with its own trailing newline, and only the final fragment
// carries the closing indentation. This keeps join('') free of blank lines.
export const SIDEBAR_STYLE_FRAGMENTS = [
  workspaceLayoutStylesFragment,
  railStylesFragment,
  drawerStylesFragment,
  cardStylesFragment,
  detailStylesFragment,
  ringStylesFragment,
  tooltipStylesFragment,
  viewStatusStylesFragment,
  a11yStylesFragment
] as const satisfies readonly WebviewFragment[];

/** Project task view chrome styles. Runtime and session ownership remain in the host. */
export function getProjectTasksStyles(): string {
  return composeWebviewFragments(SIDEBAR_STYLE_FRAGMENTS);
}
