> **English version: [README.en.md](./README.en.md) | 中文版：本文档**

## 什么人需要 KeepSeek？

> **Cursor 的手感 × Reasonix 的省钱 × DeepSeek 的低价 —— 全都在 VS Code 里。**

如果你想要的，是一个**交互像 Cursor 一样顺手、省 token 像 Reasonix 一样极致**的 **VS Code DeepSeek 智能体插件**，那么 **KeepSeek 就是你不二的选择**。

只要你对下面任何一条点头，KeepSeek 就是为你准备的：

- **羡慕 Cursor 的交互，又不想换掉 VS Code** —— 侧边栏对话、右键选区、`Cmd+L` 快捷引用、拖拽文件进输入框……Cursor 式的原生手感，KeepSeek 在 VS Code 里原样复刻：不换编辑器、不改习惯、不折腾迁移；
- **像 Reasonix 一样，把 token 当钱省** —— 前缀缓存命中价格低至普通输入的 **1/30**，长对话每一轮都复用上一轮的缓存，聊得越多省得越多，而不是越聊越贵；
- **想要一个真正「懂代码」的智能体** —— 语义定位、只读探索、行段读取，AI 看到的永远是你最新的代码，而不是几轮前的旧正文；
- **对「AI 偷偷改文件」零容忍** —— 所有修改都以 DraftEdit 呈现，你确认后才落盘；只读工具绝不越出工作区。

**只要有一条戳中你，就往下看** —— KeepSeek 凭什么把 Cursor 的手感、Reasonix 的省法和 DeepSeek 的低价同时给你。

# KeepSeek：把 DeepSeek 前缀缓存吃满的 VS Code 编程助手

> **同等任务，更少 token、更低费用、更快响应。**
> KeepSeek 是运行在 VS Code 侧边栏里的 AI 编程助手（Agent Chat），操作像 Cursor 一样原生顺手：不用切窗口、不用复制粘贴，右键、快捷键或拖拽就能把选区、文件、日志交给 AI。它把「上下文」变成一门精确的技艺——只发送必要的文件、选区和日志，让 DeepSeek 的**前缀缓存**在多轮会话中持续命中（命中价格只有普通输入的 **1/30**）。
> 对用 AI 开发项目的人来说，KeepSeek 同时是一台专业的代码阅读工具：语义定位、只读搜索、行段读取，让你随时把控架构节奏。长对话的每一轮，都在为上一轮的内容付费，而不是重新买一遍。

