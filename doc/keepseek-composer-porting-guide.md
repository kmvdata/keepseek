# Composer 移植实现骨架（技术栈无关）

配套文档：`doc/keepseek-composer-spec.md`（行为契约与验收清单）。
本文件描述**如何组织实现**：目录结构、对外 API、内部状态、纯函数边界、测试分层。

> 实现起点：先把纯函数与状态模型写完并用单测锁死，再接 UI。行为契约的 80% 风险集中在序列化/解析与选区管理，不在样式。

---

## 1. 目录结构

```text
src/composer/
  index.ts                 统一导出（Composer 组件 + 类型 + 纯函数）
  types.ts                 全部对外类型（payload、resource、skill、usage、锁定原因）
  state.ts                 状态模型与派生选择器（busy / 锁定 / 空 / 可提交）
  editor/
    sanitize.ts            DOM 清洗（只保留文本、br、块级容器、两类胶囊）
    serialize.ts           DOM → prompt 文本
    parseReference.ts      纯文本 `<...>` / file: URI / 绝对路径 → FileReference
    lineRange.ts           `#L10C2-L20` 行号区间解析
    fence.ts               Markdown 代码围栏开合判定
    selection.ts           选区保存/恢复/插入点计算
    autosize.ts            高度自适应 + scrollTop 保持
    insert.ts              统一插入函数（胶囊 / 纯文本降级）
  triggers/
    mention.ts             `@` / `$` 触发器检测（含行首与围栏排除）
    filter.ts              资源与 Skill 的查询过滤
  panels/
    ReferencePanel.tsx     引用面板（分组、高亮、空态、加载态、外部选择器首项）
    CommandMenu.tsx        命令面板（分区、子列表、键盘导航）
    ExecutionModeMenu.tsx  执行方式菜单
    UsageDialog.tsx        用量详情对话框
  toolbar/
    Toolbar.tsx            工具栏外壳
    StatusText.tsx         状态提示（临时/常驻/超长 tooltip）
    UsageRing.tsx          用量圆环
    SendButton.tsx         发送/停止按钮
  drag/
    extract.ts             拖拽数据提取（多类型优先级 + 去重）
    dropZone.ts            进入/离开计数、投放点定位、高亮
  test/
    serialize.test.ts
    lineRange.test.ts
    fence.test.ts
    parseReference.test.ts
    triggers.test.ts
    state.test.ts
    dragExtract.test.ts
    behavior/              第 14 节验收清单的组件级用例
```

> `.tsx` 只是示例；Vue/Svelte 对应 `.vue`/`.svelte`，目录分层不变。**纯函数层必须与框架无关**。

---

## 2. 对外 API（Props / Events）

```ts
// ---------- 输入数据 ----------
interface ComposerProps {
  // 环境
  isMac: boolean;
  locale: 'zh' | 'en';
  theme: 'light' | 'dark';           // 仅用于选择 CSS 变量作用域

  // 会话与选择
  sourceId: string;
  modelId: string;
  executionMode: 'normal' | 'plan';
  agentSettings: AgentSettings;      // 压缩阈值、推理强度等

  // 忙碌与锁定（单一真相源）
  isBusy: boolean;
  settingReadiness: {
    executionMode: 'ready' | 'loading' | 'error';
    models: 'ready' | 'loading' | 'error';
    approval: 'ready' | 'loading' | 'error';
  };
  lockPolicy: {
    allowModelSwitchWhileBusy: boolean;
    allowApprovalSwitchWhileBusy: boolean;
  };

  // 引用与 Skill 资源（由上层提供，组件不自行读文件系统）
  resources: ReferenceResource[];
  resourcesState: 'idle' | 'loading' | 'ready' | 'error';
  resourcesError?: string;
  skills: SkillItem[];
  activeSkillIds: string[];

  // 用量
  usage: UsageMetrics;
  supportsBilling: boolean;

  // 模型状态提示
  pendingModelSwitch?: { text: string } | null;

  // 待确认计划工作流
  hasPendingPlan: boolean;

  // 文件导入限制
  maxDroppedFileBytes: number;

