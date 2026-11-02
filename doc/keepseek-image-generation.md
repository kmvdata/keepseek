# KeepSeek 图像生成与整图修改

更新与官方接口核验日期：2026-11-02。本文记录本期实现及验收方法；真实接口、VS Code 界面和远程环境的结果必须分别记录，不由自动化模拟结果推定。

## 使用路径与支持范围

在输入区现有命令菜单打开“生成图片”。面板可复制当前聊天文字作为图像描述草稿；关闭、切换参数或提交图像任务均不发送或清空原聊天草稿。关闭保留图像草稿，Esc 关闭并恢复焦点。图像模型选择独立于主 Agent；纯图像模型仍不能成为文本 Agent 模型。

1. 在 KeepSeek 账号设置添加或使用已启用的 OpenAI compatible／OpenAI Responses compatible 账号，地址明确设为 `https://api.openai.com/v1`，通过现有安全入口填写自己的 API Key。添加模型 `gpt-image-2.5-sunburst`，或使用发现结果中的同一模型。
2. 打开图像面板，选择对应账号／模型，填写描述、尺寸与质量；高级参数提供格式和背景。缺少账号、凭据或支持模型时显示原因及设置入口。
3. 点“生成图片”授权本次单张付费请求。需要整图修改时，先通过原生文件选择器明确选择一张图片，检查缩略图、文件名和大小，再填写修改描述并点“开始修改”。面板明确显示接收图片的账号。
4. 在发起会话的独立图像任务卡查看阶段及结果；可放大查看、再生成、以此图继续修改、准备写入项目。“再生成”保留规格并创建新的待授权任务；“继续修改”使用原始结果资产，重新填写修改描述。它们均保留旧结果与父任务关联。
5. “准备写入项目”选择目标路径并产生待应用 ChangeSet；查看新图、目标、尺寸与大小，覆盖时查看原图或其不可预览原因，再由用户 Apply。准备草案不等于写入完成，原子写入和 read-back 校验完成后才记为已应用。Discard 或写入冲突不删除生成结果，也不再次调用图像接口。

只发送本次描述和明确选中的一张原始图片，不发送聊天历史、工作区目录、其它历史图片或缩略替代图。整图修改不承诺逐像素保持、人物一致性或 Photoshop 式局部编辑。界面显示图片不表示文本 Agent 看过图片。

| 项目 | 本期契约 |
| --- | --- |
| 适配器／模型 | `openai-images-v1` 版本 1；`gpt-image-2.5-sunburst` |
| 文生图 | `POST https://api.openai.com/v1/images/generations`，JSON |
| 整图修改 | `POST https://api.openai.com/v1/images/edits`，multipart `image[]`；单张原图 |
| 数量／并发 | 每次输出 1 张；同一资产存储域最多一个活动图像创建任务 |
| 尺寸 | `1024x1024`、`1536x1024`、`1024x1536`；这是产品支持子集，不是供应商全部尺寸能力 |
| 质量／背景 | low、medium、high；opaque、transparent |
| 格式 | PNG、JPEG、WebP；透明背景不可使用 JPEG |
| 描述 | 最多 32,000 字符；LF 换行并 trim，不静默截断 |
| 输入／结果限制 | 单图最多 20 MiB，最多 4,000 万像素，单边最多 16,384；拒绝 SVG、动画、交错 PNG |
| 同步响应 | 有界 JSON／base64；宿主解码、验证并入库，不将 base64 持久化进 JSON |
| 网络安全 | 仅上述官方域名与明确端点；不自动切来源、不跟随重定向、不取回响应中的任意远程 URL |
| 超时 | 沿用统一模型请求超时配置；不复用文本客户端自动重试 |
| 文件系统 | 图像任务及资产存储需 `file:`；项目 Apply 只允许受信任工作区内、通过安全管线验证的 `file:` 目标 |

官方已于 2026-10-23 停用 `gpt-image-1`，并计划于 2026-12-01 停用 `gpt-image-1.5`；本期因此选择当前模型。未实现批量、多适配器、遮罩／裁剪编辑器、视觉聊天、流式部分图片、Agent 自动图像工具或子代理生成。

## 任务、预算、恢复与隐私

