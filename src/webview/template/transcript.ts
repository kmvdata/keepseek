import type { WebviewTemplateFragment } from './composition';

/** 对话区容器开头。 */
export const transcriptOpenFragment: WebviewTemplateFragment = {
  id: 'template.transcript.open',
  source: `
    <section id="transcript" class="transcript">
`
};

/** 对话区空状态提示。 */
export const transcriptEmptyFragment: WebviewTemplateFragment = {
  id: 'template.transcript.empty',
  source: `
      <div class="transcript-empty">
        <div class="transcript-empty-icon">&#x2726;</div>
        <div data-i18n="startChat">开始 KeepSeek 对话</div>
        <div style="font-size:11px;opacity:0.6" data-i18n="emptyTranscriptHint">添加上下文文件后，输入消息并发送</div>
      </div>
`
};