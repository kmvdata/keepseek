import type { WebviewFragment } from '../../input/composition';

/** Workspace shell that hosts the rail and the transcript stage. */
export const workspaceLayoutStylesFragment: WebviewFragment = {
  id: 'sidebar-workspace-layout-styles',
  source: `
    .project-workspace { flex: 1; min-height: 0; min-width: 0; display: flex; overflow: hidden; }
    .project-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .project-transcript-stage { position: relative; flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; isolation: isolate; }
`
};