每次提交建立不可变 `ImageJobSpec`，冻结来源身份、端点、模型、描述、操作、尺寸、质量、背景、格式、数量以及有序输入资产/hash。稳定 canonical hash 使用规范化后的字节。界面提交动作 ID 在宿主串行 claim；同一动作重复发送返回同一任务，改变规格需新动作。规格相同的新任务可以再次生成。

规格、用户点击授权、预算记录和 submitting 状态可靠持久化后，才能消费绑定 `jobId + specHash` 的短时内存一次性许可并进入付费创建请求。重启不恢复许可，不自动重新创建已 claim 的任务；跨网络不能保证供应商“恰好执行一次”。并发存储访问使用互斥、持久锁及 revision 检查，未知锁不按时间猜测失效。

| 状态／事件 | 用户含义与恢复路径 |
| --- | --- |
| pending／preparing | 待处理／提交准备；提交前停止不发出请求 |
| submitting | 已 claim 创建请求；关闭面板或隐藏 Webview 不取消宿主任务 |
| submission_unknown | 无法确认供应商是否受理或计费；保留记录与预算，不重发创建 |
| local_stopped | 停止本地等待；不表示服务端取消，也不表示免费；迟到成功结果仍保存 |
| generated | 已取得结果，正在完成本地保存；本地取回／保存重试不会再次生成 |
| saved | 图像资产已持久化并可查看；工作区写入结果由单独 ChangeSet 状态表示 |
| failed | 已确认的提交前失败或明确拒绝，显示对应原因；可修正配置后新建任务 |
| server_cancelled／expired | 领域兼容读取保留的状态；本期同步适配器没有服务端取消或远程任务查询入口 |

选定的同步 Images API 未提供本适配器可以使用的任务查询／取消句柄。`x-request-id` 仅用于诊断，不当作可查询 taskId。网络中断、Extension Host 退出或响应保存前崩溃可能留下无法恢复的未知结果；需要用户知晓可能重复计费后，明确新建任务。关闭 Webview 不终止任务；退出 Extension Host 不承诺网络请求继续。

收到合法结果后先将原始字节写入专用 pending-results 暂存，再更新结果阶段并登记内容寻址资产。已暂存结果、或已落资产但尚未落最终 job 引用时，恢复只重试本地读取／保存。若本地持久化本身失败，当前进程保留有界未保存结果并阻止继续提交，供原结果保存重试；暂存也未成功且进程退出时，无法承诺保住这份同步响应。

图像费用使用版本化官方 Standard 费率，币种 USD：文字输入 $5／百万 token、图片输入 $8／百万 token、图片输出 $30／百万 token。只有完整且一致的分类 usage 才核算金额；缺失或异常 usage 保持“未知”，不记作 0、不冒充供应商账单。直接 Images API 不使用 Responses 图像工具的缓存折扣，不套用文本参考费用，也不按固定每张价格结算。

每个手动图像任务使用独立 `manual-image:<jobId>` 预算域，读取现有 `keepseek.agent.maxCost` 数值；不创建、重置或占用父文本任务预算。其币种为本适配器的 USD，不能与其它币种直接求和。默认 0 表示无正数费用约束；若设置正上限，本期无法提供可信的总费用上界，提交前明确阻止执行，不能把预估输出价格当总费用上界。未知提交保留预算记录；同一任务不会重复结算。图像次数、成功张数与分币种金额单独展示，不进入文本 token、Provider 请求次数、缓存命中率或参考费用口径。

任务按 workspace/session 归属保存；切换会话不会把结果插到当前文本历史，也不占文本全局 busy 锁。Webview 重载通过宿主状态重建卡片。session、checkpoint、providerReplay、普通日志与 trace 不携带图片字节、base64、密钥或临时签名 URL。

资产以 sha256 寻址，读取时核对所有权与 hash；知道 hash 不授予跨会话权限。PNG 校验容器、CRC、解压扫描行和尺寸上界；JPEG／WebP 做受限容器与帧结构检查，不宣称完成像素内容或完整熵编码视觉验收。资产、输入来源、父任务与二进制草案使用明确引用；不自动垃圾回收，无法证明无引用便保留。

