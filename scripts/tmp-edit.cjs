const fs = require('fs');
const p = 'K:/keepseek/src/provider/KeepseekChatViewProvider.ts';
let t = fs.readFileSync(p, 'utf8');
const from = "      undefined,\r\n      undefined,\r\n      undefined,\r\n      undefined,\r\n      this.globalStorageUri,\r\n      this.subagentRuntime,\r\n      this.approvalReviewer,\r\n      (approval, signal, verifyCurrent) => this.requestManualToolApproval(approval, signal, verifyCurrent)\r\n    );";
const to = "      undefined,\r\n      undefined,\r\n      undefined,\r\n      this.globalStorageUri,\r\n      this.subagentRuntime,\r\n      this.approvalReviewer,\r\n      (approval, signal, verifyCurrent) => this.requestManualToolApproval(approval, signal, verifyCurrent)\r\n    );";
if (!t.includes(from)) throw new Error('constructor args missing');
t = t.split(from).join(to);
fs.writeFileSync(p, t);
console.log('ok');