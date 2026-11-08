# Sidebar（项目任务侧边框）

把原先集中在 `src/webview/projectTasks.ts` 的左侧轨道与任务抽屉拆成独立子系统，便于单独演进。

```
sidebar/
├─ index.ts                 公共出口：getProjectTasksTemplate / getProjectTasksOverlayTemplate / getProjectTasksStyles
├─ templates/               按容器切分的模板 fragment
│   ├─ rail.ts              32px 空白抽屉把手（展开按钮 + live region）
│   ├─ drawer.ts            抽屉外壳：header / ranges / content
│   ├─ tooltip.ts           悬浮说明浮层
│   └─ index.ts             拼装：轨道原样返回；overlay = 抽屉 + "\n" + tooltip
└─ styles/                  按容器与定制组件切分的样式 fragment
    ├─ layout.ts            .project-workspace / -main / -transcript-stage / -input-region
    ├─ rail.ts              .project-tasks / .project-rail-control / .project-task-announcements
    ├─ drawer.ts            .project-task-sidebar / .project-sidebar-*
    ├─ card.ts              .project-task-card / -open / -copy / -title …
    ├─ detail.ts            .project-task-detail / -actions
    ├─ ring.ts              .project-task-ring* / -status-icon（定制组件）
    ├─ tooltip.ts           .project-task-tooltip（定制组件）
    ├─ viewStatus.ts        .project-view-status / -owner-notice / -input-target
    ├─ a11y.ts              焦点环 + forced-colors + reduced-motion
    └─ index.ts             SIDEBAR_STYLE_FRAGMENTS 固定顺序 + getProjectTasksStyles()
```

## 仍留在 `projectTasks.ts` 的部分

`getProjectTasksScript()`（约 740 行的 webview 脚本）仍在原文件原位。它与宿主 `script.ts`、`input/` 共享同一个 IIFE 词法作用域，宿主有 22 处、input 有 2 处直接调用其中的函数（`projectTaskUiActive`、`renderProjectTasks`、`projectApplyState`、`canSubmitPrompt` 等），因此脚本拆分属于独立阶段，不能与模板/样式拆分混在一起。

## 拆分必须守住的契约

1. **DOM 结构变更需同步测试**：`test/projectTaskWebview.test.ts` 直接依赖上表所有 id 与 `data-task-card-id`；`.hidden` 与 `aria-expanded` 的同步逻辑不变。轨道已清空，任务行只存在于抽屉列表 `#projectTaskList`。
2. **生成字节等价**：`getTemplate()`、`getStyles()`、`getScript()` 的输出与拆分前一致。fragment 的 `source` 逐行复制原文，含原有缩进与尾随换行。
   拼装约定：**只有第一个 fragment 以换行开头**，其余 fragment 直接从本行缩进开始；每个 fragment 以自身换行结尾；只有最后一个 fragment 带收尾缩进 `\n  `。否则 `join('')` 会在片段之间插入空行。
3. **fragment id 唯一**：`composeWebviewFragments()` 会对空 id 或重复 id 抛错。
4. **级联位置**：`getProjectTasksStyles()` 仍需在 `getStyles()` 中紧跟 `getInputStyles()` 之后，否则 `.project-*` 覆盖关系可能变化。
5. **模板拼装位置**：轨道由 `template.ts` 输出在 `.project-workspace` 内、`.project-main` 之前；overlay 输出在 `.project-transcript-stage` 内。
6. **输入区层级**：`#projectInputTarget` 与 composer 由 `template.ts` 输出在 `.project-workspace` 之后的 `.project-input-region` 内，是 `.shell` 的直接子元素。内容区（含轨道与抽屉）因此止于输入区上沿，composer 横向铺满整个面板。composer 的全宽规则只写在 `sidebar/styles/layout.ts`，不要写进 `input/` fragment —— `test/inputComposition.test.ts` 的三个 sha256 是输入层未被误伤的守卫。

回归护栏见 `test/sidebarStructure.test.ts`。

## 轨道现状（重新设计用）

左轨道已清空为 32px 空白抽屉把手：只保留顶部展开按钮 `#projectSidebarToggle` 与 live region `#projectTaskAnnouncements`。抽屉宽度为 `min(180px, 100%)`，展开后不会超过面板总宽。原 `projectAssistantView` / `projectNewTask` / `projectTaskRailList` / `projectTaskHistory` 及其脚本绑定、灯列表样式已删除，`projectSyncNodes()` 只服务抽屉列表。

新按钮请接 `window.keepseekProjectTasks`，不要再复活逐按钮 DOM id：

```js
window.keepseekProjectTasks = {
  openSidebar(), closeSidebar(), toggleSidebar(),
  selectView(taskCardId, mode) // mode: 'project' | 'new' | 'task'
};
```

## 后续阶段（尚未实施）

- 脚本 fragment 按「投影 → 组件 → 容器 → 编排 → 绑定」搬入 `script/`，`renderProjectTasks()` 拆为 rail / drawer / viewStatus 三段编排。
- 侧栏状态（`projectSidebarOpen`、`projectSidebarScope`、`projectSidebarPreferences`、`projectSidebarScroll`、`projectSidebarDisposed` 等）收敛为单一模块，同时改造宿主调用点。