**开源软件 · MIT License · GitHub: [https://github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek)**

---

## 一、为什么省 token？因为缓存命中率是产品行为，不是巧合

DeepSeek 的计费里有一个绝大多数人忽略的事实：**前缀缓存命中的 token，价格是普通输入的 1/30**。

自 **2026 年 8 月 17 日**起，DeepSeek 改为**峰谷定价**，但无论高峰还是空闲时段，缓存命中的优惠倍率始终不变。KeepSeek 参考价格表：

| 模型 | 时段 | 普通输入 | 缓存命中 | 差距 |
|---|---|---:|---:|---:|
| DeepSeek V4 Flash | 空闲 | ¥1.5 / 1M tokens | ¥0.05 / 1M tokens | **30 倍** |
| DeepSeek V4 Flash | 高峰 | ¥3.0 / 1M tokens | ¥0.10 / 1M tokens | **30 倍** |
| DeepSeek V4 Pro | 空闲 | ¥4.5 / 1M tokens | ¥0.15 / 1M tokens | **30 倍** |
| DeepSeek V4 Pro | 高峰 | ¥9.0 / 1M tokens | ¥0.30 / 1M tokens | **30 倍** |

> **高峰时段**为北京时间每日 **9:00-12:00** 和 **14:00-18:00**，其余时间均为空闲时段。

以空闲时段为例：一次 100 万 token 的输入，全价需要 ¥1.5（Flash）或 ¥4.5（Pro）；**如果命中缓存，只要 ¥0.05 / ¥0.15**。而 Agent 多轮会话里，历史消息 + 工具定义 + 系统提示通常占请求的绝大部分——这些内容每轮都要重复发送。命中还是不命中，成本相差一个数量级（约 30 倍）。

缓存的规则很残酷：请求前缀必须**从第 0 个 token 起逐字节一致**，命中部分才按折扣价计费；任何一处的字节漂移，都会让**该点之后整个前缀全部失效**，重新按全价计算。

大多数 Agent 客户端在这件事上是「随缘」的：

- 每轮用不同模板重新包装历史消息 → 字节漂移 → 前缀全废；
- 时间戳、随机 ID、激活原因写进 system 段 → 每轮整段失效；
- 历史消息按窗口滑动、重排、trim → 中段任何改写都让后续全部失效；
- 工具 schema 集合随 prompt 变化 → tools 段前缀永远对不上；
- 会话摘要频繁刷新 → 低频内容被高频重写，把缓存当一次性用品。

结果就是：**长对话越用越贵，第 N 轮几乎等于把 1~N-1 轮的内容全价重发一遍。**

KeepSeek 反着做：**请求前缀是冻结的，历史是 append-only 的，缓存是可持续的。** 多轮会话中，前缀从 token 0 起一路命中到上一轮末尾，只有本轮新追加的消息按全价计费——**命中率随轮次增加趋于接近 100%**。

> 这不是营销话术，而是字节级契约。KeepSeek 用专门的测试（`test/cacheByteStability.test.ts`、`test/protocolCache.test.ts`）守护这些稳定性，任何破坏前缀稳定的改动都会在 CI 里直接变红。

---

## 二、缓存友好架构：四大支柱

### 支柱 1：字节冻结的请求前缀

KeepSeek 对「发送字节」有一套硬契约，写死在架构里：

- **system 段纯静态**：核心安全规则和工具权限边界不随时间变化；
- **contextInstructions 持久化复用**：AGENTS.md / Skills / Context Files 的格式化结果存入会话，字节未变就逐字节复用，绝不每轮重新生成；
- **user 消息「发送字节 == 持久化字节」**：`(expandedContent ?? content).trim()` 原样发送，禁止任何发送时包装/拼接；
- **assistant 消息逐字节还原**：工具轮（tool_calls / tool 结果）和 `reasoning_content` 原样持久化，跨轮重建时字节不变；
- **动态内容只追加在 user 消息尾部**：目标、临时指令、后台状态绝不改写已发送的历史。

> 结果是：**第 1 轮发给模型的前缀，第 50 轮依然逐字节出现在同一位置。** 缓存从第一轮开始累积，而不是每轮清零。

### 支柱 2：Append-only 历史投影

KeepSeek 的模型输入是一个 projection，不是「把聊天记录倒进请求」：

- 消息进入投影后**只追加，不重写、不 trim、不重排**；
- 最近窗口滑动不会把旧消息「外部化改写」——旧消息要么原样保留，要么等摘要刷新成批覆盖；
- 中段历史永不单独改写，因为中段任何字节变化都会让后续缓存全部失效。

### 支柱 3：低频摘要刷新（缓存重置点是受控的）

长对话的压缩摘要（synthetic summary）是少数必须重写前缀的时刻，KeepSeek 把它当作**受控的缓存重置点**：

- 摘要触发阈值**故意调高**（新增 ≥48 条可压缩消息且占用比超阈值才刷新），避免频繁重写 synthetic summary、成批移除 covered 消息而让前缀整体失效；
- 摘要输出预算受限、关闭 thinking、短超时，失败只记录原因，**绝不影响正常请求**；
- 摘要刷新失败后自动自锁暂停（C3 失败自锁），避免在缓存已受伤的情况下继续刷新伤口。

### 支柱 4：工具 schema 按会话冻结

KeepSeek 的工具集在会话内保持不变——工具 schema 集合和顺序不随每轮 prompt 变化（schema 规范化、key 排序，跨轮字节一致）。slim 工具模式默认关闭，也是出于同一个原因：**暴露的 schema 越小越稳定，tools 段前缀越容易命中**。

而 0.2.2 起，KeepSeek 更进一步：**按会话持久化请求协议、序列化方式、工具 schema 与 Provider / 模型 / 地址等信息；每个工具回合保留完整冻结的 tools schema，后续禁止调用时改用 `tool_choice: none` 而非移除 tools**——缓存不会因为一次「禁用工具」就整个断掉。同时引入**可配置的缓存有效期**（`keepseek.promptCacheTtlMinutes`，默认 1440 分钟），上下文被拆为固定的系统前缀与只增的每轮更新。

---

## 三、上下文压缩：总 token 也省

缓存解决的是「单价」，上下文压缩解决的是「总量」。两者叠加才是真省钱：

- **历史投影**：系统提示 + 会话摘要 + 受保护关键消息 + 最近轮次 + 当前输入，组织成一次请求；
- **摘要只留线索**：目标、决策、错误、文件路径、行段、函数名、已完成事项和待办——**不保留旧历史里反复出现的大段文件正文、日志和代码块**；
- **文件引用外化**：历史里展开过的文件内容只保留路径线索，模型需要代码细节时，通过只读工作区工具**重新读取当前文件**；
- **自动保护**：首条需求、最近输入、显式「记住这条」、重要报错/测试失败、用户纠错、DraftEdit 结果不会被摘要覆盖。

0.2.2 起，压缩管线升级为**缓存安全的 Snip → Prune → Summary 流水线**：

- **热会话不重写历史、不开付费后台摘要**——只有冷恢复或必要压缩时才归档并裁剪过期工具输出；
- 摘要覆盖只在**成功请求**后推进——溢出内容留待后续批次，失败不推进覆盖进度，新摘要以**不可变分段追加**而非重写旧摘要；
- **持久化的本地会话归档 + 受限搜索**：完整原始工具输出等不再随压缩丢失，错误、失败测试、校验输出及高风险编辑/删除结果受保护免于自动清理；
- 自动压缩档位可选：**70% 提前清理 / 80% 均衡 / 85% 缓存优先**，并按工作区持久化，覆盖模型默认配置。

> 典型效果：多轮引用文件、拖入日志、展开大段代码的长会话，token 消耗从「线性膨胀」变成「稳定增长」。

---

## 四、看得见的缓存健康：诊断、归因与用量

KeepSeek 不让你在黑盒里猜花了多少钱：

- **来源 + 模型级用量统计**：先按账号与模型归属，再在每组内按执行、摘要、重试、续接、后台等场景分类；未计价来源明确显示“费用不可用”，不同币种不会直接相加；
- **统一 Provider 请求投影**（0.2.2)：实际请求、上下文/Token 估算、越界防护、压缩决策、UI 用量与缓存测试使用**同一套投影**——显示用量与实际发送完全一致；
- **费用估算**：按本地价格表（`keepseek.usagePricing` 可自定义）实时折算估算费用；
- **上下文占用**：当前上下文占模型窗口的百分比、压缩触发阈值，快到压缩线时会提前告诉你；
- **DeepSeek 余额**：自动查询并展示账户余额，心里有数；
- **逐轮缓存快照**：每条已完成回复的 Run Details 保存服务端真实返回的命中/未命中 Token、命中率、数据可用性与缓存通道变化；原始 endpoint 与内部哈希不暴露到 Webview；
- **失效归因**：用量浮层和逐轮 Run Details 会展示模型、来源、协议、endpoint/cache lane、system prompt、tools schema、历史压缩/改写与服务端缓存逐出候选；只有服务端真实返回 miss 数据时才显示本轮未命中。

