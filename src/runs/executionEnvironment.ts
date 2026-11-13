/** Shared with scope preflight: execution must use these exact environment rules. */
export function createControlledEnvironment(entries: readonly { name: string; value: string }[]): NodeJS.ProcessEnv {
  const allowedNames = [
    'PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR',
    'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'SHELL', 'TERM', 'COLORTERM'
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowedNames) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  for (const entry of entries) {
    env[entry.name] = entry.value;
  }
  return env;
}
