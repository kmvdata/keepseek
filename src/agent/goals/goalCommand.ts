import { MAX_GOAL_OBJECTIVE_CHARACTERS } from './goalTypes';

export type GoalCommand =
  | { kind: 'create'; raw: string; objective: string }
  | { kind: 'status'; raw: string }
  | { kind: 'pause'; raw: string }
  | { kind: 'resume'; raw: string }
  | { kind: 'stop'; raw: string }
  | { kind: 'clear'; raw: string }
  | { kind: 'amend'; raw: string; instruction: string }
  | { kind: 'error'; raw: string; code: 'unexpected_arguments' | 'missing_amendment' | 'too_long'; message: string };

export type GoalCommandParseResult = { recognized: false; text: string } | { recognized: true; command: GoalCommand };

const RESERVED = new Set(['status', 'pause', 'resume', 'stop', 'clear', 'amend']);

/** Host-authoritative `/goal` parser. It changes only the existing outer trim
 * boundary; command matching never normalizes Unicode or internal newlines. */
export function parseGoalCommand(input: string, maxCharacters = MAX_GOAL_OBJECTIVE_CHARACTERS): GoalCommandParseResult {
  const raw = input.trim();
  if (!/^\/goal(?=$|\s)/iu.test(raw)) return { recognized: false, text: raw };

  const remainder = raw.slice(5).replace(/^\s+/u, '');
  if (!remainder) return { recognized: true, command: { kind: 'status', raw } };

  const firstWhitespace = remainder.search(/\s/u);
  const token = (firstWhitespace < 0 ? remainder : remainder.slice(0, firstWhitespace)).toLocaleLowerCase('en-US');
  const argumentsText = firstWhitespace < 0 ? '' : remainder.slice(firstWhitespace).replace(/^\s+/u, '');

  if (token === 'amend') {
    if (!argumentsText) {
      return { recognized: true, command: { kind: 'error', raw, code: 'missing_amendment', message: '`/goal amend` requires an instruction.' } };
    }
    if (argumentsText.length > maxCharacters) return tooLong(raw, maxCharacters);
    return { recognized: true, command: { kind: 'amend', raw, instruction: argumentsText } };
  }

  if (RESERVED.has(token)) {
    if (argumentsText) {
      return { recognized: true, command: {
        kind: 'error', raw, code: 'unexpected_arguments',
        message: `\`/goal ${token}\` does not accept additional arguments.`
      } };
    }
    return { recognized: true, command: { kind: token as 'status' | 'pause' | 'resume' | 'stop' | 'clear', raw } };
  }

  if (remainder.length > maxCharacters) return tooLong(raw, maxCharacters);
  return { recognized: true, command: { kind: 'create', raw, objective: remainder } };
}

function tooLong(raw: string, maxCharacters: number): GoalCommandParseResult {
  return { recognized: true, command: {
    kind: 'error', raw, code: 'too_long', message: `Goal text exceeds the ${maxCharacters.toLocaleString('en-US')} character limit.`
  } };
}
