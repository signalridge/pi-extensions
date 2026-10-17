# Pi 插件调研（2026-10-12）

基于固定提交源码与发布包的只读调查。本文不安装插件，不证明运行时兼容，也不描述任何特定环境的启用状态。

## 结论：补清单与人工控制，不再造编排引擎

建议只推进三项优先工作：
1. **并列评估两个 Todo 候选，最终只启用一个**：短期执行清单选 99percentpeople；频繁单项更新、保留完成记录选 rpiv。不是客观性能排名，而是基于生命周期的取舍。
2. **借鉴逐次写入审批与命令审批**，补充人工控制；先解决无终端路径和工具覆盖，不能把确认框当沙箱。
3. **按真实需求选一个增量方向**：远端开发选 SSH；跨会话导航/交接选 sessions＋handoff。暂不批量安装集合包，也不替换成熟的 signalridge Subagents/Workflows。

基线缺的是独立、可维护的 Todo，不是任务状态：Plan 管方案，Goal 管目标续跑，Workflows/Subagents 管执行事实；Files Widget 已有 diff 和选行评论。[基线](https://github.com/signalridge/pi-extensions/tree/c75ad95e26372fa4f2ab6bb2f937a0a372549b6d)

以下“已核实”均指所提供固定提交源码、发布包与元数据证据；**优先级、适用性和设计建议属于推断**。这是源码/元数据研究，不是真实宿主安装、运行或组合兼容测试；库存也不证明已安装或启用。

## 99percentpeople Todo：值得试，但定位必须准确

研究版本为 **@99percentpeople/pi-todo@1.2.8**，不是其他同名 Todo。[发布元数据](https://registry.npmjs.org/@99percentpeople%2Fpi-todo)

**更新协议。** `todo` 接收完整“保留名单”，遗漏 key 就删除；已有项可省略未变字段，新项必须提供 subject/status。空 description、dependsOn、tasks 分别清空对应内容。先验证，再替换内存状态；可选 `baseRevision` 拒绝过期写，但可省略，因此不是强制并发锁，更不是磁盘事务。内容和顺序不变不增 revision。[状态实现](https://github.com/99percentpeople/pi-extensions/blob/0595505efd4c1c56c1bfde9eb3cf015dfe43bb73/extensions/todo/state.ts)

**依赖与生命周期。** 拒绝缺失依赖、自依赖和环；所有进行中/完成项的前置都必须 completed，允许多个独立项同时进行。最多 50 项、每项 20 个依赖；中文标题可以，key 限受限 ASCII。完成项本轮保留，下次 `before_agent_start` 清理，仅保留未完成项直接需要的完成前置，不递归保留祖先链；无取消/归档态，进度分母会缩小。上述依赖是状态约束，**不是调度器**。[同一状态实现](https://github.com/99percentpeople/pi-extensions/blob/0595505efd4c1c56c1bfde9eb3cf015dfe43bb73/extensions/todo/state.ts)

**恢复有四个层次，不能混说。** 工具结果和清理消息携带完整快照；启动及 `/tree` 从当前分支回放；压缩后另存 checkpoint；再向模型补回精确任务上下文。删除不抹去会话日志，目标分支仍有此前有效快照时可恢复；实际 fork、崩溃恢复和嵌套工具调用仍须验收。用户 widget 只有显示/展开，没有任务编辑器；源码有无界面分支，但不等于 headless 已实测。[入口实现](https://github.com/99percentpeople/pi-extensions/blob/0595505efd4c1c56c1bfde9eb3cf015dfe43bb73/extensions/todo/index.ts)

**成本判断（推断）：**适合有界、短中期清单，不适合长期 backlog。每次仍发送所有保留 key，结果仍返回完整计划；稀疏字段减少重复输入，却不是真正单项 patch。长描述、高频更新会增加上下文成本，TUI 折叠只省屏幕，不省模型 tokens。[工具实现](https://github.com/99percentpeople/pi-extensions/blob/0595505efd4c1c56c1bfde9eb3cf015dfe43bb73/extensions/todo/index.ts)

## Todo 紧凑对照

以下工程型候选均未证明是跨会话项目任务库；恢复数据、切树重建、压缩恢复与模型重新知晓任务是不同保证。

| 候选／研究版本 | 已核实机制 | 取舍与限制 |
|---|---|---|
| [99／1.2.8](https://github.com/99percentpeople/pi-extensions/tree/0595505efd4c1c56c1bfde9eb3cf015dfe43bb73/extensions/todo) | 完整名单＋稀疏字段；依赖、revision；分支回放、压缩 checkpoint 和上下文补回 | 短期清单优先；完成项自动清理；无人工编辑 |
| [rpiv／2.13.7](https://github.com/juicesharp/rpiv-mono/tree/abe8f534c35d11444eddbc51acc2a699cd1bf349/packages/rpiv-todo) | 单项 CRUD、owner/metadata、依赖、墓碑；变更显式 appendEntry 全量快照；分支/压缩重建 | 高频更新优先；完成项只隐藏，但不能重开；压缩重建不等于已证明同样的模型上下文补回 |
| [官方 todo.ts](https://github.com/earendil-works/pi/blob/55df12bf620a14305d0d2041de69199d4e4404a6/packages/coding-agent/examples/extensions/todo.ts) | list/add/toggle/clear、/todos；toolResult 全量快照、当前分支回放 | 教学起点，无依赖；浅复制＋原地 toggle 有对象别名风险，非实测历史损坏 |
| [kirang／声明 1.0.0](https://github.com/kirang89/pi-todo/blob/445beed8a53360a35a30abbbec60dd2a2128a2b9/extensions/index.ts) | 增量 add/start/complete；appendEntry；全完成后延迟清空 | 无 session_tree 监听，无压缩后列表再注入；可变快照风险未实测 |
| [zhushanwen／0.10.1](https://github.com/zhushanwen321/tai-ji/tree/2bd72f4ee60bb5db8735fc042534111be38bac79/extensions/universal/todo) | 批量增删改、三态可反转、分支回放 | 空快照被忽略，可能复活旧任务；自动清空未持久化，先修再考虑 |
| [YoungJurry／0.1.2](https://github.com/YoungJurry/pi-native-todo/blob/master/index.ts) | 全数组替换、分支回放；中文提示；最多一个进行中 | 简单轻量，无 ID/依赖，不适合复杂关联 |
| [Apple Reminders／0.0.3](https://github.com/patriceckhart/pi-todo/blob/d2f02218414a36241a15eec65d6232ab0d4eecda/index.ts) | EventKit 全局“pi”列表；Agent 操作＋人工 TUI | 个人提醒桥，不是工程会话清单；跨设备同步取决于列表账户 |

rpiv 的显式持久化修复专门处理了 codemode 嵌套调用缺少独立 toolResult 的情况，值得借鉴；**不能反推 99 必然在同一路径失败**，应加入对照验收。[修复提交](https://github.com/juicesharp/rpiv-mono/commit/1a10bb006753fd93798e475b8d5ebf8d263e9fc2)

Apple 桥风险较大：授权是 Reminders 全读写，不是仅“pi”列表；内容进入工具结果；clear 尝试删除全部条目，无内部确认，并忽略部分 EventKit 错误，返回数量不保证删除成功。0.0.3 随包 helper 为 arm64、部署目标 macOS 26；这不是 Swift 源码最低系统要求的证明。[Swift 实现](https://github.com/patriceckhart/pi-todo/blob/d2f02218414a36241a15eec65d6232ab0d4eecda/reminders-helper.swift)、[发布包](https://registry.npmjs.org/@patriceckhart/pi-todo/-/pi-todo-0.0.3.tgz)

## 按增量价值排序：借设计，不整套叠装

以下顺序是推荐判断；“采用”均指隔离验收后按需采用。

1. **slow-mode：借鉴逐次写入审批。** 每次 write/edit 展示 diff，可批准或外部编辑；这是实施阶段人工控制，不同于只读 Plan，也不同于事后文件评论。非 UI 路径绕过审批；多替换预览与 Pi 实际 edit 语义可能不同，不能直接当强制写保护。[源码](https://github.com/rytswd/pi-agent-extensions/blob/798cf2859c3848bfa175652e00e2784fd98246b2/slow-mode/index.ts)

2. **permission-gate：借鉴结构化审批事件。** 解析 bash，提供 waiting/respond/resolved；但只拦 bash，`PI_NO_GATE=1` 可关闭，事件交互依附 custom TUI 构建路径，不是已经可用的无终端审批总线。先补非 TUI 默认拒绝及后台/子运行时覆盖。[源码](https://github.com/rytswd/pi-agent-extensions/tree/798cf2859c3848bfa175652e00e2784fd98246b2/permission-gate)

3. **SSH Remote 0.6.2：有远端需求才采用。** 新增核心工具远端后端，不是另一套 worktree；不会自动远端化 AGENTS.md、skills、项目配置或 LSP/ReadSeek。ssh2 路径校验 known_hosts；默认密码写入 0600 JSON，未加密。建议密钥认证、关闭持久化并清理已有密码，不能只改开关。[边界说明](https://github.com/99percentpeople/pi-extensions/blob/a7ae6b89a211c35b657e886e9ceeafbf51616c22/README.md)、[凭据与传输源码](https://github.com/99percentpeople/pi-extensions/tree/a7ae6b89a211c35b657e886e9ceeafbf51616c22/extensions/ssh-remote/src)

4. **jayshah handoff＋sessions：借鉴交接与导航。** handoff 做目标导向摘要、人工编辑、父子会话关联，只预填不自动发送；sessions 跨工作区预览和切换，搜索不是全文语义检索。它们补 recap/手动 Recall 邻域，而非替代编排；摘要增加模型调用。0.5.4 是整包，不建议为两项加载全部功能。[handoff](https://github.com/jayshah5696/pi-agent-extensions/tree/7f6a8488cbc505604ed993db5a0bb814e6f2be58/extensions/handoff)、[sessions](https://github.com/jayshah5696/pi-agent-extensions/tree/7f6a8488cbc505604ed993db5a0bb814e6f2be58/extensions/sessions)

5. **pi-sem：先借 impact/context。** 实体影响、关联测试和预算化上下文补 LSP，不替代原始 diff 核对；省 token 未获证明。sem 0.3.21 默认 npm 下载器不提供 Intel macOS 二进制，但支持自带 binary/跳过下载及源码安装，不能说全面不支持 Intel Mac。[源码与说明](https://github.com/tomsej/pi-ext/tree/e132c44b3b06f88f7fcfb67b80c91698d8c1814f/extensions/pi-sem)

6. **rewind-redo 0.1.1：借写前原像＋恢复 journal。** 与 worktree 不同，强调对话节点对应文件恢复和失败 rescue；但仅覆盖捕获路径，恢复非原子，快照可能含秘密，并替换 edit/write。作者仅声明 Linux 测试，保留 Apache-2.0 通知。[源码及边界](https://github.com/extracurricular-ai/pi-better-rewind-redo)

7. **pi-tuicr 1.1.0：降为审查偏好选项。** 外部 tuicr 支持工作区/分支/提交/PR 评论，回填编辑器而不自动发送；增量是外部审查体验，不是首次拥有“diff→评论”——基线 Files Widget 已有选行评论。需额外 CLI，先做重叠测试。[源码](https://github.com/joelazar/pi-tuicr/blob/main/index.ts)、[基线能力](https://github.com/signalridge/pi-extensions/blob/c75ad95e26372fa4f2ab6bb2f937a0a372549b6d/packages/pi-files-widget/README.md)

8. **model-debugger 1.1.0：借生命周期诊断。** 记录状态、大小、usage 等，不录像完整正文；耗时从 agent_start 算，不能当精确逐请求延迟。头脱敏不全面，日志无实时硬上限；peer `^0.75.4` 不含 1.x。[源码与 manifest](https://github.com/luongnv89/pi-extensions/tree/4db7ab6/extensions/model-debugger)

9. **记忆路线：一次只评估一个。** pi-compact 值得借 provisional→人工确认和来源记录；notesoup 值得借窗口事务；jayzeng pi-memory 提供可选语义查询与明确快照失效边界。它们不自动等同实验性 Recall/Codex Compact，但不能叠加多个压缩所有者。笔记会进入所选模型；模型可写笔记不等于人工批准，qmd 与退出摘要另有计算/模型成本。[compact](https://github.com/DavidEasden/pi-compact/tree/bc09d3bd8160d31eecc3b9caa3fd5f7e24b8cf3c/src)、[notesoup](https://github.com/astrosheep-zero/notesoup/tree/d71980cef58414028a5a90bbb3b14d86ac8cdeae/src)、[memory](https://github.com/jayzeng/pi-memory)

10. **pi-sync 0.54.1：先 settings-only。** 新版有 S3/Git/WebDAV，不能照旧 fork 配置；关闭自动同步优先，会话上传可能包含提示、工具输出和图片，不是端到端加密。[发布源](https://registry.npmjs.org/@narumitw%2Fpi-sync)

11. **Background Tasks 2.1.1：只借 PTY/提供者协议。** 普通后台 shell 与 pi-background 重复；增量是交互 PTY、SSH/Windows 委托。node-pty 原生 beta 依赖增加维护，会话关闭清理，不是持久服务。[源码](https://github.com/99percentpeople/pi-extensions/tree/a7ae6b89a211c35b657e886e9ceeafbf51616c22/extensions/background-tasks)

12. **inbox／python：需求明确再借。** inbox 是外部生产者事件入口，非后台管理器；PID 非认证，截断不等于读取内存上限。python 保留跨调用变量/图片，但直接 exec/eval 无沙箱，bash 审批不覆盖它，超时杀进程会丢状态。[inbox](https://github.com/rytswd/pi-agent-extensions/blob/798cf2859c3848bfa175652e00e2784fd98246b2/inbox/index.ts)、[python](https://github.com/rytswd/pi-agent-extensions/tree/798cf2859c3848bfa175652e00e2784fd98246b2/python)

**条件候选，不默认安装：**Windows 可考察 PowerShell Adapter；Codex API 的搜索/图像不同于 fast/usage，但依赖非公开订阅端点，账号可用性未验证。[99 源码](https://github.com/99percentpeople/pi-extensions/tree/a7ae6b89a211c35b657e886e9ceeafbf51616c22/extensions) Chrome/Firecrawl 只有在等效 MCP 未启用时才有增量；多账户亦须明确需求。[上游包源](https://github.com/narumiruna/pi-extensions) cache-warm 会触发计费轮次，不默认开启。[源码](https://github.com/luongnv89/pi-extensions/tree/4db7ab6/extensions/cache-warm)

## 覆盖、维护与兼容边界

已调查的集合包括 99percentpeople、官方 Pi、jayshah、tomsej、LuneZhang、rytswd、luongnv89、awesamarth→narumiruna；另覆盖上表 Todo、rewind/sandbox/tuicr/nvim，以及四条记忆路线。深度并不相同，不能称生态穷尽。补充调查已覆盖 jayshah 的文件型 todos、`@tintinweb/pi-tasks` 与 tmustier `/readfiles`，见下节；这些候选不能仅因与会话 Todo 不同就被淘汰。[jayshah 清单](https://github.com/jayshah5696/pi-agent-extensions/blob/7f6a8488cbc505604ed993db5a0bb814e6f2be58/package.json)、[tomsej manifest](https://github.com/tomsej/pi-ext/blob/e132c44b3b06f88f7fcfb67b80c91698d8c1814f/package.json)

**仍未解决的覆盖：**dabeeduu 仓库 API 返回 404，删除、改名或私有均未解决。tmustier 初次分支的服务故障已通过独立源码调查补齐。[查询入口](https://api.github.com/repos/dabeeduu/pi-extensions)

维护应看发布物和实际入口，而非 README：tomsej 的 session-snap/cmux 已删除，review 会 checkout PR；Lune research-agent 入口未接通完整引擎。[tomsej](https://github.com/tomsej/pi-ext/tree/e132c44b3b06f88f7fcfb67b80c91698d8c1814f)、[Lune 入口](https://github.com/LuneZhang/pi-extensions/blob/affbbbf/src/research-agent/src/index.ts) 官方 sandbox 与 carderne sandbox 都有初始化失败后普通 bash 路径，不能直接当安全边界。[官方源码](https://github.com/earendil-works/pi/blob/55df12bf620a14305d0d2041de69199d4e4404a6/packages/coding-agent/examples/extensions/sandbox/index.ts)、[carderne 源码](https://github.com/carderne/pi-sandbox/blob/ad8c63c18eec7c70e3a91653758bd19eb1ae484c/src/extension.ts)

包名也须核实：npm `pi-todo` 不是 kirang，`pi-agent-extensions` 不是 rytswd。kirang/zhushanwen 的 MIT 声明缺配套许可证文件，需补授权证据，不应直接说无许可证。[npm 归属](https://registry.npmjs.org/pi-todo/latest)、[集合包归属](https://registry.npmjs.org/pi-agent-extensions/latest)

兼容性必须以具体宿主版本和实际入口验收，不能由宽泛 peer 范围推断。RPC 可能有 hasUI=true，但不支持 custom 终端组件；终端专用路径须检查 `ctx.mode === "tui"`。工具替换、拦截与跨扩展事件还须测试所有权和加载顺序。

## 补充：任务账本与项目 backlog

- **[`@tintinweb/pi-tasks@0.9.0`](https://github.com/tintinweb/pi-tasks/tree/00ecbd8110f1a4e267791f9cecb2612144c78f6e)**：七个 `Task*` 工具、人工 `/tasks`、独立 JSON 存储，默认会话级，可选择项目或共享清单。文件锁内重读、原子 rename 值得借鉴，但依赖错误只是警告，执行检查与认领不是一个原子事务；停止被标为完成，默认自动清理也不等于保留验收证据。其执行端要求旧协议 2，不能直接假定与本仓协议 4 兼容。建议评估清单/UI，执行与 cascade 层不替换现有编排。外部文件可跨压缩存活，却不随会话树回退；fork 复制当前清单不是历史分支回放。[状态实现](https://github.com/tintinweb/pi-tasks/blob/00ecbd8110f1a4e267791f9cecb2612144c78f6e/src/task-store.ts)、[执行入口](https://github.com/tintinweb/pi-tasks/blob/00ecbd8110f1a4e267791f9cecb2612144c78f6e/src/index.ts)
- **[jayshah todos／集合包 0.5.4](https://github.com/jayshah5696/pi-agent-extensions/blob/7f6a8488cbc505604ed993db5a0bb814e6f2be58/extensions/todos/index.ts)**：项目内逐项 Markdown 文件，支持 CRUD、claim/release、关闭/重开、搜索和人工编辑器预填；无依赖图，不自动执行。文件持久化不等于会话树回放，也没有压缩后状态补回；claim 不是访问控制，其他会话仍可改删。启动 GC 根据创建时间删除超过七天的已完成项，不是完成后保留七天。适合作为人工可认领账本参考；长期 backlog 先关闭 GC，避免为 Todo 默认加载全部 17 个扩展和四个主题。
- **[tmustier `/readfiles`](https://github.com/tmustier/pi-extensions/tree/4a63a2ebd3683d86597e226c7ff778ea4837dd73/files-widget)** 就是 `@tmustier/pi-files-widget@0.2.1` 的入口，不是另一种 Todo，也与已有 Files Widget 大量重叠。可比对跨目录扫描的 generation fence、选择期间暂停刷新和终端粘贴处理，但不能仅凭同名认定已经同步全部实现。工具依赖与同步 shell 渲染需要单独验收。

以上仍为源码／发布物调查，不是安装验收；许可证均须按实际复制的源码保留。

## 独立实现进度：已进入验收，尚未发布

上述研究固定于原调查基线，不应把当时的缺口描述当作当前发布状态。后续独立实现了 [`pi-todo`](../packages/pi-todo/README.md)、[`pi-approvals`](../packages/pi-approvals/README.md) 与 [`pi-sessions`](../packages/pi-sessions/README.md)，并为现有后台工具和 managed child 接入逐次审批。它们仍须通过最终组合验收和正常发布流程；当前证据及未完成项见[验收记录](task-human-controls.md)，不表示已安装、启用或发布。

`pi-todo` 保持**会话／分支级清单**：稳定 UUID、增量操作、强制 revision 校验、完整依赖图验证、深复制全量快照，空快照同样有效；已实现人工编辑、重开和独立确认的删除／清空。模型变更结果默认紧凑，完整状态通过结构化结果及精确上下文补回。文件会话须先有真实持久化对话，变更后验证实际落盘记录；无会话模式明确为易失状态，不宣称原子磁盘事务。

借 99 的验证与上下文恢复、rpiv 的显式持久化，不复制调度器。独立包，只用公共 Pi API/pi.events，不跨包导入源码；Todo 勾选不冒充 workflow 成功，不自动放开只读 Plan。[包边界](https://github.com/signalridge/pi-extensions/blob/c75ad95e26372fa4f2ab6bb2f937a0a372549b6d/docs/package-boundaries.md)

验收覆盖 tree/fork/reload、压缩与模型知晓、空快照、嵌套调用、过期写和 TUI/print/RPC；同名 todo 只保留一个有效所有者。会话清单不扩展为项目共享 backlog，审批不冒充沙箱，通用摘要交接也不替换 Plan 已有的批准计划实施交接。仍按独立包边界和实际宿主证据逐项收敛，不批量叠装集合包。