模型选择由扩展端确认后才生效。前台回复生成中可排队“下一轮模型”并取消；后台任务未终止时模型会锁定。切到更小上下文窗口或跨越无法保真回放的 provider-native lane 时，KeepSeek 会用目标模型的真实窗口与当前投影占用给出一次本地确认，不会为提示或统计额外请求模型。

> 其他客户端：命中率是个黑盒，降了也不知道为什么。
> KeepSeek：命中率是仪表盘，降了直接告诉你哪个零件换了。

---

## 五、省下来的时间与钱，长什么样

以 100K tokens 前缀、50 轮长对话、Flash 模型（空闲时段价格）粗算（仅输入侧）：

| | 普通客户端 | KeepSeek |
|---|---:|---:|
| 第 1 轮 100K 前缀 | 全价 ¥0.15 | 全价 ¥0.15 |
| 第 2~50 轮 100K 前缀（假设命中） | 每轮全价 ¥0.15（若缓存漂移） | 每轮 ¥0.005 |
| 50 轮输入成本 | ≈ ¥7.5（全部全价） | ≈ ¥0.40（命中） |

再叠加上下文压缩对**总量**的削减：KeepSeek 的长期会话不会把每轮的历史文件正文都背在身上。

---

## 六、账户、模型与 Skills：一套顺手的扩展体系

