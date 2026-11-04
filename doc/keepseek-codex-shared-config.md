# KeepSeek 与 Codex 共享项目配置：实施与验收报告

实施基线：KeepSeek `047d242`、`0.5.1`，开始时工作区干净；未提交 Git、未升版本、未安装扩展、未生成或发布市场包。核对日期：2026-11-04（Asia/Shanghai；宿主 UTC 为 2026-11-03）。

本次实现共享文件读取、标准 Skill 创建及旧入口删除。它不是 Codex 运行时移植。KeepSeek 不读取 Codex 账号、凭据、会话库，不提供 MCP 运行时、Codex 私有工具或 hooks；审批、工具权限、子代理隔离均由 KeepSeek 自己执行。

## 1. 选定目标与证据

可执行验收目标是本机 **codex-cli 0.133.0**。文件格式依据核对日的公开文档；在线文档是滚动页面，不能当作 0.133.0 的不可变发布规范。发生差异时记录本机实际行为，不增加多代兼容搜索。

| 官方来源 | 本次用途 |
| --- | --- |
| [Skills](https://developers.openai.com/codex/skills)（跳转 [Build skills](https://learn.chatgpt.com/docs/build-skills)） | 本地目录、必填字段、同名 Skill、openai.yaml、隐式资格、禁用选择器 |
| [AGENTS.md](https://developers.openai.com/codex/guides/agents-md) | 全局与 root→cwd 指令链、override、fallback、字节上限 |
| [Config basics](https://developers.openai.com/codex/config-basic) | 用户/可信项目层级、CODEX_HOME |
| [Config reference](https://developers.openai.com/codex/config-reference) | 本次 TOML 白名单，不映射其他运行时设置 |
| [MCP](https://developers.openai.com/codex/mcp) | 明确依赖声明与实际连接能力的区别 |
| [官方 skills_config.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/skills_config.rs) | 规则顺序及 user/session 层筛选；这是 main 源码旁证，不是锁定 tag |

**实测差异：**0.133.0 的 `config/read` 能显示项目 `skills.config`，但 `skills/list` 不执行这些项目禁用规则。用户配置中的同一规则有效。KeepSeek 因而对非空项目 `skills.config` 显示具体诊断并阻止所有 Skill 激活，要求把规则写到用户配置；不把它标成“共享禁用已生效”。这是显式的安全限制，并非完整项目禁用兼容。

已运行 `node scripts/check-codex-shared-config.cjs`。脚本只在临时目录写测试文件，启动隔离 CODEX_HOME 的真实 app-server，调用 `initialize`、`skills/list`、`config/read`；不发 `turn/start`，不连接 MCP，不读取或改写真实用户配置。它验证两端发现相同名称/路径、KeepSeek 模板可被 Codex 读取、YAML 的 display_name 被 Codex 解析、用户禁用一致、fallback 数组替换及上述项目规则差异。0.133.0 的 skills/list 不公开 policy 字段，故该探针**不证明** Codex 的实际隐式模型选择；该项保留现场验收。

## 2. 配置兼容矩阵

| 路径/字段 | KeepSeek 支持程度与差异 | 自动化证据 |
| --- | --- | --- |
| `<cwd→git-root>/.agents/skills/**/SKILL.md` | 支持标准 skills 容器内有界递归；每个找到的 Skill 根停止继续探测子 Skill。AGENTS.md 不作为 Skill；不泛扫 `.agents` | skillDiscovery、projectInstructions |
| `~/.agents/skills` | 使用扩展宿主的 home；不受 CODEX_HOME 改写 | skillDiscovery、路径测试 |
| `/etc/codex/skills` | Unix 管理员目录；Windows 不默认扫描管理员来源 | admin fixture；未做原生 Windows 验收 |
| `~/.codex/skills`、插件缓存、内置 Skill 缓存 | 不读取；不复制 Codex 私有安装资源 | 旧目录负例 |
| 相同物理文件/同名不同路径 | realpath 去重；同名保留，列表显示实际目录。无来源的隐式匹配遇歧义不选；显式 URI/ID 可以分别选择 | skillDiscovery、skillActivationResolver |
| SKILL.md YAML `name`、`description` | 必填非空字符串，上限 64/1024 字符；多行/引号/注释/UTF-8 可用，错误 Skill 可见但不可激活 | YAML 测试、真实 CLI 模板读取 |
| `agents/openai.yaml interface` | 白名单解析显示名、简介、图标路径、颜色、默认 prompt。显示名只用于 UI；图标/默认 prompt 不自动加载或执行 | YAML 测试、CLI displayName |
| `policy.allow_implicit_invocation` | 唯一文件级隐式策略；缺省 true，false 仍可显式/会话选择。创建 UI 的初始选择为 false，并明确写入 YAML | activation、creator；Codex 模型行为待验 |
| `dependencies.tools` | 识别 type/value/description；MCP 和其他未接入依赖阻止激活，显示具体依赖，可 Open 文件。transport/url 不转成连接 | metadata/loader 负例；无新增 MCP 客户端 |
| `$CODEX_HOME/config.toml` | 默认 `~/.codex/config.toml`，白名单只读；CODEX_HOME 必须是绝对路径 | config/path 测试、CLI |
| 可信项目 `.codex/config.toml` | Git root→cwd 合并受支持文档字段；较近目录覆盖标量，数组整体替换，不拼接。VS Code 未信任时不加载项目层 | config/trust 测试、CLI fallback |
| 用户 `skills.config` | enabled 布尔值；每项恰好 name 或绝对 SKILL.md path；name 匹配全部同名，path 匹配规范物理文件；最后匹配规则生效，保留来源 | config/activation、CLI 用户禁用 |
| 项目 `skills.config` | **不作为有效规则执行**，非空时诊断并阻止激活；0.133.0 实测忽略它，不能承诺两端项目禁用等价 | CLI 探针、fail-closed 测试 |
| `project_doc_fallback_filenames` | 简单文件名数组，拒绝路径穿越；仅项目目录在 override/AGENTS 都无非空内容时使用 | fallback、空文件测试 |
| `project_doc_max_bytes` | 非负整数，默认 32768；本实现对全局与项目指令正文合计按 UTF-8 字节裁剪，不切坏字符；另受单文件读保护限制 | 字节/中文/emoji 测试 |
| 全局 `AGENTS.override.md` / `AGENTS.md` | CODEX_HOME 内按该顺序选首个非空文件；读取失败不偷偷回退低优先级文件 | projectInstructions |
| 项目 root→cwd 指令链 | 每目录 override→AGENTS→fallback，保留顺序与来源；不读无关子目录。`.git` 文件支持 worktree；无 Git 只用 cwd | worktree/subdir/multiroot 测试 |
| `project_root_markers`、profile、系统/托管配置层、CLI flags | 未接入；只采用 `.git` 边界，不复现 Codex 全部优先级 | 本矩阵边界；未知字段共存测试 |
| model/provider/approval_policy/sandbox_mode/rules/hooks | 合法 TOML 可共存，绝不映射为 KeepSeek 账号、权限或执行动作 | 白名单/保密测试；既有审批回归 |
| YAML aliases、自定义 tags、过深/过大结构 | 保守拒绝；不构造自定义对象、不展开别名。TOML 语法或支持字段错误可见且阻止 Skill 激活，绝不全部启用 | parser 负例与超限测试 |
| 符号链接 | 支持来源边界内链接，防循环、重复、读取期间替换与发现后替换；外部目标拒绝，不自动授权。此限制比 Codex 普通扫描严格 | symlink/loader 测试 |
| Remote / WSL | 扩展在远端运行时使用远端宿主 Node home/文件路径。不能安全 realpath 的虚拟 URI 标为不可用，不拿本机 home 替代 | virtual URI 负例；原生 Remote/WSL 未实测 |

标准“具有隐式调用资格”与 KeepSeek 的有界关键词匹配算法不同。选择优先级仍为显式→会话→工作区默认→隐式；后面三种选择都不能突破共享配置禁用。普通共享 Skill 无需任何 KeepSeek 私有字段，不保证两个模型在同一 prompt 下选中相同 Skill。

## 3. 实现、删除与保留

新增 `context/sharedConfigPaths.ts`、`sharedCodexConfig.ts`、`sharedProjectSources.ts` 集中管理路径、可信配置、来源快照与监听；新增 `skills/skillMetadata.ts` 使用 `yaml@2.8.4` 和 `confbox@0.2.4` 的 TOML 解析器。依赖锁和 VSIX 依赖包含清单同步更新；本次没有运行打包。

| 删除/替换内容 | 结果/理由 |
| --- | --- |
| 任意 `.agents` 扫描、AGENTS.md Skill、旧用户目录 | 只接受共享标准位置，无兼容回退 |
| 手写 frontmatter 解析、缺字段目录名/首行兜底 | 换成可靠 YAML，非法条目显示错误 |
| `metadata.keepseek.allowImplicit`、userInvocable、启用/隐式本地覆盖及消息/UI | 标准文件为权威，无隐藏双写副本 |
| `keepseek.projectInstructions.contextBudgetTokens` | 用共享字节预算替代，删除重复设置 |
| `src/memory/*`、迁移/导出/完成/回滚消息、启动与保存监听、相关 UI/文案/测试 | 新项目不再自动读取或迁移旧 Memory |
| 同名去重、旧重复 Skill 冲突生成逻辑 | 按物理身份去重，歧义显式处理 |
| 根目录唯一指令规则、相关旧测试 | 换成全局与明确任务作用域的分层规则 |

保留：`metadata.keepseek.runAs: subagent` 及同一命名空间的 `profile/tools/maxSteps/timeoutMs/canDelegate/resultMaxChars`。这些仍被隔离 child profile 使用，是 KeepSeek 的可选扩展，Codex 不保证理解；有效工具集合仍与 host lane 权限相交。工作区默认/会话 Skill 选择、匹配数量与正文预算属于 KeepSeek 自己的运行时偏好，不能改共享启用策略。

保留历史 `legacy-memory` Run Details 类型、normalizer 与审计标签，目的是显示已经保存的旧记录；没有当前 Memory 读取或注入路径。会话、审批、evidence、DraftRun、ChangeSet、checkpoint 的历史安全读取/恢复未删除。协议 V1–V11 静态 system 中两条旧优先级措辞保持原字节（包含 Legacy Memory 名称），避免静默改变冻结前缀；这不意味着继续加载 Memory。工具 schema、工具名称、协议版本均未改变。

Provider 只做编排。创建生成 SKILL.md 和 agents/openai.yaml 的同一待确认 ChangeSet，沿用 SafeFileEditor 的哈希/冲突/journal/read-back；重复点击只创建一个提案。**现有 ChangeSet 是逐文件 Apply，不是跨文件事务**：冲突时可能部分成功，状态必须逐文件检查，用户应完成或撤销整组后使用该 Skill；没有声称部分成功等于整组完成。

## 4. 作用域、刷新与安全

单根默认 workspace folder；多根先在命令菜单或 `KeepSeek: Select Task Directory / 选择任务目录` 选择一个工作区内目录。会话保存 `projectScopeUri`，不从焦点或附件猜 cwd。打开仓库子目录仍能找到上层 Git/worktree 根；此读取范围只用于共享上下文，不授予外部命令 cwd 或脚本执行权限。

一次逻辑任务沿用已解析快照。文件监听/保存/Apply 仅标记变化，在空闲的显式 Skills 刷新或下个真实新任务边界重读；自动命令继续、审批继续、计划执行、修复和 no-progress 继续不按工具轮重扫。配置内容不进入静态 system；旧 user 和稳定 `contextInstructions` 不回写，已有受控动态上下文尾部继续承担新字节交付。刷新不新建 epoch 循环、不执行任何脚本。

Skills 菜单显示当前目录、文档字节预算、fallback、配置来源、诊断及 Skill 来源/禁用原因。Run Details 显示实际指令 URI、作用域、顺序、hash、截断/丢弃。白名单以外的 TOML 内容（含潜在密钥）不输出到 Webview/prompt/trace；解析器错误不打印原文片段。

读取上限：TOML 1 MiB，YAML 元数据 64 KiB / 4096 节点 / 32 层，目录遍历每个标准根最多 6 层/2000 目录/20000 条目；资源最多 12 项/48000 字符，并遵守单文件保护。`project_doc_max_bytes`、Skill 字符预算、整体上下文准入是不同阶段，UI 不把它们伪装成同一 Codex 设置。

## 5. 自动化与现场状态

验证命令：

```bash
bun run compile
bun run lint
bun run build:test
bun run test
node scripts/check-codex-shared-config.cjs
```

最终结果如下。新增/扩展测试覆盖标准及旧路径负例、CODEX_HOME、worktree/无 Git/多根、YAML/TOML 类型和容量、策略与禁用、同名和链接、全局/局部指令、未信任、创建 Apply/冲突/取消/重复点击、快照与三协议 usage、子代理顺序、Memory 入口删除和旧会话审计。

已完成真实本地 Codex 离线发现/config 检查。未进行真实模型推理、VS Code Webview 鼠标/键盘手工验收、真实 Codex `$skill` 加载轨迹、Windows/WSL/Remote 实机验收；不把 mocked Provider 测试说成两端模型实测。依赖在线安装因终端 DNS 受限未成功，使用本机已缓存的精确版本完成构建与运行；锁中记录了对应完整性摘要。

## 6. 全新临时项目现场验收

以下是 **待现场执行** 的操作步骤；不改真实用户目录。先完成上面的编译。macOS/Linux 创建夹具：

```bash
fixture_dir=$(mktemp -d /tmp/keepseek-share-field.XXXXXX)
export KEEPSEEK_FIELD_ROOT="$fixture_dir"
python3 - <<'PY'
import os, pathlib, json
root = pathlib.Path(os.environ['KEEPSEEK_FIELD_ROOT']).resolve()
repo = root / 'repo'; home = root / 'codex-home'
for p in [repo / '.git', repo / '.codex', repo / 'module', home, repo / '.agents/skills/shared-review/agents']:
    p.mkdir(parents=True, exist_ok=True)
(repo / 'AGENTS.md').write_text('Project marker: ROOT_SHARED. Report evidence before conclusions.\n')
(home / 'AGENTS.md').write_text('Global marker: GLOBAL_SHARED.\n')
(repo / 'module/AGENTS.override.md').write_text('Local marker: LOCAL_OVERRIDE. Scope is module only.\n')
(repo / '.codex/config.toml').write_text('project_doc_max_bytes = 32768\nproject_doc_fallback_filenames = ["TEAM.md"]\n')
(home / 'config.toml').write_text('[projects.' + json.dumps(str(repo)) + ']\ntrust_level="trusted"\n')
skill = repo / '.agents/skills/shared-review'
(skill / 'SKILL.md').write_text('---\nname: shared-review\ndescription: Review shared configuration evidence.\n---\nRead AGENTS.md in the task scope. Report the exact Skill source and evidence.\n')
(skill / 'agents/openai.yaml').write_text('interface:\n  display_name: Shared Review\npolicy:\n  allow_implicit_invocation: true\n')
print(root)
PY
git -C "$fixture_dir/repo" init --quiet
```

1. 用同一个 CODEX_HOME 和 cwd 启动两个宿主。可使用独立 VS Code 开发窗口（不安装扩展）：

   ```bash
   CODEX_HOME="$fixture_dir/codex-home" code --new-window \
     --user-data-dir "$fixture_dir/vscode-profile" \
     --extensionDevelopmentPath=/Users/kermit/Projects/kmvdata/deepseek/keepseek \
     "$fixture_dir/repo"
   cd "$fixture_dir/repo"
   CODEX_HOME="$fixture_dir/codex-home" codex
   ```

   VS Code 首次明确信任该临时项目。若没有 `code` 命令，按项目 F5 流程启动，确保扩展宿主继承这个 CODEX_HOME；不能只修改一个已运行窗口的终端环境。

2. KeepSeek `/`→Skills，核对 `Shared Review (shared-review)`、完整来源和任务目录；Codex `/skills` 核对同一真实 name/path。KeepSeek 发送显式选择的 Skill 引用，查看 Run Details 中 Skill URI/hash、激活来源 explicit 和全局/根指令。Codex 用 `$shared-review`，核对实际 Skill 文件读取或结构化 Skill 输入事件；只有模型说“已加载”不算通过。

3. 编辑共享 YAML 把 `allow_implicit_invocation` 改为 false。KeepSeek 空闲时重新打开 Skills 菜单刷新，Codex 新会话/重启。非显式相关 prompt 不应隐式加载该 Skill；显式选择仍可加载。KeepSeek 的会话选中项属于显式用户偏好，应先取消再测试隐式分支。

4. 在 **夹具用户配置** 追加禁用（不写真实 `~/.codex/config.toml`）：

   ```bash
   python3 - <<'PY'
   import os, pathlib
   p = pathlib.Path(os.environ['KEEPSEEK_FIELD_ROOT']) / 'codex-home/config.toml'
   with p.open('a') as f:
       f.write('\n[[skills.config]]\nname="shared-review"\nenabled=false\n')
   PY
   ```

   两端重启/刷新，验证禁用来源和显式/会话选择无法绕过。若把规则误放项目 `.codex/config.toml`，预期 Codex 0.133.0 忽略、KeepSeek 报错阻止激活；这一步用于展示差异，不能记为项目禁用兼容通过。后续创建测试先手动删除夹具中的禁用条目。

5. KeepSeek 选择 `$fixture_dir/repo/module` 作为任务目录；Codex 从同一目录启动。检查 GLOBAL_SHARED→ROOT_SHARED→LOCAL_OVERRIDE 的实际指令证据；切回根任务不应包含局部标记。在 module 放空 override + AGENTS、或移走两者写 TEAM.md，分别检查优先级。多根加入第二个无关项目后，选择一个目录，确认不混入另一个项目。

6. KeepSeek 创建 `from-keepseek`，查看两个标准文件的 Diff，Apply 整组，核对两个文件实际落盘及组状态，再在 Codex `/skills` 发现相同来源。在 Codex 明确请求创建 `.agents/skills/from-codex/SKILL.md`（有 name/description，可选标准 YAML），确认真实文件修改后，在 KeepSeek 刷新发现。不要通过复制到第二个目录完成验收。分别检查 Discard、重复创建/重复 Apply 和已有目标冲突；部分失败不得记成整组完成。

7. 修改 AGENTS、fallback、YAML 和 TOML：运行中不改变已提交请求前缀，新任务/空闲刷新后来源/hash更新；内容不变再刷新时上下文字节稳定，历史消息不被改写。检查 Run Details/trace 的三协议 context/tools/history hash 和 usage 投影，而不是只看最终回答。附带其他目录文件、切编辑器焦点不应改变任务目录。

8. 关闭 VS Code 工作区信任并按 VS Code 要求重载；项目指令/配置/Skill 停用，Codex TOML 的 trust_level 不能恢复 KeepSeek 权限。个人/全局来源与项目来源分别检查。加入有 MCP 依赖的测试 Skill，确认未接入说明和 Open 文件可用，不出现连接、脚本运行或工具成功假象。

9. 临时创建 `.agents/old/SKILL.md`、`.agents/skills/old-agent/AGENTS.md` 和 `.keepseek/memory.json`，确认不会发现旧 Skill、弹出迁移 UI 或注入 Memory。只检查夹具；实现不会删除或搬移任何用户旧文件。

记录每一步的 CLI 版本、cwd、文件 URI、hash、实际事件/Run Details 及通过/失败/未验。结束后自行保留或删除这个临时项目；不要把其配置覆盖到真实 home。

## 7. 旧项目手动整理

先自行备份。将仍需要的 Skill 手动整理到项目 `.agents/skills/<name>/SKILL.md` 或个人 `~/.agents/skills`，补齐标准必填 YAML；将原私有 allowImplicit 手动改为 agents/openai.yaml 的 policy。长期指令写入适用层级的 AGENTS.md/override；旧 Memory 只挑选仍有效的规则，不将整个历史文件自动导入。将禁用规则放入受支持的用户 config.toml；核对未知字段仍由各自宿主处理。KeepSeek 不提供转换器、旧模式开关或旧目录兼容读。

## 8. English summary

KeepSeek now reads shared local Skills, scoped AGENTS instructions, and a whitelisted Codex TOML subset. Shared files are read-only; creating a Skill prepares both standard files in one reviewed ChangeSet. Session preferences never override shared disable rules. Untrusted project sources, unsafe links, invalid policies and unavailable MCP dependencies cannot silently activate Skills.

The executable reference is Codex CLI 0.133.0. Its project-level skills.config is ignored in actual discovery; KeepSeek reports that limitation and blocks activation. No MCP runtime, Codex private tools, account/session sharing, automatic migration or cross-file transactional Apply is claimed. Real model invocation and native Webview acceptance remain manual checks.

## 9. 最终验证记录

| 检查 | 实际结果 |
| --- | --- |
| `bun run compile` | 通过，退出码 0 |
| `bun run lint` | 通过，退出码 0 |
| `bun run build:test` | 通过，退出码 0 |
| `bun run test` | **899 tests / 898 pass / 0 fail / 1 skipped**，约 149.6 秒 |
| 跳过项 | 既有 local fault server 测试：沙箱禁止绑定本地监听地址；非本次功能失败 |
| 聚焦共享配置/创建/UI 合成测试 | 27/27 通过（完整套件还覆盖其他相关行为） |
| `node scripts/check-codex-shared-config.cjs` | 通过；真实 Codex 0.133.0，模型轮次 0；结果见第 1 节 |
| `git diff --check` | 通过 |
| 打包/安装/发布/Git 提交 | 未执行，遵守任务范围 |
| 双端模型、Webview、Windows/Remote/WSL | 未实测；第 6 节是可执行的待现场验收步骤 |

完整测试早期暴露了旧契约断言和一个新增测试夹具输入错误；按实际 API 和新产品行为修正后重跑，未为了保留绿色而恢复旧目录或 Memory 功能。
