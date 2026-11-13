/** Identify the file actually passed to an interpreter. Unknown launcher
 * options stay reviewable as general commands; they cannot prove a file entry.
 * Once an entry is found, the interpreter passes the remaining argv literally. */
export function projectFileArgument(program: string, args: readonly string[]): number | undefined {
  const python = isPythonProgram(program);
  const node = isNodeProgram(program);
  const shell = /^(?:sh|bash|zsh)$/u.test(program);
  const bun = program === 'bun';
  if (!python && !node && !shell && !bun) return undefined;
  let index = 0;
  if (bun && args[0] === 'run' && /^(?:\.{1,2}[/\\]|[/\\]|[a-z]:[/\\])/iu.test(args[1] ?? '')) index++;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { index++; break; }
    if (!arg.startsWith('-')) break;
    if (python) {
      if (/^-[bBdEIOPqRsSuv]+$/u.test(arg)) continue;
      const next = args[index + 1];
      if (arg === '--check-hash-based-pycs' && /^(?:default|always|never)$/u.test(next ?? '')) { index++; continue; }
      if (arg === '-X' && pythonX.test(next ?? '')) { index++; continue; }
      if (arg.startsWith('-X') && pythonX.test(arg.slice(2))) continue;
      if (arg === '-W' && pythonWarning.test(next ?? '')) { index++; continue; }
      if (arg.startsWith('-W') && pythonWarning.test(arg.slice(2))) continue;
    } else if (node) {
      if (nodeSwitch.test(arg)) continue;
      if (nodeNumeric.test(arg) && /^\d+$/u.test(args[index + 1] ?? '')) { index++; continue; }
      const separator = arg.indexOf('=');
      if (separator !== -1 && nodeNumeric.test(arg.slice(0, separator)) && /^\d+$/u.test(arg.slice(separator + 1))) continue;
      if (/^--unhandled-rejections=(?:strict|throw|warn|warn-with-error-code|none)$/u.test(arg)) continue;
    } else if (shell && /^-[euxv]+$/u.test(arg)) continue;
    return undefined;
  }
  const entry = args[index];
  if (!entry || entry === '-' || isExplicitUri(entry)) return undefined;
  if (bun && !/[/\\]/u.test(entry)) return undefined; // A bare name can select a package script or an executable.
  return index;
}

const pythonX = /^(?:dev|utf8(?:=[01])?|faulthandler|tracemalloc(?:=\d+)?|warn_default_encoding|no_debug_ranges|int_max_str_digits(?:=\d+)?)$/u;
const pythonWarning = /^(?:default|error|ignore|always|all|module|once)(?::[^:]*:(?:Warning|DeprecationWarning|PendingDeprecationWarning|UserWarning|SyntaxWarning|RuntimeWarning|FutureWarning|ResourceWarning)?)?$/u;
const nodeSwitch = /^(?:--(?:enable-source-maps|no-warnings|trace-warnings|trace-uncaught|no-deprecation|trace-deprecation|use-strict|experimental-strip-types|experimental-transform-types|disable-warning=\w+|check)|-c)$/u;
const nodeNumeric = /^--(?:max-old-space-size|max-semi-space-size|stack-size|stack-trace-limit)$/u;

export function isPythonProgram(program: string): boolean {
  return /^python(?:[23](?:\.\d{1,2})?)?$/iu.test(program);
}

export function isNodeProgram(program: string): boolean {
  return /^node(?:js|\d{1,2})?$/iu.test(program);
}

export function isExplicitUri(value: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:\/\/|file:)/iu.test(value);
}

export function isExternalNetworkTarget(value: string): boolean {
  return isExplicitUri(value) && !/^file:/iu.test(value)
    && !/^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/iu.test(value);
}

export function projectPackageScript(program: string, args: readonly string[]): { name: string; index: number } | undefined {
  if (!/^(?:npm|pnpm|yarn|bun)$/u.test(program) || !['run', 'run-script'].includes(args[0])
    || !/^[\p{L}\p{N}_][\p{L}\p{N}_.:-]{0,127}$/u.test(args[1] ?? '')) return undefined;
  // npm/pnpm accept their own options until --. Yarn/Bun forward trailing
  // options, but require the same explicit separation for the verified lane.
  if (args.length > 2 && args[2] !== '--') return undefined;
  return { name: args[1], index: 1 };
}
