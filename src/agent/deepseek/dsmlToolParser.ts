import { DeepSeekToolCall, ParsedDsmlToolCalls } from './types';

interface DsmlCloseTag {
  index: number;
  endIndex: number;
}

export class DsmlToolParser {
  public parse(content: string): ParsedDsmlToolCalls | undefined {
    if (!content.includes('DSML')) {
      return undefined;
    }

    const normalized = this.normalizeDsmlMarkers(content);
    const blockStartMatch = /<\|+DSML\|+tool_calls>/iu.exec(normalized);
    if (!blockStartMatch || blockStartMatch.index === undefined) {
      return undefined;
    }

    const blockStart = blockStartMatch.index;
    const blockContentStart = blockStart + blockStartMatch[0].length;
    const blockCloseMatch = /(?:<\/\|+DSML\|+tool_calls>|\|+DSML\|+tool_calls)/iu.exec(normalized.slice(blockContentStart));
    if (!blockCloseMatch || blockCloseMatch.index === undefined) {
      return undefined;
    }

    const blockContentEnd = blockContentStart + blockCloseMatch.index;
    const blockEnd = blockContentEnd + blockCloseMatch[0].length;
    const blockContent = normalized.slice(blockContentStart, blockContentEnd);
    const toolCalls = this.parseInvocations(blockContent);
    if (!toolCalls.length) {
      return undefined;
    }

    return {
      content: `${content.slice(0, blockStart)}${content.slice(blockEnd)}`.trim(),
      toolCalls
    };
  }

  private parseInvocations(blockContent: string): DeepSeekToolCall[] {
    const toolCalls: DeepSeekToolCall[] = [];
    const invokePattern = /<\|+DSML\|+invoke\b([^>]*)>/giu;
    let invokeMatch: RegExpExecArray | null;

    while ((invokeMatch = invokePattern.exec(blockContent)) !== null) {
      const name = this.readAttribute(invokeMatch[1] ?? '', 'name');
      if (!name) {
        continue;
      }

      const bodyStart = invokeMatch.index + invokeMatch[0].length;
      const closeTag = this.findCloseTag(blockContent, 'invoke', bodyStart);
      const bodyEnd = closeTag?.index ?? blockContent.length;
      const args = this.parseParameters(blockContent.slice(bodyStart, bodyEnd));
      toolCalls.push({
        id: `dsml-tool-call-${toolCalls.length}`,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args)
        }
      });

      if (closeTag) {
        invokePattern.lastIndex = closeTag.endIndex;
      }
    }

    return toolCalls;
  }

  private parseParameters(invokeBody: string): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    const parameterPattern = /<\|+DSML\|+parameter\b([^>]*)>/giu;
    let parameterMatch: RegExpExecArray | null;

    while ((parameterMatch = parameterPattern.exec(invokeBody)) !== null) {
      const attributes = parameterMatch[1] ?? '';
      const name = this.readAttribute(attributes, 'name');
      if (!name) {
        continue;
      }

      const bodyStart = parameterMatch.index + parameterMatch[0].length;
      const closeTag = this.findCloseTag(invokeBody, 'parameter', bodyStart);
      if (!closeTag) {
        break;
      }

      const rawValue = invokeBody.slice(bodyStart, closeTag.index);
      const isString = this.readAttribute(attributes, 'string') !== 'false';
      args[name] = isString ? this.decodeText(rawValue) : this.parseJsonValue(rawValue);
      parameterPattern.lastIndex = closeTag.endIndex;
    }

    return args;
  }

  private findCloseTag(content: string, tagName: 'invoke' | 'parameter', startIndex: number): DsmlCloseTag | undefined {
    const closePattern = new RegExp(`(?:<\\/\\|+DSML\\|+${tagName}>|\\|+DSML\\|+${tagName})`, 'iu');
    const match = closePattern.exec(content.slice(startIndex));
    if (!match || match.index === undefined) {
      return undefined;
    }

    const index = startIndex + match.index;
    return {
      index,
      endIndex: index + match[0].length
    };
  }

  private normalizeDsmlMarkers(content: string): string {
    return content.replace(/\uFF5C/gu, '|');
  }

  private readAttribute(attributes: string, name: string): string | undefined {
    const doubleQuoted = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'u').exec(attributes);
    if (doubleQuoted) {
      return this.decodeText(doubleQuoted[1]);
    }

    const singleQuoted = new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'u').exec(attributes);
    return singleQuoted ? this.decodeText(singleQuoted[1]) : undefined;
  }

  private decodeText(value: string): string {
    return value
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'")
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&amp;/gu, '&');
  }

  private parseJsonValue(value: string): unknown {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
}
