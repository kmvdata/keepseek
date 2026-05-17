# KeepSeek 调试与安装

## 开发调试

在当前工程目录安装依赖并编译：

```bash
npm install
npm run compile
npm run lint
```

用 VS Code 打开本目录，按 `F5` 启动 Extension Development Host。

在新打开的 VS Code 窗口中执行命令：

```text
KeepSeek: Open Agent Chat
```

也可以在右侧 Secondary Sidebar 的视图菜单中勾选 `KeepSeek`，显示 KeepSeek Agent 聊天窗口。

## 打包 VSIX

生成可安装的 VSIX：

```bash
npx vsce package --no-dependencies --out /private/tmp/keepseek-test.vsix
```

确认文件存在：

```bash
ls /private/tmp/keepseek-test.vsix
```

## 安装 VSIX 测试

如果本机已经有 `code` 命令：

```bash
code --install-extension /private/tmp/keepseek-test.vsix
```

安装后在 VS Code 中执行：

```text
Developer: Reload Window
```

然后执行：

```text
KeepSeek: Open Agent Chat
```

或者在右侧 Secondary Sidebar 的视图菜单里勾选 `KeepSeek`。

## 安装 code 命令

如果终端报错：

```text
zsh: command not found: code
```

在 VS Code 中执行：

```text
Shell Command: Install 'code' command in PATH
```

然后关闭当前终端，重新打开终端，再执行：

```bash
code --install-extension /private/tmp/keepseek-test.vsix
```

## 从 VS Code 图形界面安装

不用命令行也可以安装：

1. 打开 Extensions 面板。
2. 点击右上角 `...`。
3. 选择 `Install from VSIX...`。
4. 选择 `/private/tmp/keepseek-test.vsix`。
5. 执行 `Developer: Reload Window`。

## 重新安装新版本

如果已经安装过旧版本，可以先卸载再安装：

```bash
code --uninstall-extension keepseek.keepseek
code --install-extension /private/tmp/keepseek-test.vsix
```

当前扩展 ID 来自 `publisher.name`，即 `keepseek.keepseek`。