原始资产与独立预览副本共同计入 512 MiB 配额；预览不使用硬链接，编辑副本不能污染原图。待入库原始结果暂存配额 128 MiB；二进制修改审核预览另设 128 MiB 配额，崩溃遗留保守计入。单会话最多 500 个任务，界面每页最多 50 个，可切换较新／更早记录，累计统计覆盖全部任务。结果预览懒加载并异步解码，PNG 解压另受 160 MiB 上界约束。重开会话和文本压缩不清理图片；删除会话也不激进删除仍可能被草案／回滚引用的资产。扩展私有图片不等于项目文件，不承诺跨机器同步。

Webview 只收到有界元数据与 `asWebviewUri`，只开放当前会话专属预览目录及扩展静态资源；切换会话前撤销旧目录权限，异步切换期间暂停资源授权，拒绝迟到刷新恢复旧权限。放大使用无脚本只读面板，切换会话时关闭。原图不随进度消息反复传输，不开放整个 globalStorage 或共享 blob 根目录。原生图片选择器仅授权选中的精确 URI；它不授权目录、相邻文件或外部写入。

## 二进制项目写入与兼容读取

`binary_image_v1` 是明确的新 DraftEdit 类型，记录目标、新建／替换、base/result hash 与字节数、MIME、宽高、资产 ID 和 blob 引用；不伪装为文本、base64 文件或命令。仍由 DraftEdit → ChangeSet → SafeFileEditor 执行，复用 preflight、prepared journal、base 最后复核、同目录临时文件／原子替换、read-back、冲突、恢复分类、Discard 与 Revert。未知副作用不自动重试。

宿主检查工作区信任、目标归属、类型、尺寸／大小、脏编辑器／自定义编辑器占用、权限、取消及重复 Apply。覆盖前目标被修改即拒绝，结果资产仍可查看。图片类型严格 normalize，非法新记录不降级为旧文本草案；旧账号及纯文本草案继续按既有格式读取。

三种审批模式都要求用户明确查看图片并确认 Apply。纯文本 model_review／delegate 只能理解路径与精确元数据，不自动授权图片写入，也不声称检查过图像内容。生成按钮的付费授权不授予工作区写入权限。

Remote SSH／容器中的 Extension Host 若使用 `file:` 存储与目标，可进入相同安全检查，但必须独立验收；不能因桌面成功就宣称远程成功。非 `file:` provider、外部项目目标与纯浏览器 vscode.dev 不在本期写入支持范围。

## 可执行的现场验收

前提：可信测试工作区、VS Code 桌面、Bun、可读取该模型的 OpenAI 官方账号，以及用户单独批准的测试次数与费用范围。本任务未取得真实付费测试授权，以下真实调用均待执行；不要读取无关凭据，也不要为完成清单反复付费试错。完整成功路径最多安排四次创建调用：文生图、导入图修改、继续修改、相同参数再生成各一次；未知结果出现时停止付费矩阵并先核对。

在仓库执行下列命令；记录实际输出后才能标为“自动化已通过”。本文件不预填通过结果。

```bash
bun run compile
bun run lint
bun run build:test
bun run test
```

随后在 VS Code 打开仓库，选择 `.vscode/launch.json` 的扩展启动配置，按 F5。在新 Extension Development Host 打开一个可丢弃的测试项目，通过 KeepSeek 顶部设置完成上述官方账号与模型配置。截图／日志不得包含 Key、完整请求体、图片 base64 或签名地址。

Apply 后可在终端执行 `shasum -a 256 /absolute/path/to/test-project/image.png`，将输出与任务卡展开详情中的 `resultHash` 对照；该命令只用于验收读取，不代替扩展内的 Apply／read-back。新建文件 Revert 后确认路径不存在；覆盖文件 Revert 后重新核对保存前原文件的 hash。

