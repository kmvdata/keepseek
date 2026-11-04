# KeepSeek 自动批准与模型审批验收

本报告记录首轮审批改动，以 6721cf5 为实施前基线。普通本地 Git 的后续自动批准规则见 [架构文档](keepseek-code-architecture.md)。以下弹窗和 reviewer 次数按单个动作计算，人工点击、范围授权、审批结果及实际执行分别记录。

| 场景 | 实施前 | 实施后 |
| --- | --- | --- |
| 自动批准下常规工作区编辑或受支持的系统只读命令 | 0 次授权，0 次 reviewer | 0 次授权，0 次 reviewer，记录 `host_policy` |
| 自动批准下已有的固定验证 | 0 次授权，0 次 reviewer，审批绑定脚本名称 | 0 次授权，0 次 reviewer，启动前比对完整快照 |
| 自动批准下有可审查的外部命令或编辑 | 1 次范围授权，0 次 reviewer | 1 次范围授权，1 次 reviewer。已有同一有效授权时免重复弹窗 |
| 自动批准下 Agent 读取已明确引用的外部文本 | 按原引用权限读取，0 次 reviewer | 1 次 reviewer，仅提供目标和访问元数据 |
| 模型审批下的可审查编辑、命令或验证 | 1 次 reviewer | 1 次 reviewer，附实际范围、启动或文件基线信息 |
| 普通 Git、动态 shell、安装或未知脚本 | 取得精确范围授权后可由宿主批准 | 待逐项人工决定。显式外部路径需先授权。依赖项等待 |
| 确定性硬阻断 | 随入口而异 | 直接停止，显示具体原因，无执行许可 |

原范围弹窗由 `KeepseekChatViewProvider.executeDelegatedApprovals` 的命令预检触发，主要针对外部 URI、Git 隐式配置和动态脚本。固定验证由 `AgentRunner.reviewSideEffectTool` 独立审批，旧路径在 `ValidationToolService` 启动时重新读取脚本。

范围授权只授予这一动作所需的访问类型。已授权读取外部参考文件不能授权写入。精确外部读取审查不传文件正文，删除审查不传原文件正文。软拒绝后人工确认产生独立 `user_click` 记录，原拒绝继续可见。执行结果由原 Apply 或 DraftRun 管线独立记录。旧策略和旧进程的批准记录只用于审计。

## 固定验证的边界

- 验证专用工具固定运行项目的 `compile`、`lint` 或 `test`。任务初始快照纳入 `package.json`、对应的 pre/post 脚本、已识别配置、npm/Node 文件身份、工作目录、argv 和受控环境。非惯用启动形式、生命周期脚本和任务期间变化的启动快照退出自动通道。常规源码与测试文件修改可以复测。
- 验证以固定 argv 和独立环境启动，用户及全局 npm 配置被替换为空配置。项目 `.npmrc` 存在时进入单项人工确认，审批材料只含存在状态和身份。验证返回实际退出码、有限脱敏的进程输出和已有 Problems 摘要。此启动路径不运行 VS Code Task 的内建 problem matcher。
- npm 会执行项目测试、依赖与包脚本，脚本可启动子进程或访问宿主可访问的资源。配置的间接依赖、Git helpers 和 hooks、任意脚本的传递效果不具备静态穷尽性。Workspace Trust、实际路径比对及 `shell:false` 是宿主检查，进程仍使用扩展宿主的权限。POSIX 常见系统只读命令可自动批准。Windows DraftRun 采用较保守的分类，受支持的 npm Windows 启动布局仍需现场验证。
- 外部目标、有效环境和程序身份变化均使旧授权或批准失效。作用域未知时，界面显示具体原因。当前实现不把任意 shell、Git 或远端服务调用视为可自动执行。

## F5 现场验收

1. 在 KeepSeek 仓库执行 `bun run compile`，用 F5 选择 **Run KeepSeek Extension**。在 Extension Development Host 打开一个可丢弃的可信目录。用已经配置的主模型和 reviewer，确认审批菜单可切换模式。
2. 在临时项目创建下列两个文件。源仓库外的所有验收写入均放在临时目录。

   ```json
   {"private":true,"scripts":{"compile":"node --test verify.cjs","lint":"node --test verify.cjs","test":"node --test verify.cjs"}}
   ```

   ```js
   const fs = require('node:fs');
   require('node:assert/strict').equal(fs.readFileSync('result.txt', 'utf8').trim(), 'ready');
   fs.appendFileSync('runs.log', process.env.npm_lifecycle_event + '\n');
   ```

3. 选择 **自动批准 / Auto approve**。请 Agent 创建内容为 `ready` 的 `result.txt`，并按顺序使用固定验证工具执行 compile、lint、test。预期无额外点击，Run Details 出现 **宿主已批准，未经模型审查 / Host approved without model review**。检查 `runs.log` 中每项恰好出现一次，并核对 Agent 根据真实退出结果续跑。
4. 新会话选择 **模型审批 / Model review**，请 Agent 运行同一固定测试，或提交仅创建新文件的草稿。预期 Run Details 出现实际 reviewer 的模型与批准记录。停止期间更改脚本、PATH 或目标时，旧批准不能启动操作。
5. 在项目外的临时目录准备无敏感内容的文本。请 Agent 读取未引用的文件，预期停在引用授权。明确引用后重试，预期 reviewer 先收到目标元数据。请 Agent 在同一临时目录另建文件，预期出现 **授权此操作范围 / Authorize this exact scope**，再执行模型审查。检查文件只在批准后出现。
6. 在临时 Git 仓库准备 `git log --format=%s -1` 草稿，检查 **检查并确认这一次 / Review and confirm once**。取消应保持零执行，逐项确认只执行一次。用 reviewer 不可用的测试配置核对 **审批模型不可用，操作尚未执行 / Approval model unavailable; the operation did not run**。测试硬阻断可用指向临时目录中 `.ssh` 子目录的草稿，勿运行真实系统管理命令。
7. 在人工等待时切换模式、停止或重新加载扩展。确认旧按钮和批量继续不能越过暂停。恢复或重新提交后检查已有成功动作的执行次数，未知副作用需先核实原结果。

## 自动化入口

- `test/taskApprovalIntegration.test.ts` 覆盖持久化草稿、独立审批来源、单次接管、外部授权、依赖顺序和续跑。
- `test/runnerValidationState.test.ts` 用临时项目执行实际 npm 子进程并核对落盘记录。审批模型使用确定性桩，另外验证快照变化与授权外部读取。
- `test/approvalReviewer.test.ts`、`test/draftRunStore.test.ts`、`test/draftRunBatch.test.ts` 覆盖严格响应、记录消费、批量边界与双语卡片。

## 本次运行结果

- `bun run compile`、`bun run lint`、`bun run build:test` 和 `git diff --check` 通过。
- `bun run test` 共 924 项。922 项通过，1 项本地故障服务器用例因执行环境限制跳过。1 万条用量账本的既有性能基准在全量运行时实测 18.65 秒，超过 15 秒阈值。结束全量运行后单独复跑通过，测试耗时 12.22 秒。
- 临时项目中的实际验证进程分别执行 compile、lint 和 test，各写入一条完成标记。模型审批使用确定性响应桩。固定验证入口在审批后被改动时，测试确认启动标记未出现。外部写入、单次人工接管与 Git 本地临时仓库回归均通过。
- 现场调试期间 VS Code 前台回到另一个项目，未启动新版 F5 扩展宿主。真实 Webview、已配置模型请求和 Windows 启动路径仍待现场验收。