### 多账户管理（0.2.3）：官方 DeepSeek、OpenAI 兼容、本地 Ollama 一站齐活

KeepSeek 的账号体系不限制你用什么模型——**官方 DeepSeek、OpenAI 兼容服务、本地 Ollama**三类来源可同时挂在侧边栏里，互不干扰、随切随用：

- **免责 / 三来源并存，一键切换**：官方 DeepSeek、任意 OpenAI 兼容端点、本地 Ollama（`http://localhost:11434`）都作为独立账号配置；多个账号同时存在，**活跃账户一键切换**，旧配置平滑迁移，也可物理删除任意账户；
- **Ollama 免 API Key**：本地部署无需密钥（空 key 时不发送 Authorization 头），Base URL 省略 `/v1` 也会自动补全——粘贴 `http://localhost:11434` 就能直接连上；
- **每个账号可挂多模型 + 模型别名**：切换模型菜单按账号分组，用顺口的名字（别名）调用不同来源的模型，完整模型 ID 保留在悬浮提示中；
- **统一账户流量**：对话请求、上下文摘要与余额刷新统一走当前活跃账户，余额快照与查询频率按账户独立统计；
- **能力差异自动适配**：仅官网 DeepSeek 来源（`provider=deepseek` 且 Base URL host 为 `api.deepseek.com`）保留余额与费用统计；OpenAI 兼容、代理与 Ollama 来源自动只走 chat completions / 工具调用 / token 统计，不会误报余额；
- **兼容旧设置**：老用户的 `keepseek.apiKey` / `baseUrl` 与 `DEEPSEEK_API_KEY` 仍然有效，无需迁移即可继续使用。

### Agent 的唯一扩展机制：Skills（0.2.2）

把项目约定、排查步骤、团队提示词写成 **Skill**（工作区 `.agents` 与 `~/.codex/skills` 均可发现），KeepSeek 用 `/skills` 浏览、`$` 引用即用，还能 `/create-skill` 生成草案，点击使用栏中的 Skill 标签即可在 VS Code 中打开其 SKILL.md（支持 Enter/Space 访问）。扩展世界，从此**只有一条路**——干净、可控、不重写。

### 工具集稳定，随手可调用

- **工具 schema 按会话冻结**：工具集与顺序跨轮字节一致，点击使用、多步推理照常，但 tools 段前缀永不变形；
- **优化大文件处理**（0.2.2）：行段读取新增 `hasMore` 与 `nextStartLine` 续读游标；新增 `keepseek_create_incremental_draft_edit`，支持精确的唯一搜索替换、行段替换及同文件多处不重叠编辑——遇到缺失、歧义或重叠目标时**直接拒绝而不猜测**，不用把整份大文件灌给模型；
- **减少重复输入**（0.2.2）：普通回复不再重复携带推理内容（同时保持工具调用相关内容的稳定），进一步省 token。

---

## 七、像 Cursor 一样顺手的原生体验

