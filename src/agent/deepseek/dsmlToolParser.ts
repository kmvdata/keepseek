import { DeepSeekToolCall, ParsedDsmlToolCalls } from './types';
import { ProviderStreamProtocolError } from '../providers/streamErrors';

interface DsmlCloseTag {
  index: number;
  endIndex: number;
}

export class DsmlToolParser {
  public parse(content: string): ParsedDsmlToolCalls | undefined {
    if (!/DSML/iu.test(content)) {
      return undefined;
    }

    const normalized = this.normalizeDsmlMarkers(content);
    // Examples in code are text, never a request to execute a tool. Mask only
    // for outer marker discovery; parameter values retain their original bytes.
    const toolCalls: DeepSeekToolCall[] = [];
    const visibleParts: string[] = [];
    let cursor = 0;
    for (;;) {
      const active = normalized.slice(cursor).replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/gu,
        (example) => ' '.repeat(example.length));
      const marker = /(?:<\/?\|+DSML\|+|(?<![<|/])(?<!&lt;)\|+DSML\|+)(?:tool_calls|invoke|parameter)\b/iu.exec(active);
      if (!marker) break;
      const blockStart = cursor + marker.index;
      const opening = /^<\|+DSML\|+tool_calls>/iu.exec(normalized.slice(blockStart));
      if (!opening) this.invalid('Malformed or orphan DSML tool marker.');
      const bodyStart = blockStart + opening[0].length;
      const close = this.findCloseTag(normalized, 'tool_calls', bodyStart);
      if (!close) this.invalid('DSML tool block is not closed.');
      const calls = this.parseInvocations(normalized.slice(bodyStart, close.index));
      if (!calls.length) this.invalid('DSML tool block contains no complete invocations.');
      for (const call of calls) {
        call.id = `dsml-tool-call-${toolCalls.length}`;
        toolCalls.push(call);
      }
      visibleParts.push(content.slice(cursor, blockStart));
      cursor = close.endIndex;
    }
    if (!toolCalls.length) return undefined;
    visibleParts.push(content.slice(cursor));
    return { content: visibleParts.join('').trim(), toolCalls };
  }

  private parseInvocations(blockContent: string): DeepSeekToolCall[] {
    const toolCalls: DeepSeekToolCall[] = [];
    let cursor = 0;
    while (cursor < blockContent.length) {
      cursor += /^\s*/u.exec(blockContent.slice(cursor))![0].length;
      if (cursor === blockContent.length) break;
      const invokeMatch = /^<\|+DSML\|+invoke\b([^>]*)>/iu.exec(blockContent.slice(cursor));
      if (!invokeMatch) this.invalid('Malformed DSML invocation.');
      const name = this.readAttribute(invokeMatch[1] ?? '', 'name');
      if (!name?.trim() || name !== name.trim()) this.invalid('DSML invocation name is missing or invalid.');

      const bodyStart = cursor + invokeMatch[0].length;
      const closeTag = this.findCloseTag(blockContent, 'invoke', bodyStart);
      if (!closeTag) this.invalid('DSML invocation is not closed.');
      const args = this.parseParameters(blockContent.slice(bodyStart, closeTag.index));
      toolCalls.push({
        id: `dsml-tool-call-${toolCalls.length}`,
        type: 'function',
        function: {
          name,
          arguments: JSON.stringify(args)
        }
      });

      cursor = closeTag.endIndex;
    }

    return toolCalls;
  }

  private parseParameters(invokeBody: string): Record<string, unknown> {
    const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let cursor = 0;
    while (cursor < invokeBody.length) {
      cursor += /^\s*/u.exec(invokeBody.slice(cursor))![0].length;
      if (cursor === invokeBody.length) break;
      const parameterMatch = /^<\|+DSML\|+parameter\b([^>]*)>/iu.exec(invokeBody.slice(cursor));
      if (!parameterMatch) this.invalid('Malformed DSML parameter.');
      const attributes = parameterMatch[1] ?? '';
      const name = this.readAttribute(attributes, 'name');
      if (!name?.trim() || name !== name.trim() || Object.hasOwn(args, name)) this.invalid('DSML parameter name is missing, invalid or duplicated.');

      const bodyStart = cursor + parameterMatch[0].length;
      const closeTag = this.findCloseTag(invokeBody, 'parameter', bodyStart);
      if (!closeTag) this.invalid('DSML parameter is not closed.');

      const rawValue = invokeBody.slice(bodyStart, closeTag.index);
      if (/<\/?\|+DSML\|+(?:tool_calls|invoke|parameter)\b/iu.test(rawValue)) this.invalid('Nested DSML parameter markers are invalid; literal markers must be escaped.');
      const stringAttribute = this.readAttribute(attributes, 'string');
      if (stringAttribute !== undefined && !['true', 'false'].includes(stringAttribute)) this.invalid('DSML string attribute is invalid.');
      const isString = stringAttribute !== 'false';
      args[name] = isString ? this.decodeText(rawValue) : this.parseJsonValue(rawValue);
      cursor = closeTag.endIndex;
    }

    return args;
  }

  private findCloseTag(content: string, tagName: 'tool_calls' | 'invoke' | 'parameter', startIndex: number): DsmlCloseTag | undefined {
    const closePattern = new RegExp(`(?:<\\/\\|+DSML\\|+${tagName}>|(?<![<|/])(?<!&lt;)\\|+DSML\\|+${tagName}\\b>?)`, 'iu');
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
    const values = new Map<string, string>();
    let cursor = 0;
    while (cursor < attributes.length) {
      const whitespace = /^\s*/u.exec(attributes.slice(cursor))![0].length;
      if (cursor > 0 && !whitespace) this.invalid('DSML attributes must be separated by whitespace.');
      cursor += whitespace;
      if (cursor === attributes.length) break;
      const attribute = /^([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(attributes.slice(cursor));
      if (!attribute || values.has(attribute[1])) this.invalid('DSML attributes are malformed or duplicated.');
      values.set(attribute[1], this.decodeText(attribute[2] ?? attribute[3]));
      cursor += attribute[0].length;
    }
    return values.get(name);
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
    try {
      return JSON.parse(trimmed);
    } catch {
      this.invalid('DSML parameter marked string="false" contains invalid JSON.');
    }
  }

  private invalid(message: string): never {
    throw new ProviderStreamProtocolError(message);
  }
}