  // 文案
  messages: ComposerMessages;        // 见 §7，可整体注入以便测试与国际化
  renderSkillIcon?: () => unknown;   // 由上层提供 Skill 图标
}

// ---------- 上报事件 ----------
interface ComposerEmits {
  submit: ComposerSubmitPayload;
  abort: void;

  openFile: { path: string; startLine: number; endLine: number; startColumn: number; endColumn: number };
  openDirectory: { path: string };
  openSkill: { skillId: string };

  requestResources: { requestId: string };
  requestSkills: void;
  pickExternalFiles: void;

  insertDroppedFiles: { files: DroppedFilePayload[] };

  useSkill: { skillId: string };
  removeActiveSkill: { skillId: string };

  setExecutionMode: { mode: 'normal' | 'plan' };
  updateAgentSettings: Partial<AgentSettings>;
  updateModel: { modelId: string };
  updateApprovalMode: { mode: ApprovalMode };

  notify: { text: string; kind: 'info' | 'warn' | 'error' };
}

// ---------- 上层可调用的命令式句柄 ----------
interface ComposerHandle {
  clear(): void;
  focus(): void;
  setPrompt(text: string): void;
  getPrompt(): string;
  isSubmittableEmpty(): boolean;
  insertFileReference(ref: FileReference): void;
  insertDirectoryReference(path: string): void;
  render(): void;                    // 上层状态变更后重渲染（受控组件模式下可省略）
}
```

**约定**：组件永不直接读写文件系统、永不直接调用模型；所有外部副作用以上报事件表达。

---

## 3. 内部状态模型

```ts
interface ComposerState {
  // 输入
  prompt: string;                         // 由 editor 序列化得到，仅供上层展示/校验
  isEmpty: boolean;
  isSubmittableEmpty: boolean;

  // 选区
  savedRange: Range | null;

  // 引用面板
  referencePanel: {
    open: boolean;
    source: '' | 'mention' | 'skill' | 'button';
    pendingRange: Range | null;           // 待替换的触发文本范围
    query: string;
    activeIndex: number;
    resources: ReferenceResource[];
    loading: boolean;
    loaded: boolean;
    error: string;
    requestId: string;
  };

  // 命令菜单
  commandMenu: {
    open: boolean;
    openSubmenu: '' | 'model' | 'subagentModel' | 'approval' | 'skills';
    subagentModelProfile: string;         // 二级子列表
    skillFilter: string;
  };

  // 执行方式菜单
  executionMenu: { open: boolean };

  // 状态文字
  status: {
    text: string;
    persistent: boolean;
    sequence: number;
  };

  // 拖拽
  drag: { depth: number; over: boolean };
}
```

### 3.1 派生选择器（必须集中实现，不要分散到控件）

```ts
function deriveLockState(props): LockState {
  const busy = props.isBusy;
  return {
    sendButtonMode: busy ? 'abort' : 'send',
    sendDisabled: !busy && isSubmittableEmpty(),
    referenceButtonDisabled: busy,
    referencePanelReadonly: busy,
    commandMenuReadonly: busy,
    but allowModelSwitch: busy && props.lockPolicy.allowModelSwitchWhileBusy,
    allowApprovalSwitch: busy && props.lockPolicy.allowApprovalSwitchWhileBusy,
    executionModeLocked:
      props.settingReadiness.executionMode !== 'ready' || busy,
    executionModeLockReason:
      props.settingReadiness.executionMode === 'error' ? 'loadFailed'
      : props.settingReadiness.executionMode === 'loading' ? 'restoring'
      : busy ? 'readonlyBusy' : '',
    skillRemoveDisabled: busy,
    submitBlockedReason: busy ? 'busy' : '',
  };
}
```

### 3.2 空/可提交判定

```ts
function isEmpty(root: HTMLElement): boolean {
  return !root.querySelector('a.rich-file-link')
      && !root.querySelector('a.rich-skill-link')
      && !root.textContent!.trim();
}