KeepSeek 的省钱不是以牺牲体验为代价的——它像 Cursor 一样，把常用操作做成 VS Code 的原生交互：

### 侧边栏对话，边看代码边问

KeepSeek 住在 VS Code Secondary Sidebar 里，不用切窗口、不用复制粘贴。支持 DeepSeek V4 Flash / Pro 双模型、Thinking 模式（`high` / `max` 推理强度），模型与档位自动应用对应的编程参数（1M 上下文窗口、输出/工具预算、压缩阈值）。

### 上下文只给你想给的

- **编辑器选区**：右键或 `Cmd+L` / `Ctrl+L` 添加，保留文件路径、行号、列号；
- **Explorer 文件/目录**：右键添加，或直接拖拽进输入框生成引用 chip；
- **运行现场**：终端、Output 面板、Debug Console 的选中内容作为 `.log` 引用加入，让 AI 基于真实现场分析；
- **精确行段**：`<path#L10-L20>` 式引用，只展开需要的部分，不整文件灌给模型。

### Agent 工具按「低成本」设计

- 只读工作区搜索（literal/regex、path/include 限定、大小写匹配）+ 行段读取，**不是网络搜索、不是搜索替换**；
- 定位声明、引用优先走 VS Code 语义 provider（symbol/reference），省 token 且更准；
- 依赖、构建、VCS 目录自动跳过；二进制、媒体、归档、超限文件不会进上下文。

### 更省心的工程配套

- **验证与修复**：Agent 可运行受控的 `bun run compile / lint / test`，失败后读取 Problems 自动准备修复草案，循环修复并等待你确认；
- **运行中止**：推理或工具循环中可以随时停止本次执行；
- **断线重试**：首块响应前的可重试错误自动指数退避重试；
- **跨项目继续排查**：历史会话按项目保存，支持浏览其他项目、复制到当前项目、收藏、重命名、按时间过滤、多选删除——换工作区不换思路；
- **后台运行**：同一时刻互斥串行，保证会话前缀不被并发改写（这也是缓存稳定的一部分）。

---

## 八、AI 开发项目的搭档：把架构节奏握在自己手里

AI 生成代码越来越快，但项目架构、依赖关系、模块边界，依然需要人来把控。KeepSeek 不只是一个聊天窗口，它是一台**专业的代码阅读工具**——这正是 AI 开发项目时最容易被忽视、也最需要的一环：

- **语义定位，不靠猜**：查找声明、引用优先走 VS Code 语言服务（symbol / reference provider），一键跳转、查看调用关系，比全文搜索更准、更省 token；
- **只读探索，零副作用**：工作区搜索（literal/regex、path/include 限定、大小写匹配）、行段读取、目录清单，全部只读，绝不越出工作区；
- **按需重读，不被旧代码误导**：长会话中模型需要代码细节时，通过只读工具**重新读取当前文件**，而不是引用几轮前展开的旧正文——你改过的代码，AI 看到的一定是最新状态；
- **Git 只读辅助**：分支、状态、diff、patch、commit message 建议，随时掌握改动全貌，但绝不 push、绝不替你提交；
- **上下文可视化**：当前上下文占模型窗口的百分比、压缩阈值一目了然，快到压缩线会提前提示，架构讨论再长也不失控。

对用 AI 开发项目的用户来说，KeepSeek 让你在「AI 写代码」和「人控架构」之间随时切换：让 AI 干活的同时，用 KeepSeek 读代码、查引用、看 diff，把控每一步的节奏。

---

## 九、隐私与安全：修改永远由你拍板

- **修改永不静默写入**：AI 只能准备 DraftEdit，进入 ChangeSet 后你可以查看 Diff，选择 Apply / Discard / Revert；**create/modify 只有你点击 Apply 才会写入磁盘**；
- **删除双重确认**：工具调用高风险 modal + Apply 前删除专用 modal；草案准备后文件若被改动会拒绝删除，避免误删新内容；
- **只读边界**：Agent 的只读工具不会越出当前工作区；依赖、构建、VCS 目录自动跳过，二进制、图片、媒体、归档、超限文件不会进上下文；
- **显式授权**：只读取你显式添加的内容；外部文件、拖拽文件需先授权才会展开；
- **隐私默认值**：终端/调试选区以临时 `.log` 形式存在扩展全局存储中；trace 日志默认关闭；
- **失败自锁**：摘要刷新失败自动自锁暂停，不反复重试伤害缓存与上下文窗口。

