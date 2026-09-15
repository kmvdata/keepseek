import type { WebviewFragment } from '../composition';

export const referenceMentionFragment: WebviewFragment = {
  id: 'references.mention',
  source: `
      function getSkillTrigger() {
        var selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) { return null; }
        var range = selection.getRangeAt(0);
        if (!isRangeInsidePrompt(range) || isPromptRangeInsideMarkdownFence(range)) { return null; }
        var textBefore = getTextBeforeRange(range);
        var triggerIndex = findSkillTriggerIndex(textBefore);
        if (triggerIndex < 0) { return null; }
        var skillRange = getPromptTextRange(triggerIndex, textBefore.length);
        if (!skillRange) { return null; }
        return {
          range: skillRange,
          query: textBefore.slice(triggerIndex + 1)
        };
      }

      function findSkillTriggerIndex(textBefore) {
        for (var i = textBefore.length - 1; i >= 0; i--) {
          var character = textBefore.charAt(i);
          if (character === '$') {
            var previous = i > 0 ? textBefore.charAt(i - 1) : '';
            return !previous || isWhitespace(previous) ? i : -1;
          }
          if (isSkillTerminator(character)) {
            return -1;
          }
        }
        return -1;
      }

      function isSkillTerminator(character) {
        return character === '<' || character === '>' || character === String.fromCharCode(10) || character === String.fromCharCode(13) || isWhitespace(character);
      }

      function getMentionTrigger() {
        var selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) { return null; }
        var range = selection.getRangeAt(0);
        if (!isRangeInsidePrompt(range)) { return null; }
        var textBefore = getTextBeforeRange(range);
        var triggerIndex = findMentionTriggerIndex(textBefore);
        if (triggerIndex < 0) { return null; }
        var mentionRange = getPromptTextRange(triggerIndex, textBefore.length);
        if (!mentionRange) { return null; }
        return {
          range: mentionRange,
          query: textBefore.slice(triggerIndex + 1)
        };
      }

      function findMentionTriggerIndex(textBefore) {
        for (var i = textBefore.length - 1; i >= 0; i--) {
          var character = textBefore.charAt(i);
          if (character === '@') {
            return i;
          }
          if (isMentionTerminator(character)) {
            return -1;
          }
        }
        return -1;
      }

      function isMentionTerminator(character) {
        return character === '<' || character === '>' || character === String.fromCharCode(10) || character === String.fromCharCode(13) || isWhitespace(character);
      }

`.slice(1)
};

