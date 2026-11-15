const fs = require('fs');
const p = 'K:/keepseek/test/runnerValidationState.test.ts';
let t = fs.readFileSync(p, 'utf8');
const pairs = [
  ["import type { ToolAuthorizationAdapter } from '../src/agent/tools/toolAuthorization';\r\n", ''],
  ['  RunAuthorizationPolicy,\r\n', ''],
  [
    'new AgentRunner(undefined, undefined, new ValidationToolService(), undefined, undefined, undefined,\r\n',
    'new AgentRunner(undefined, undefined, new ValidationToolService(), undefined, undefined,\r\n'
  ]
];
for (const [from, to] of pairs) {
  if (!t.includes(from)) throw new Error('missing: ' + JSON.stringify(from.slice(0, 90)));
  t = t.split(from).join(to);
}
fs.writeFileSync(p, t);
console.log('ok');