---

## 十、适合谁

- **按量付费的 DeepSeek 用户**：想让 API 账单降一个数量级的人，KeepSeek 是为此设计的；
- **重度 Agent 用户**：一天几十轮对话、长会话不断的人——每轮都在省钱；
- **用 AI 开发项目的工程师**：需要专业代码阅读工具把控架构节奏、随时掌握改动全貌的人；
- **独立开发者**：在轻量侧边栏里完成代码阅读、问题定位和方案讨论；
- **团队工程师**：把真实代码和运行输出一起交给 AI，减少来回复制上下文；
- **新项目成员 / Reviewer**：快速理解结构，围绕文件、行号、日志做精确审查。

---

## 十一、快速上手（3 步）

```bash
# 1. 构建并安装 VSIX（本地自用）
bun run package          # 生成 keepseek-<version>.vsix
code --install-extension keepseek-<version>.vsix

# 一键重装验证：打包 → 卸载旧版 → 安装新版
bun run reinstall:vsix
```

```text
# 2. 在 VS Code 中打开
KeepSeek: Open Agent Chat
```

```text
# 3. 打开 KeepSeek 设置中的“账号管理”，添加账号（DeepSeek / Kimi / GLM / QwenCloud / Ollama / OpenAI 兼容等）并填写 API Key / Base URL
# 旧版配置（keepseek.apiKey / keepseek.baseUrl / DEEPSEEK_API_KEY 环境变量）不再支持，读取时直接舍弃
```

然后选中一段代码，按 `Cmd+L` / `Ctrl+L`（或右键 → KeepSeek: Add Selection to Chat），问你的第一个问题。打开用量统计，看第一轮和第二轮的命中率差距——那两行数字，就是 KeepSeek 存在的意义。

### 测试与发布打包（维护者）

```bash
# 运行完整测试套件
bun run build:test       # 编译测试产物到 out-test/
bun run test             # 运行测试

# 代码质量检查
bun run lint
```

```bash
# 打包发布到插件市场（推荐，自带安全校验）
bun run package:market
```

`package:market` 会先确认运行时依赖（如 `ignore`）已安装，清理 `out/`、重新编译，再用 `vsce package --dependencies` 打包并运行 `verify-vsix.js` 校验（确认 VSIX 包含运行时依赖与 `main` 入口），校验通过后生成的 `keepseek-<version>.vsix` 即可上传插件市场。**不要**裸跑 `npx vsce package --no-dependencies`——那样打出的包缺少运行时依赖，从市场安装后扩展无法激活。

### 多来源模型体系

- 账号保存一组 `provider + API Key + Base URL`，一个账号可挂多个模型；用相同连接信息再次添加模型时会复用账号，不重复保存凭证。
- “切换模型”菜单聚合全部账号并按账号分组；选中模型后，请求与摘要都使用该模型所属账号的凭证。
- 仅 `provider=deepseek` 且 Base URL host 为 `api.deepseek.com` 的官网来源支持自动发现、余额和费用统计。代理 DeepSeek 与 OpenAI 兼容来源只统计 token。
- “刷新模型”失败时会静默使用上次缓存，不影响对话；如果 OpenAI 兼容服务不提供 `/models`，可在设置中手动添加模型 ID。
- 来源文件只保存在 VS Code 扩展的全局存储目录，不进入工作区或 Git：`<globalStorageUri>/accounts/<provider>/<sourceId>.json`；官网来源余额位于 `<globalStorageUri>/accounts/<provider>/<sourceId>/balance.json`。
- 老用户无需迁移操作：首次升级且尚无来源文件时，KeepSeek 会把现有 `keepseek.apiKey` / `keepseek.baseUrl` 复制到 `accounts/deepseek/default.json`，但不会删除或修改旧配置，因此仍可回退旧版本。旧环境变量回退不会作为未配置来源进入模型菜单。