| 验收项 | 操作与预期 | 当前标记 |
| --- | --- | --- |
| 配置与无来源 | 不配模型打开面板，检查原因与设置入口；配置官方账号及模型后可选择，聊天模型保持不变 | 待验证（VS Code 现场） |
| 正上限保护 | 给 `keepseek.agent.maxCost` 设置正值后提交，应在网络前提示无法可信估价；不得临时静默降额或绕过限制 | 待验证（VS Code 现场） |
| 文生图与原草稿 | 在聊天输入文字后进入图像面板，提交单张；检查原聊天草稿仍在、独立任务卡及放大图片 | 待验证（真实接口／VS Code 现场） |
| 导入整图修改 | 选择一张测试 PNG/JPEG/WebP，核对缩略、名称、大小与接收账号；填写整图修改描述后提交一次 | 待验证（真实接口／VS Code 现场） |
| 继续修改 | 从结果点继续修改，输入新描述并提交；核对使用原始结果资产、旧任务旧图仍在且保留关联 | 待验证（真实接口／VS Code 现场） |
| 再生成与防重 | 相同规格新建一次授权任务；同一次动作重复点击／重发只能出现一个 job 和一次创建请求 | 待验证（真实接口／VS Code 现场） |
| 新建 Apply／Revert | 准备写入测试项目新路径；Apply 前文件不存在；预览确认后 Apply，读取目标字节核对结果，再 Revert 确认移除 | 待验证（VS Code 现场） |
| 覆盖与 base 冲突 | 准备覆盖已有测试图片；Apply 前在外部改目标，必须拒绝覆盖；Discard 后生成图仍可查看 | 待验证（VS Code 现场） |
| 原图预览与三模式 | 覆盖预览检查新旧图；ask、model_review、delegate 都要求用户显式图片确认；打开脏文件／图片编辑器检查冲突 | 待验证（VS Code 现场） |
| 独立运行与归属 | 出图时关闭面板、切会话、编辑代码、发送普通文本，再回原会话；图片仅归原会话，Webview 重载重建状态 | 待验证（真实接口／VS Code 现场） |
| 中断与未知 | 已提交后断网／停止本地等待；说明可能收费与无远程查询，不自动再次创建；迟到合法结果仍保存 | 待验证（真实接口／VS Code 现场） |
| 本地恢复 | 在可控测试存储故障下让结果处于 generated，恢复存储后只重试保存；重启检查已暂存结果可恢复；无暂存时不得宣称可恢复 | 待验证（VS Code 现场） |
| 历史与损坏 | 重开原会话及执行文本压缩后检查图片；使用可丢弃测试数据制造缺图／损坏，检查原因占位且不触发生成 | 待验证（VS Code 现场） |
| CSP／隔离 | 图片能显示；切会话后旧会话资源不再被该 Webview 读取；无共享 blob／账号目录权限 | 待验证（VS Code 现场） |
| 可访问性 | 约 280px 窄侧栏、中文／英文、明／暗／高对比主题；键盘打开、Tab 焦点环、Esc 关闭、入口焦点恢复与图片 alt | 待验证（VS Code 现场） |
| 远程宿主 | 在已授权 Remote SSH／容器单独重复导入、展示、新建／覆盖／Revert 与重载；记录 Extension Host 实际 scheme | 待验证（远程环境） |
| 非本地 provider | 选择非 `file:` 工作区目标，检查明确拒绝且没有文件副作用；vscode.dev 不宣称支持 | 待验证（对应环境） |

记录格式统一为“自动化已通过／真实接口已验证／VS Code 现场已验证／待验证／失败”，附执行时间、命令或操作、预期、实得及脱敏证据。协议 mock 通过只能标自动化，不能替代真实来源或现场。

## 官方依据

以下链接于 2026-11-02 核对。本文只实现经过验证的接口子集；流式增量、更多尺寸及其它模型是后置范围，不能据此推断 API 永久不支持。

- [OpenAI GPT Image 2.5 Sunburst：模型、端点与 Standard 费率](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [OpenAI 图像生成指南：生成、编辑、原始结果、费用分类及 direct Images 缓存边界](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI Images generation API](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [OpenAI Images edit API](https://developers.openai.com/api/reference/resources/images/methods/edit)
- [OpenAI 模型弃用计划](https://developers.openai.com/api/docs/deprecations)
- [VS Code Webview：asWebviewUri、localResourceRoots、CSP、主题与生命周期](https://code.visualstudio.com/api/extension-guides/webview)

实现入口：`accounts/imageCapabilities.ts`／`imageModels.ts` 管理能力与独立选择；`images/` 管理不可变规格、任务、许可、费用、资产与适配器；`provider/imageController.ts` 协调；`webview/input/images/` 展示；`edits/binaryImageDraft.ts` 与既有事务管线落地图片。
