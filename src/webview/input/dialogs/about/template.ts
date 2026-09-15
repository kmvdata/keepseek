import type { WebviewFragment } from '../../composition';

export const aboutTemplateFragment: WebviewFragment = {
  id: 'template.dialogs.about',
  source: `
    <div id="aboutDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog" role="dialog" aria-label="关于 KeepSeek" data-i18n-aria-label="aboutDialogLabel">
        <div class="settings-dialog-header">
          <span class="settings-dialog-title" data-i18n="aboutDialogTitle">关于 KeepSeek</span>
        </div>
        <div class="settings-dialog-body">
          <p class="settings-dialog-desc" data-i18n="aboutDialogDesc">KeepSeek 是一款面向 VS Code 的 AI 编程上下文助手，强调显式上下文、文件引用和安全修改草案。</p>
          <div class="about-details">
            <div class="about-row">
              <span class="about-label" data-i18n="aboutProductLabel">产品</span>
              <span id="aboutProductValue" class="about-value">KeepSeek</span>
            </div>
            <div class="about-row">
              <span class="about-label" data-i18n="aboutVersionLabel">版本</span>
              <span id="aboutVersionValue" class="about-value">v0.0.0</span>
            </div>
            <div class="about-row">
              <span class="about-label" data-i18n="aboutAuthorLabel">作者 / 维护者</span>
              <span id="aboutAuthorValue" class="about-value">kmvdata</span>
            </div>
            <div class="about-row">
              <span class="about-label" data-i18n="aboutLicenseLabel">许可证</span>
              <span id="aboutLicenseValue" class="about-value">MIT</span>
            </div>
            <div class="about-row">
              <span class="about-label" data-i18n="aboutRepositoryLabel">源码</span>
              <span id="aboutRepositoryValue" class="about-value">https://github.com/kmvdata/keepseek</span>
            </div>
            <div class="about-row">
              <span class="about-label" data-i18n="aboutCopyrightLabel">版权</span>
              <span id="aboutCopyrightValue" class="about-value">Copyright (c) 2026 kmvdata</span>
            </div>
          </div>
        </div>
        <div class="settings-dialog-footer">
          <button id="aboutCloseBtn" type="button" data-i18n="close">关闭</button>
        </div>
      </div>
    </div>

`.slice(1)
};

