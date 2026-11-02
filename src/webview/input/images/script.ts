import type { WebviewFragment } from '../composition';

/** Images are independent activities. Nothing here edits the text conversation or its composer. */
export const imageScriptFragment: WebviewFragment = {
  id: 'images.script',
  source: String.raw`
      var imageOverlay = document.getElementById('imageDialogOverlay');
      var imageForm = document.getElementById('imageForm');
      var imageRegion = document.getElementById('imageActivityRegion');
      var imagePrompt = document.getElementById('imagePromptInput');
      var imageModel = document.getElementById('imageModelSelect');
      var imageSize = document.getElementById('imageSize');
      var imageQuality = document.getElementById('imageQuality');
      var imageBackground = document.getElementById('imageBackground');
      var imageFormat = document.getElementById('imageOutputFormat');
      var imageSubmit = document.getElementById('imageSubmitButton');
      var imageStatus = document.getElementById('imageDialogStatus');
      var imageEntry = document.getElementById('commandImageButton');
      var imageSessionId = '';
      var imageView = { models: [], jobs: [], assets: [] };
      var imageDraft = {};
      var imageReturnFocus = null;
      var imageCardsSignature = '';
      var imageSending = false;
      var imageRequestedPage = 0;
      var imagePageLoading = false;

      function readImageDrafts() {
        var saved = vscode.getState ? vscode.getState() : {};
        return saved && saved.imageDrafts && typeof saved.imageDrafts === 'object' ? saved.imageDrafts : {};
      }
      function persistImageDraft() {
        if (!imageSessionId) return;
        var saved = vscode.getState ? vscode.getState() : {};
        var drafts = Object.assign({}, readImageDrafts());
        drafts[imageSessionId] = Object.assign({}, imageDraft, { savedAt: Date.now() });
        Object.keys(drafts).sort(function(a, b) { return (drafts[b].savedAt || 0) - (drafts[a].savedAt || 0); }).slice(20).forEach(function(key) { delete drafts[key]; });
        if (vscode.setState) vscode.setState(Object.assign({}, saved || {}, { imageDrafts: drafts }));
      }
      function collectImageDraft() {
        if (imageDraft.pendingSubmission) { persistImageDraft(); return; }
        imageDraft.prompt = imagePrompt.value;
        imageDraft.modelKey = imageModel.value;
        imageDraft.size = imageSize.value;
        imageDraft.quality = imageQuality.value;
        imageDraft.background = imageBackground.value;
        imageDraft.outputFormat = imageFormat.value;
        persistImageDraft();
      }
      function newImageActionId() {
        return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : 'image-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      }
      function imageModelKey(model) { return JSON.stringify([model.sourceId, model.modelId]); }
      function selectedImageModel() { return (imageView.models || []).find(function(model) { return imageModelKey(model) === imageModel.value; }); }
      function imageCostText(cost) {
        if (cost && Number.isFinite(cost.amount)) return cost.currency + ' ' + cost.amount + ' · ' + t(cost.status === 'calculated' ? 'imageCostCalculated' : 'imageCostEstimate');
        return t('imageCostUnknown');
      }
      function imageStatusText(status) { return t('imageStatus_' + status); }
      function setImageStatus(text, error) {
        imageStatus.textContent = text || '';
        imageStatus.classList.toggle('image-status-error', Boolean(error));
      }
      function openImagePanel(draft) {
        if (!imageSessionId) { setComposerStatus(t('imageSessionRequired')); return; }
        imageReturnFocus = document.activeElement;
        closeCommandMenu();
        closeReferenceMenu(false);
        if (draft) {
          imageDraft = Object.assign({}, draft);
          delete imageDraft.actionId;
        } else if (!imageDraft.prompt) {
          imageDraft.prompt = serializePrompt();
        }
        imageOverlay.classList.remove('hidden');
        if (imageDraft.inputAsset) requestImagePage(imageRequestedPage);
        if (imageEntry) imageEntry.setAttribute('aria-expanded', 'true');
        renderImagePanel();
        persistImageDraft();
        imagePrompt.focus();
      }
      function closeImagePanel() {
        if (!imageOverlay || imageOverlay.classList.contains('hidden')) return;
        collectImageDraft();
        imageOverlay.classList.add('hidden');
        if (imageEntry) imageEntry.setAttribute('aria-expanded', 'false');
        var focus = imageReturnFocus && imageReturnFocus.isConnected && imageReturnFocus.offsetParent !== null ? imageReturnFocus : commandMenuButton;
        if (focus) focus.focus();
      }
      function renderImagePanel() {
        if (!imageOverlay || imageOverlay.classList.contains('hidden')) return;
        imagePrompt.value = imageDraft.prompt || '';
        imageSize.value = imageDraft.size || '1024x1024';
        imageQuality.value = imageDraft.quality || 'medium';
        imageBackground.value = imageDraft.background || 'opaque';
        imageFormat.value = imageDraft.outputFormat || 'png';
        var preferred = imageDraft.modelKey || JSON.stringify([imageView.selectedSourceId || '', imageView.selectedModelId || '']);
        imageModel.innerHTML = '';
        (imageView.models || []).forEach(function(model) {
          var option = document.createElement('option');
          option.value = imageModelKey(model);
          option.textContent = model.label || [model.sourceName || model.sourceId, model.modelId].join(' / ');
          if (!model.available) option.textContent += ' · ' + (model.reason ? t('imageReason_' + model.reason) : t('imageUnavailable'));
          imageModel.append(option);
        });
        imageModel.value = preferred;
        if (!imageModel.value && imageModel.options.length) imageModel.value = imageModel.options[0].value;
        var model = selectedImageModel();
        document.getElementById('imageConfigurationReason').textContent = !model ? t('imageNoModel') : !model.available ? (model.reason ? t('imageReason_' + model.reason) : t('imageUnavailable')) : '';
        document.getElementById('imageSettingsButton').classList.toggle('hidden', Boolean(model && model.available));
        document.getElementById('imageOperation').textContent = t(imageDraft.inputAsset ? 'imageOperationEdit' : 'imageOperationGenerate');
        imageSubmit.textContent = t(imageDraft.pendingSubmission ? 'imageRetrySubmission' : imageDraft.inputAsset ? 'imageStartEdit' : 'imageGenerate');
        var preview = document.getElementById('imageInputPreview');
        preview.innerHTML = '';
        preview.classList.toggle('hidden', !imageDraft.inputAsset);
        document.getElementById('imageRemoveInputButton').classList.toggle('hidden', !imageDraft.inputAsset);
        if (imageDraft.inputAsset) {
          var asset = imageDraft.inputAsset;
          if (asset.uri) { var img = document.createElement('img'); img.decoding = 'async'; img.src = asset.uri; img.alt = t('imageSelectedInputAlt'); preview.append(img); }
          var label = document.createElement('span');
          label.textContent = (asset.fileName || t('imageSelectedInput')) + ' · ' + (asset.width || '?') + ' × ' + (asset.height || '?') + ' · ' + (asset.byteLength || 0).toLocaleString() + ' B';
          preview.append(label);
        }
        var authorization = t('imageAuthorization', { source: model ? (model.sourceName || model.sourceId) : '—', size: imageSize.value, quality: imageQuality.value, format: imageFormat.value, background: t(imageBackground.value === 'transparent' ? 'imageTransparent' : 'imageOpaque') });
        authorization += ' ' + t('imageCostUnknown');
        if (Number(imageView.costLimit) > 0) authorization += ' ' + t('imageCostLimitBlocked', { limit: imageView.costLimit });
        document.getElementById('imageAuthorization').textContent = authorization;
        imageSubmit.disabled = imageSending || (!imageDraft.pendingSubmission && (!model || !model.available || Boolean(imageView.activeJobId) || Number(imageView.costLimit) > 0));
        [imagePrompt, imageModel, imageSize, imageQuality, imageBackground, imageFormat, document.getElementById('imageImportButton'), document.getElementById('imageRemoveInputButton')].forEach(function(control) { control.disabled = Boolean(imageDraft.pendingSubmission); });
        if (imageView.activeJobId) setImageStatus(t('imageAlreadyRunning'));
        else if (imageDraft.pendingSubmission && !imageSending) setImageStatus(t('imageRetryNotice'));
      }
      function makeImageButton(labelKey, handler) {
        var button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.dataset.imageAction = labelKey; button.textContent = t(labelKey); button.addEventListener('click', handler); return button;
      }
      function draftFromImageJob(job, edit) {
        var spec = job.spec || {};
        var draft = { prompt: edit ? '' : (spec.prompt || ''), modelKey: JSON.stringify([spec.sourceId, spec.model || spec.modelId]), size: spec.size, quality: spec.quality, background: spec.background, outputFormat: spec.outputFormat, parentJobId: job.jobId };
        if (edit) draft.inputAsset = job.resultAsset;
        else if (Array.isArray(spec.inputAssets) && spec.inputAssets[0]) {
          draft.inputAsset = (imageView.assets || []).find(function(asset) { return asset.assetId === spec.inputAssets[0].assetId; }) || { assetId: spec.inputAssets[0].assetId };
        }
        return draft;
      }
      function imageJobAction(job, action) { vscode.postMessage({ type: 'imageJobAction', sessionId: imageSessionId, jobId: job.jobId, action: action }); }
      function requestImagePage(page) {
        if (!imageSessionId || !Number.isInteger(page) || page < 0 || page > 9) return;
        imageRequestedPage = page;
        imagePageLoading = true;
        vscode.postMessage({ type: 'imageStateRequest', sessionId: imageSessionId, page: page, inputAssetId: imageDraft.inputAsset && imageDraft.inputAsset.assetId });
        renderImageCards();
      }
      function isImageChangeSet(changeSet) { return imageSessionId === state.activeSessionId && (imageView.jobs || []).some(function(job) { return changeSet.runId === job.jobId; }); }
      function renderImageCards() {
        if (!imageRegion) return;
        if (imageRegion.parentElement !== transcript) transcript.append(imageRegion);
        var signature = JSON.stringify([imageSessionId, state.language, imageView.jobs, imageView.error, imageView.totals, imageView.page, imageView.hasOlder, imageView.totalJobs, imagePageLoading, (state.changeSets || []).filter(isImageChangeSet), Array.from(pendingChangeActions.entries())]);
        if (signature === imageCardsSignature) return;
        imageCardsSignature = signature;
        var activeImageButton = document.activeElement && document.activeElement.dataset ? { jobId: document.activeElement.dataset.imageJobId, action: document.activeElement.dataset.imageAction } : null;
        imageRegion.innerHTML = '';
        var jobs = (imageView.jobs || []).slice(0, 50);
        imageRegion.classList.toggle('hidden', jobs.length === 0 && !imageView.error && !imageView.totalJobs);
        if (imageView.totals) {
          var totals = imageView.totals;
          var totalsText = document.createElement('p'); totalsText.className = 'image-status';
          totalsText.textContent = t('imageTotals', { jobs: totals.jobs || 0, images: totals.images || 0, unknown: totals.unknownCosts || 0 });
          if (totals.costs) Object.keys(totals.costs).forEach(function(currency) { totalsText.textContent += ' · ' + currency + ' ' + totals.costs[currency]; });
          imageRegion.append(totalsText);
        }
        if (Number(imageView.totalJobs) > 50 || Number(imageView.page) > 0) {
          var pagination = document.createElement('nav'); pagination.className = 'image-actions image-pagination'; pagination.setAttribute('aria-label', t('imageHistoryPages'));
          var page = Number.isInteger(imageView.page) ? imageView.page : 0;
          var newer = makeImageButton('imageNewerJobs', function() { requestImagePage(page - 1); });
          newer.disabled = imagePageLoading || page <= 0;
          var older = makeImageButton('imageOlderJobs', function() { requestImagePage(page + 1); });
          older.disabled = imagePageLoading || !imageView.hasOlder || page >= 9;
          var pageLabel = document.createElement('span'); pageLabel.className = 'image-status'; pageLabel.setAttribute('role', 'status');
          pageLabel.textContent = t(imagePageLoading ? 'imagePageLoading' : 'imagePage', { page: (imagePageLoading ? imageRequestedPage : page) + 1, count: imageView.totalJobs || jobs.length });
          pagination.append(newer, pageLabel, older); imageRegion.append(pagination);
        }
        if (imageView.error) { var error = document.createElement('p'); error.className = 'image-status image-status-error'; error.textContent = imageView.error; imageRegion.append(error); }
        jobs.forEach(function(job) {
          var card = document.createElement('article'); card.className = 'image-card'; card.dataset.imageJobId = job.jobId;
          var heading = document.createElement('h3'); heading.textContent = t(job.spec && job.spec.operation === 'edit' ? 'imageOperationEdit' : 'imageOperationGenerate'); card.append(heading);
          var progress = document.createElement('p'); progress.className = 'image-status'; progress.setAttribute('role', 'status'); progress.textContent = imageStatusText(job.status || job.state); card.append(progress);
          var prompt = document.createElement('p'); prompt.textContent = job.spec && job.spec.prompt || ''; card.append(prompt);
          if (job.resultAsset && job.resultAsset.uri) {
            var previewButton = makeImageButton('imageOpen', function() { imageJobAction(job, 'open'); });
            previewButton.className = 'image-preview-button'; previewButton.textContent = '';
            previewButton.dataset.imageJobId = job.jobId;
            previewButton.setAttribute('aria-label', t('imageOpen'));
            var image = document.createElement('img'); image.className = 'image-card-preview'; image.loading = 'lazy'; image.decoding = 'async'; image.src = job.resultAsset.uri; image.alt = t('imageResultAlt', { prompt: (job.spec && job.spec.prompt || '').slice(0, 160) });
            image.addEventListener('error', function() { image.hidden = true; var missing = document.createElement('p'); missing.className = 'image-status image-status-error'; missing.textContent = t('imageAssetUnavailable'); previewButton.append(missing); }, { once: true });
            previewButton.append(image); card.append(previewButton);
          } else if (job.resultAssetId || job.status === 'saved') { var missing = document.createElement('p'); missing.className = 'image-status image-status-error'; missing.textContent = t('imageAssetUnavailable'); card.append(missing); }
          var cost = document.createElement('p'); cost.className = 'image-status'; cost.textContent = imageCostText(job.budget && (job.budget.settlement || job.budget.reservation)); card.append(cost);
          if (job.error) { var err = document.createElement('p'); err.className = 'image-status image-status-error'; err.textContent = typeof job.error === 'string' ? job.error : job.error.message; card.append(err); }
          if (['submission_unknown', 'local_stopped', 'submitting'].includes(job.status)) { var unknown = document.createElement('p'); unknown.className = 'image-status'; unknown.textContent = t('imageUnknownNotice'); card.append(unknown); }
          var actions = document.createElement('div'); actions.className = 'image-actions';
          actions.append(makeImageButton('imageRegenerate', function() { openImagePanel(draftFromImageJob(job, false)); }));
          if (job.resultAsset && job.resultAsset.uri) {
            actions.append(makeImageButton('imageOpen', function() { imageJobAction(job, 'open'); }));
            actions.append(makeImageButton('imageContinueEdit', function() { openImagePanel(draftFromImageJob(job, true)); }));
            actions.append(makeImageButton('imagePrepareWrite', function() { imageJobAction(job, 'prepareWrite'); }));
          }
          if (['preparing', 'submitting', 'accepted', 'generating'].includes(job.status)) actions.append(makeImageButton('imageStopWaiting', function() { imageJobAction(job, 'stop'); }));
          if (job.status === 'generated' && job.canRetrieve) actions.append(makeImageButton('imageRetrieve', function() { imageJobAction(job, 'retrieve'); }));
          Array.from(actions.children).forEach(function(button) { button.dataset.imageJobId = job.jobId; });
          card.append(actions);
          (state.changeSets || []).filter(function(changeSet) { return changeSet.runId === job.jobId; }).forEach(function(changeSet) { card.append(createChangeSetCard(changeSet)); });
          var details = document.createElement('details'); var summary = document.createElement('summary'); summary.textContent = t('imageDetails'); var pre = document.createElement('pre');
          pre.textContent = JSON.stringify({ jobId: job.jobId, specHash: job.specHash, sourceId: job.spec && job.spec.sourceId, model: job.spec && job.spec.model, size: job.spec && job.spec.size, quality: job.spec && job.spec.quality, background: job.spec && job.spec.background, outputFormat: job.spec && job.spec.outputFormat, parentJobId: job.parentJobId, resultAssetId: job.resultAssetId, resultHash: job.resultHash, createdAt: job.createdAt, errorCode: job.error && job.error.code }, null, 2);
          details.append(summary, pre); card.append(details); imageRegion.append(card);
        });
        if (activeImageButton && activeImageButton.action && imageRegion.querySelectorAll) {
          var restore = Array.from(imageRegion.querySelectorAll('button[data-image-action]')).find(function(button) { return button.dataset.imageJobId === activeImageButton.jobId && button.dataset.imageAction === activeImageButton.action; });
          if (restore) restore.focus({ preventScroll: true });
        }
      }
      function renderImageActivities() {
        var nextSession = state.activeSessionId || '';
        if (nextSession !== imageSessionId) {
          if (imageSessionId) collectImageDraft();
          if (!imageOverlay.classList.contains('hidden')) closeImagePanel();
          imageSessionId = nextSession;
          imageSending = false;
          imageRequestedPage = 0;
          imagePageLoading = false;
          imageDraft = Object.assign({}, readImageDrafts()[nextSession] || {});
          imageView = { models: [], jobs: [], assets: [] };
          imageCardsSignature = '';
          if (nextSession) requestImagePage(0);
        }
        renderImageCards();
      }
      function handleImageHostMessage(message) {
        if (!message || message.sessionId !== imageSessionId) return;
        if (message.type === 'imageState') {
          if (Number.isInteger(message.page) && message.page !== imageRequestedPage) return;
          imageView = Object.assign({}, imageView, message);
          if (Array.isArray(message.jobs) && !message.error) delete imageView.error;
          imagePageLoading = false;
          imageSending = false;
          if (imageDraft.actionId && imageView.jobs.some(function(job) { return job.actionId === imageDraft.actionId; })) { delete imageDraft.actionId; delete imageDraft.pendingSubmission; persistImageDraft(); }
          if (imageDraft.inputAsset) {
            var fresh = (imageView.assets || []).find(function(asset) { return asset.assetId === imageDraft.inputAsset.assetId; });
            if (fresh) imageDraft.inputAsset = fresh;
          }
          renderImageCards(); renderImagePanel();
        } else if (message.type === 'imageImported') {
          if (message.asset) { collectImageDraft(); imageDraft.inputAsset = message.asset; delete imageDraft.actionId; persistImageDraft(); renderImagePanel(); setImageStatus(''); }
          if (message.error) setImageStatus(message.error, true);
        } else if (message.type === 'imageSubmitFeedback') {
          imageSending = false;
          if (!message.actionId || message.actionId === imageDraft.actionId) { delete imageDraft.actionId; delete imageDraft.pendingSubmission; persistImageDraft(); renderImagePanel(); }
          setImageStatus(message.error || t('imageSubmitted'), Boolean(message.error));
          if (!message.error) closeImagePanel();
        }
      }
      if (imageEntry) imageEntry.addEventListener('click', function() { openImagePanel(); });
      document.getElementById('imageCloseButton').addEventListener('click', closeImagePanel);
      document.getElementById('imageSettingsButton').addEventListener('click', function() { closeImagePanel(); vscode.postMessage({ type: 'openApiSettings' }); });
      document.getElementById('imageImportButton').addEventListener('click', function() { collectImageDraft(); vscode.postMessage({ type: 'imageImport', sessionId: imageSessionId }); });
      document.getElementById('imageRemoveInputButton').addEventListener('click', function() { collectImageDraft(); delete imageDraft.inputAsset; delete imageDraft.parentJobId; delete imageDraft.actionId; persistImageDraft(); renderImagePanel(); });
      imageForm.addEventListener('input', function() { if (imageDraft.pendingSubmission) return; delete imageDraft.actionId; collectImageDraft(); setImageStatus(''); });
      imageForm.addEventListener('change', function(event) {
        if (imageDraft.pendingSubmission) return;
        delete imageDraft.actionId; collectImageDraft();
        if (event.target === imageModel) { var model = selectedImageModel(); if (model) vscode.postMessage({ type: 'imageSelectModel', sessionId: imageSessionId, sourceId: model.sourceId, modelId: model.modelId }); }
        renderImagePanel();
      });
      imageForm.addEventListener('submit', function(event) {
        event.preventDefault();
        if (imageSubmit.disabled || imageSending) return;
        if (imageDraft.pendingSubmission) {
          imageSending = true;
          vscode.postMessage(imageDraft.pendingSubmission);
          imageSubmit.disabled = true;
          setImageStatus(t('imageSubmitting'));
          return;
        }
        collectImageDraft();
        if (!imageDraft.prompt.trim() || imageDraft.prompt.length > 32000) { setImageStatus(t('imagePromptLimit'), true); imagePrompt.focus(); return; }
        if (imageDraft.background === 'transparent' && imageDraft.outputFormat === 'jpeg') { setImageStatus(t('imageTransparencyFormat'), true); return; }
        var model = selectedImageModel(); if (!model || !model.available) { setImageStatus(t('imageNoModel'), true); return; }
        imageDraft.prompt = imageDraft.prompt.replace(/\r\n?/g, '\n').trim(); imagePrompt.value = imageDraft.prompt;
        imageDraft.actionId = newImageActionId(); persistImageDraft();
        imageDraft.pendingSubmission = { type: 'imageSubmit', sessionId: imageSessionId, actionId: imageDraft.actionId, sourceId: model.sourceId, modelId: model.modelId, prompt: imageDraft.prompt, size: imageDraft.size, quality: imageDraft.quality, background: imageDraft.background, outputFormat: imageDraft.outputFormat, inputAssetId: imageDraft.inputAsset && imageDraft.inputAsset.assetId, parentJobId: imageDraft.parentJobId };
        persistImageDraft(); imageSending = true;
        if (imageRequestedPage > 0) requestImagePage(0);
        vscode.postMessage(imageDraft.pendingSubmission);
        imageSubmit.disabled = true; setImageStatus(t('imageSubmitting'));
      });
      imageOverlay.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeImagePanel(); return; }
        if (event.key !== 'Tab') return;
        var controls = Array.from(imageForm.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary')).filter(function(element) { return element.offsetParent !== null; });
        var first = controls[0]; var last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
`.slice(1)
};