function isSubmittableEmpty(root: HTMLElement): boolean {
  // Skill 胶囊不构成可提交内容（Skill 只是激活标记，不带上下文数据）
  return !root.querySelector('a.rich-file-link')
      && !textWithoutSkillLinks(root).trim();
}
```

---

## 4. 纯函数契约（先实现并单测）

### 4.1 `serializePrompt(root)` → `string`

```ts
type Part = string;

function serializePrompt(root: HTMLElement): string {
  const parts: Part[] = [];
  append(root, parts);
  return trimWhitespaceEdges(parts.join(''));
}

function append(node: Node, parts: Part[]): void {
  // 1. TEXT_NODE            → 原样 push
  // 2. rich-skill-link      → push `[$name](path)`；无对应 skill 时退回 `$name` 或 `[$name](skillPath)`
  // 3. rich-file-link       → directory: `\n目录名/ <keepseek-dir:path>\n`
  //                            file:      `\n标签\n<file:///path#Lx-Ly>\n`
  // 4. BR                   → push '\n'
  // 5. 块级(div/p/li/ul/ol) → 前补 '\n'（若前一片段不以换行结尾），递归子节点，后补 '\n'（若不以换行结尾）
  // 6. 其他元素             → 直接递归子节点（清洗阶段已拆壳，此处为兜底）
}
```

必须覆盖的用例：

- 纯文本多行 → 换行保留、首尾空白裁掉
- 连续两个块级元素 → 只产生一个换行（不出现 `\n\n` 冗余，除非原内容确实有空行）
- 文件胶囊夹在文本中间 → 前后各有一个换行，形成独立段落
- 目录胶囊 → 目录名前缀、保留末尾 `/`
- 多个同类胶囊相邻 → 各自成段
- 只有空白文本的容器 → 输出空串

### 4.2 `parseLineRange(text)` → `LineRange | null`

```ts
interface LineRange {
  startLine: number; endLine: number; startColumn: number; endColumn: number;
}
```

规则：`#` 后接 `[l]起始行[c起始列][-|:|,][l]结束行[c结束列]`，大小写不敏感；数字 `< 1` 视为 `1`；结束行 `<` 起始行时纠正为起始行；不合法返回 `null`（交由调用方按"路径含 #"处理）。

必须覆盖：`#L10`、`#L10-L20`、`#10C2`、`#10C2-20C5`、`#L10:L20`、`#L10,20`、`#l0`（→1）、`#L20-L10`（→10-10）、`#`（非法）、`#abc`（非法）。

### 4.3 `splitLineReference(value)` → `{ path, range }`

从右向左找**最后一个**能解析出合法行号区间的 `#`；找不到则整体视为 path、range 全 0。

### 4.4 `isMarkdownFenceOpenAtTextEnd(text)` → `boolean`

按行解析：行首最多 3 个空格后出现 ≥3 个 `` ` `` 或 `~` 视为围栏标记；未闭合时返回 `true`；闭合要求同标记字符、长度 ≥ 开启、且无语言后缀。支持 `\r\n` / `\r` / `\n`。

### 4.5 `normalizePlainTextReference(text, allowPlainPaths)` → `FileReference | null`

顺序：`file:` URI → 独立 `<...>` 目标（`keepseek-dir:` 前缀 → 目录；`file:` → URI 解析；否则按行号拆分）→ 允许时按绝对路径解析（`/x`、`//host`、`\\host`、`C:/`、`C:\`）。
独立 `<...>` 若含引号、反引号、`\s+\S+=`、控制字符，则拒绝。

### 4.6 `detectTrigger(root, selection)` → `Trigger | null`

```ts
interface Trigger { kind: 'mention' | 'skill'; range: Range; query: string; }
```

- `mention`：从光标向左扫描到 `@`，遇 `<`、`>`、换行、空白则放弃。
- `skill`：从光标向左扫描到 `$`，除上述终止符外，还要求 `$` 前为空/行首；且不能位于未闭合围栏内。
- `query` = 触发符之后到光标之间的文本。

### 4.7 `filterResources(resources, query)` / `filterSkills(skills, query)`

