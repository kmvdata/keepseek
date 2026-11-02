import type { WebviewFragment } from '../composition';

export const imageTemplateFragment: WebviewFragment = {
  id: 'template.images',
  source: `
    <section id="imageActivityRegion" class="image-activity hidden" aria-label="Images" data-i18n-aria-label="imageActivities"></section>
    <div id="imageDialogOverlay" class="settings-overlay hidden">
      <form id="imageForm" class="settings-dialog image-dialog" role="dialog" aria-modal="true" aria-labelledby="imageDialogTitle">
        <div class="settings-dialog-header"><span id="imageDialogTitle" class="settings-dialog-title" data-i18n="imageGenerate">生成图片</span></div>
        <div class="settings-dialog-body">
          <p class="settings-dialog-desc" data-i18n="imageScopeNotice">每次生成一张，仅发送描述和明确选中的图片；聊天草稿保持不变。</p>
          <label class="settings-field"><span class="settings-field-label" data-i18n="imageModel">图像账号 / 模型</span><select id="imageModelSelect" class="settings-input"></select></label>
          <p id="imageConfigurationReason" class="settings-dialog-desc" role="status"></p>
          <button id="imageSettingsButton" type="button" class="secondary" data-i18n="imageOpenSettings">配置图像来源</button>
          <p id="imageOperation" class="settings-dialog-desc"></p>
          <label class="settings-field"><span class="settings-field-label" data-i18n="imagePrompt">图像描述</span><textarea id="imagePromptInput" class="settings-input settings-textarea" rows="5" required></textarea></label>
          <div class="image-parameter-grid">
            <label class="settings-field"><span class="settings-field-label" data-i18n="imageSize">尺寸</span><select id="imageSize" class="settings-input"><option value="1024x1024">1024 × 1024</option><option value="1536x1024">1536 × 1024</option><option value="1024x1536">1024 × 1536</option></select></label>
            <label class="settings-field"><span class="settings-field-label" data-i18n="imageQuality">质量</span><select id="imageQuality" class="settings-input"><option value="low" data-i18n="imageQualityLow">低</option><option value="medium" data-i18n="imageQualityMedium" selected>中</option><option value="high" data-i18n="imageQualityHigh">高</option></select></label>
          </div>
          <div id="imageInputPreview" class="image-input-preview hidden"></div>
          <div class="image-actions"><button id="imageImportButton" type="button" class="secondary" data-i18n="imageChooseInput">选择一张图片</button><button id="imageRemoveInputButton" type="button" class="secondary hidden" data-i18n="imageRemoveInput">移除图片</button></div>
          <details class="image-advanced"><summary data-i18n="imageAdvanced">高级参数</summary><div class="image-parameter-grid">
            <label class="settings-field"><span class="settings-field-label" data-i18n="imageBackground">背景</span><select id="imageBackground" class="settings-input"><option value="opaque" data-i18n="imageOpaque">不透明</option><option value="transparent" data-i18n="imageTransparent">透明</option></select></label>
            <label class="settings-field"><span class="settings-field-label" data-i18n="imageFormat">格式</span><select id="imageOutputFormat" class="settings-input"><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label>
          </div></details>
          <p id="imageAuthorization" class="settings-dialog-desc"></p>
          <p id="imageDialogStatus" class="image-status" role="status" aria-live="polite"></p>
        </div>
        <div class="settings-dialog-footer"><button id="imageCloseButton" type="button" class="secondary" data-i18n="imageClose">关闭并保留草稿</button><button id="imageSubmitButton" type="submit" data-i18n="imageGenerate">生成图片</button></div>
      </form>
    </div>
`.slice(1)
};
