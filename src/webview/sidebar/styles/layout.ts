import type { WebviewFragment } from '../../input/composition';

/**
 * Workspace shell that hosts the rail, the transcript stage and the input
 * region. The input region is a sibling of the workspace, so the rail and the
 * drawer can only reach down to the composer's top edge.
 */
export const workspaceLayoutStylesFragment: WebviewFragment = {
  id: 'sidebar-workspace-layout-styles',
  source: `
    .project-workspace { flex: 1; min-height: 0; min-width: 0; display: flex; overflow: hidden; }
    .project-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .project-transcript-stage { position: relative; flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; isolation: isolate; }
    .project-input-region { flex: 0 0 auto; width: 100%; min-width: 0; display: flex; flex-direction: column; }
    .project-input-region > .composer { width: 100%; min-width: 0; }
`
};