- 归一化：`trim().toLocaleLowerCase()`
- 资源匹配字段：`label`（无则取路径 basename，去掉末尾 `/`），子串匹配
- Skill 匹配字段：mention 名（`name` 若匹配 `/^[A-Za-z0-9_-]+$/`，否则用目录名 basename）与 `name`，子串匹配
- Skill 预过滤：`enabled && userInvocable && !unavailableReason`

### 4.8 `extractFileReferences(dataTransfer)` → `{ references, pathlessFiles }`

多类型按优先级提取并按"kind + path + 行号区间"去重；无路径文件按 `name:size:lastModified` 去重。

---

## 5. 编辑内核实现要点

### 5.1 清洗时机

- 监听 `input`：先 `sanitize()`，再 `autosize()`，再 `saveSelection()`，再 `syncTrigger()`。
- 所有插入操作完成后同样走一遍。
- 不监听 `beforeinput` 做拦截（除粘贴外），避免干扰 IME。

### 5.2 自动增高

```ts
function autosize(el: HTMLElement, maxPx = 200): void {
  const prev = el.scrollTop;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, maxPx) + 'px';
  el.scrollTop = Math.min(prev, Math.max(0, el.scrollHeight - el.clientHeight));
}
```

> `maxPx` 必须与 CSS `max-height` 同源（建议由同一常量注入），否则 `height:'auto'` 被 clamp 会导致滚动跳动。

### 5.3 插入

```ts
function insertFragmentAtRange(range: Range, fragment: DocumentFragment): void {
  if (!fragment.firstChild) return;
  deactivateMark();
  const last = fragment.lastChild!;
  range.deleteContents();
  range.insertNode(fragment);
  const after = document.createRange();
  after.setStartAfter(last);
  after.collapse(true);
  applySelection(after);
  saveSelection();
  autosize();
  emitInput();
}
```

文件引用插入：两端各补一个空格；多个之间用 `<br>`；围栏内改为纯文本目标。

### 5.4 选区

- `saveSelection()`：空内容时把 Range 规范到开头并（焦点在编辑器内且不在开头时）实际移动光标；否则克隆当前 Range 存入 `savedRange`。
- `restoreSelection()`：空 → 开头；`savedRange` 不在编辑器内 → 末尾；否则恢复。
- `getInsertionRange()`：`restoreSelection()` 后取当前选区，不在编辑器内则用末尾。
- `selectionchange` 仅当 `document.activeElement` 在编辑器内（或为编辑器）时处理。

---

## 6. 浮层通用规则

所有浮层（引用面板 / 命令菜单 / 执行方式菜单）共享：

1. **互斥**：打开任一浮层先关闭其余两个。
2. **关闭触发**：`document.mousedown` 命中浮层与触发按钮之外 → 关闭（不回焦点）；`Escape` → 关闭并回焦点到编辑器/触发按钮。
3. **只读模式**：`busy` 时保留 DOM 与展开状态，所有交互控件 `disabled`，样式降级（`opacity`/`cursor`）。
4. **焦点回收**：面板内项被点击/确认后，焦点回到编辑器。
5. **防失焦**：面板项 `mousedown` 阶段 `preventDefault()`，避免编辑器失焦丢失 Range。

命令菜单额外：`→`/`←` 展开收起子列表；原生表单控件不拦截方向键。
引用面板额外：循环高亮 + `scrollIntoView({ block:'nearest' })`。

---

## 7. 文案注入（`ComposerMessages`）

组件不内置任何用户可见中文/英文长句，全部由 `messages` 注入。最小集合（键名建议）：

