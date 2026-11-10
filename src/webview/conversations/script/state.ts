import type { WebviewFragment } from '../../input/composition';

export const conversationsStateFragment: WebviewFragment = {
  id: 'conversations.state',
  source: `
    let sessionMenuOpen = false;
    let sessionMenuRenderKey = '';
    let sessionMultiSelectMode = false;
    let sessionRangeDays = 1;
    let sessionFavoritesOnly = false;
    let selectedSessionIds = new Set();
    let editingSessionTitleId = '';
    let activeWorkspaceTab = 'current';
    let otherWorkspaces = [];
    let otherWorkspaceSessions = {};
    let otherWorkspaceSessionErrors = {};
    let otherWorkspacesError = '';`.slice(1)
};
