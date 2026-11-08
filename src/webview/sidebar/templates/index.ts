import { railTemplateFragment } from './rail';
import { drawerTemplateFragment } from './drawer';
import { tooltipTemplateFragment } from './tooltip';

/** Project task view chrome. Runtime and session ownership remain entirely in the host. */
export function getProjectTasksTemplate(): string {
  return railTemplateFragment.source;
}

/** Anchored to the transcript stage; never participates in its flex geometry. */
export function getProjectTasksOverlayTemplate(): string {
  return drawerTemplateFragment.source + '\n' + tooltipTemplateFragment.source;
}