```ts
interface ComposerMessages {
  placeholder: string;
  send: string;
  stop: string;
  referenceFile: string;
  referenceFileDisabledWhileBusy: string;
  showCommandMenuTitle: string;
  commandMenu: string;
  skillsTitle: string;
  skillsUsing: string;
  referenceFilesTitle: string;
  loading: string;
  loadingWorkspaceFiles: string;
  noMatchingFiles: string;
  noReferenceFiles: string;
  noMatchingSkills: string;
  skillsNone: string;
  chooseExternalFiles: string;
  chooseExternalFilesDescription: string;
  insertedFileReference: string;
  insertedDirectoryReference: string;
  insertedFileReferences: string;      // {count}
  skillInserted: string;               // {name}
  skillRemoved: string;                // {name}
  skillOpened: string;                 // {name}
  removeSkill: string;
  skillRemoveDisabledWhileBusy: string;
  openSkillInstruction: string;        // {name}
  taskAlreadyRunning: string;
  stoppingTask: string;
  busyTaskHint: string;
  sendShortcutHint: string;            // 非 Mac
  sendShortcutHintMac: string;
  noReferencePath: string;
  droppedFilesTooLarge: string;
  droppedFilesUnreadable: string;
  importingDroppedFiles: string;
  executionMode: string;
  executionNormal: string;
  executionNormalDescription: string;
  executionPlan: string;
  executionPlanDescription: string;
  executionModePendingPlan: string;
  executionModeRestoring: string;
  executionModeLoadFailed: string;
  executionModeReadonlyWhileBusy: string;
  usageStatsTitle: string;
  usageDetailsTitle: string;
  usageDetailsDescription: string;
  close: string;
  // …用量明细的标签键按产品补齐
}
```

> 复刻时可直接沿用 `src/shared/i18n.ts` 中同名键的中英文案以保证交互文案一致。

---

## 8. 测试分层

### 8.1 纯函数单测（无 DOM 依赖优先）

- `lineRange` / `parser` / `fence` / `filter`：表驱动，覆盖第 4 节所有必须用例。
- `serialize`：用 jsdom（或等价）构造胶囊 + 文本 + `<br>` 组合。

### 8.2 组件行为测试

按 `doc/keepseek-composer-spec.md` 第 14 节逐条落地，命名与之对应：

| 用例 | 断言重点 |
| --- | --- |
| 自动增高 | 高度 = min(scrollHeight, 200)；连续输入 `scrollTop` 不跳变 |
| 粘贴清洗 | 粘贴 HTML 后 `innerHTML` 只含允许节点 |
| `@` 触发 | 面板打开、过滤正确、↑↓ 循环、Enter 插入、Escape 焦点回编辑器 |
| 围栏降级 | 围栏内 `$` 不弹面板；围栏内插入引用为纯文本 |
| 拖拽 | 两个文件 → 两个胶囊；重复路径去重；光标在投放点 |
| 胶囊点击 | 单击触发一次 openFile；双击仍只触发一次 |
| 命令菜单 | 与引用面板互斥；`→` 展子列表；Escape 回焦点 |
| 执行方式 | tooltip 文案、勾选状态、选择即上报 |
| 提交 | payload 的 `prompt` / `references` / `skillIds` 与所见一致 |
| busy | 按钮变 abort；引用按钮 disabled；提交被拒并 notify |
| 空判定 | 仅文件引用可提交；仅 Skill 引用不可提交 |
| 占位恢复 | 删空最后一个字符后光标在开头、占位出现 |
| 状态消息 | 3s 后淡出；期间新消息不被旧计时器清空 |
| 用量圆环 | 百分比 → 角度；阈值 → warning/danger class |

### 8.3 手工验收（自动化不可覆盖）

- macOS/Windows 文件管理器真实拖拽
- 中文/日文 IME 连续输入不吞键
- 高 DPI 下胶囊省略号与 tooltip 换行
- 编辑器内 Emacs 风格快捷键与发送快捷键不冲突

---

## 9. 移植到目标项目的落地顺序

1. 复制本文件与 `doc/keepseek-composer-spec.md` 到目标项目 `docs/`。
2. 按 §1 建目录，先写 §4 的 8 个纯函数 + 单测（本步不涉及 UI 框架）。
3. 实现编辑器外壳（§2 的 5.1–5.4），跑通"输入 / 增高 / 清洗 / 序列化 / 提交"闭环。
4. 接入胶囊与三个引用入口，跑通第 14 节第 3–6 条。
5. 接入命令菜单、执行方式、用量区，跑通第 7、8、14 条。
6. 收口 §3.1 的锁定派生与 §6 的浮层通用规则，跑通第 10 条。
7. 全部通过后替换样式为项目设计系统的 token。
8. 清理组件内部类名/注释，保留行为契约与测试。