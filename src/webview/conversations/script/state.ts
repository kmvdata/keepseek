import type { WebviewFragment } from '../../input/composition';

export const conversationsStateFragment: WebviewFragment = {
  id: 'conversations.state',
  source: `
    let sessionMenuOpen = false;
    let sessionMenuRenderKey = '';
    let sessionMultiSelectMode = false;
    let sessionRangeDays = 1;
    let sessionWithRunOnly = false;
    let sessionFavoritesOnly = false;
    let selectedSessionIds = new Set();
    let editingSessionTitleId = '';`.slice(1)
};