### 自动压缩档位

在命令菜单的模型区可直接选择压缩策略：**70% 提前清理**（追求更低延迟与更省 token）、**80% 均衡**（默认推荐）、**85% 缓存优先**（最大化前缀缓存命中）。选择按工作区持久化，覆盖模型内置默认档位。

---

## 十二、与成本相关的配置速查

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `keepseek.selectedSourceId` | `""` | 与 `selectedModelId` 配对保存当前工作区所选模型的来源 |
| `keepseek.usagePricing` | DeepSeek 默认价目 | 仅用于官网 DeepSeek 来源；未知模型不再回退套用其它模型价格 |
| `keepseek.balanceEndpointUrl` | `""` | 余额查询接口，为空时从 `baseUrl` 推导 `/user/balance` |
| `keepseek.balanceRefreshIntervalMs` | `60000` | 余额自动刷新最小间隔 |
| `keepseek.slimToolModeEnabled` | `false` | **默认关闭**：完整工具集保证 tools 段字节稳定、缓存持续命中；开启可换取更小的 schema，但工具集随 prompt 变化会降低命中率 |
| `keepseek.promptCacheTtlMinutes` | `1440` | 提示缓存有效期（分钟），到期后主动重连以刷新缓存窗口 |
| `keepseek.maxFileBytes` | `200000` | 单个引用/工作区文件最大读取字节，控制上下文体积 |
| `keepseek.maxWorkspaceToolFiles` | `2000` | 只读列表与搜索最多枚举的候选文件数 |
| `keepseek.maxRequestRetries` | `2` | 首块响应前的自动重试次数（指数退避） |
| `keepseek.historyRetentionDays` | `7` | 历史菜单默认显示范围（存储按 60 天硬清理） |

模型与 Thinking 档位对应的输出预算、工具轮次、摘要触发/强制比例是内部固定档位，始终开启上下文压缩。

---

## 十三、致谢：向 Reasonix 致敬

KeepSeek 的缓存友好机制，直接借鉴了 **Reasonix** 在处理「以最少 token 完成 Agent 任务」时的成熟做法：请求前缀逐字节稳定、历史 append-only 只增不改、摘要低频刷新、工具 schema 会话内冻结。这些思路在 Reasonix 的实践中被验证是有效的，KeepSeek 在此基础上，针对 DeepSeek 的前缀缓存计费做了工程化落地与产品化。

在此向 Reasonix 及其开发者表示**由衷的感谢**——KeepSeek 省下的每一分 token、每一分钱里，都有你们的贡献。

---

## 十四、更多资料

- **缓存命中优化技术详解（维护者/进阶）**：[doc/cache.md](./doc/cache.md)、[doc/cache_keepseek.md](./doc/cache_keepseek.md)
- **Agent 运行时工作流**：[doc/keepseek-agent-runtime-workflow.md](./doc/keepseek-agent-runtime-workflow.md)
- **文件引用规范**：[doc/keepseek-file-reference-spec.md](./doc/keepseek-file-reference-spec.md)
- **源码**：[https://github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek)

---

*KeepSeek 是开源软件（MIT License），源码在 [github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek)。缓存友好不是宣传口号，是 `agent/historyProjection.ts`、`agent/historyCompressor.ts`、`agent/runner.ts` 里的工程契约。*

*KeepSeek in one line (English): KeepSeek is a VS Code sidebar agent that treats context as a precise craft — it sends only the files, selections, and logs you choose, and keeps DeepSeek's prompt prefix cache hot across turns, with cached input costing as little as 1/30 of the full price. It pairs Cursor-like native interactions with a professional read-only code navigation experience, so you stay in control of your architecture. Open source, MIT licensed.*
