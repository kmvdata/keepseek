import { getInputScript } from './input/script';

export function getScript(): string {
  return `
    const vscode = acquireVsCodeApi();
    const state = {
      models: [],
      selectedModelId: '',
      messages: [],
      contextFiles: [],
      draftEdits: [],
      isBusy: false
    };

    const contextBar = document.getElementById('contextBar');
    const draftRegion = document.getElementById('draftRegion');
    const draftList = document.getElementById('draftList');
    const transcript = document.getElementById('transcript');
    const composer = document.getElementById('composer');
    const promptInput = document.getElementById('promptInput');
    const status = document.getElementById('status');
    const sendButton = document.getElementById('sendButton');
    let transientStatus = '';
    let transientStatusTimer = 0;

    draftList.addEventListener('click', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var button = target?.closest('button[data-edit-id]');
      if (!button) return;
      vscode.postMessage({ type: button.dataset.editAction, id: button.dataset.editId });
    });

    ${getInputScript()}

    window.addEventListener('message', function(event) {
      var message = event.data;
      if (message.type === 'state') {
        Object.assign(state, message.state);
        render();
      }
    });

    function render() {
      renderContextChips();
      renderDraftEdits();
      renderTranscript();
      renderStatus();
      if (window.keepseekInputControls) {
        window.keepseekInputControls.render();
      }
      sendButton.disabled = state.isBusy || promptInput.classList.contains('is-empty');
    }

    function renderStatus() {
      status.textContent = state.isBusy ? '\\u5904\\u7406\\u4e2d...' : transientStatus;
    }

    function renderContextChips() {
      var existing = contextBar.querySelectorAll('.context-chip');
      existing.forEach(function(el) { el.remove(); });

      if (!state.contextFiles.length) {
        return;
      }

      for (var i = 0; i < state.contextFiles.length; i++) {
        var file = state.contextFiles[i];
        var chip = document.createElement('span');
        chip.className = 'context-chip';

        var label = document.createElement('span');
        label.className = 'context-chip-label';
        label.textContent = file.label;
        label.title = file.fsPath;

        var remove = document.createElement('button');
        remove.className = 'context-chip-remove';
        remove.type = 'button';
        remove.textContent = '\\\\00d7';
        remove.title = '\\u79fb\\u9664 ' + file.label;
        remove.dataset.uri = file.uri;

        chip.append(label, remove);
        contextBar.append(chip);
      }
    }

    contextBar.addEventListener('click', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var removeBtn = target?.closest('.context-chip-remove');
      if (!removeBtn) return;
      event.stopPropagation();
      vscode.postMessage({ type: 'removeContextFile', uri: removeBtn.dataset.uri });
    });

    function renderDraftEdits() {
      draftList.innerHTML = '';
      draftRegion.classList.toggle('hidden', state.draftEdits.length === 0);

      for (var i = 0; i < state.draftEdits.length; i++) {
        var edit = state.draftEdits[i];
        var chip = document.createElement('div');
        chip.className = 'draft-chip';

        var label = document.createElement('span');
        label.className = 'draft-chip-label';
        label.textContent = edit.label;
        label.title = edit.reason;

        var actions = document.createElement('div');
        actions.className = 'draft-chip-actions';

        var apply = document.createElement('button');
        apply.type = 'button';
        apply.textContent = 'Apply';
        apply.dataset.editId = edit.id;
        apply.dataset.editAction = 'applyDraftEdit';

        var discard = document.createElement('button');
        discard.type = 'button';
        discard.className = 'secondary';
        discard.textContent = 'Discard';
        discard.dataset.editId = edit.id;
        discard.dataset.editAction = 'discardDraftEdit';

        actions.append(apply, discard);
        chip.append(label, actions);
        draftList.append(chip);
      }
    }

    function renderTranscript() {
      var shouldStick = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 24;
      transcript.innerHTML = '';

      if (!state.messages.length) {
        var empty = document.createElement('div');
        empty.className = 'transcript-empty';
        var icon = document.createElement('div');
        icon.className = 'transcript-empty-icon';
        icon.textContent = '\\\\2726';
        var line1 = document.createElement('div');
        line1.textContent = '\\u5f00\\u59cb KeepSeek \\u5bf9\\u8bdd';
        var line2 = document.createElement('div');
        line2.style.cssText = 'font-size:11px;opacity:0.6';
        line2.textContent = '\\u6dfb\\u52a0\\u4e0a\\u4e0b\\u6587\\u6587\\u4ef6\\u540e\\uff0c\\u8f93\\u5165\\u6d88\\u606f\\u5e76\\u53d1\\u9001';
        empty.append(icon, line1, line2);
        transcript.append(empty);
      }

      for (var i = 0; i < state.messages.length; i++) {
        var message = state.messages[i];
        var item = document.createElement('article');
        item.className = 'message ' + message.role;

        var role = document.createElement('div');
        role.className = 'message-role';
        role.textContent = message.role === 'user' ? 'You' : 'KeepSeek';

        var content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = message.content;

        item.append(role, content);
        transcript.append(item);
      }

      if (shouldStick) {
        transcript.scrollTop = transcript.scrollHeight;
      }
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    vscode.postMessage({ type: 'ready' });`;
}
