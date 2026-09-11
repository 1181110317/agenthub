# AgentHub 已知问题清单（BUGS）

> 状态：2026-09-11 全量修复轮完成。原 B1–B20 已核对源码逐条处理，状态标注在每条之后。
> 修复说明见文末「修复记录」。
> 2026-09-09 新增「headless 能力对齐交互式」原生化改造轮（见修复记录末节）。

---

## 🔴 高（功能错误 / 数据不一致）

### B1. @文件引用在 SSH 远程会话下会查错机器 — ✅ 已修复
`/api/fs/files` 增加 SSH 分支（`ssh.execStream` 跑 `find`），远程路径不再被当本机路径读。

### B2. 切回"运行中"的会话时，直播消息重复渲染两份 — ✅ 已修复
`openSession` 检测到活跃直播流时，渲染跳过最后一条进行中的 assistant（服务端内存里的半成品），直播元素接回 DOM。

### B3. rewind / regenerate 不重置 CLI 会话，Agent 记忆与界面不一致 — ✅ 已修复
新增 `cliSessionStartTs` 记录 CLI 会话起点；截断点早于起点时清空 `cliSessionId`。
配套新增**上下文回放**：CLI 会话被重置后，下一轮把此前对话以紧凑文本注入 prompt，新会话不丢上下文。

### B4. 删除"运行中"的会话没有保护，进程变孤儿 — ✅ 已修复
`DELETE /api/sessions/:id` 对运行中的会话返回 400「请先停止再删除」；前端删除失败会 toast。

### B5. 并行会话时"工作中 N 秒"计时器只有一个 — ✅ 已修复
计时器移入每个流状态对象（`st.timer`），并行会话各自走表，完成后清理。

---

## 🟠 中（体验 / 边界）

### B6. WS 断线（服务重启）后界面状态卡死 — ✅ 已修复
`ws.onclose` 清空 streams/running、按钮复位、toast 提示；重连后自动拉回当前会话最新状态。

### B7. 关闭网页没有任何提醒，长任务静默中断 — ✅ 已修复
运行中挂 `beforeunload` 确认。

### B8. 排队消息没有本地气泡 — ✅ 已修复
排队时立即渲染半透明「⏳ 排队中」气泡，实际发送时清除并渲染正式消息。

### B9. 模型列表弹窗的内联 onclick 有注入/破引号风险 — ✅ 已修复
改为事件委托 + `data-model` 属性，含过滤输入框。

### B10. WSL 冷启动时同步 `spawnSync` 阻塞整个服务器 — ✅ 已修复
`/api/fs/ls`、`/api/fs/files`、`/api/fs/mkdir`、`/api/wsl`、`/api/ssh/test` 全部改异步 `execFile`；
`/api/agents` 改异步检测（`detectAgentsAsync`）；启动时 `preWarm()` 后台预热 CLI 能力探测缓存
（`--include-partial-messages` / `--settings` / WSL 内 claude 探测不再阻塞首条消息）。

### B11. cc-switch 数据库被占用时供应商列表静默变空 — ✅ 已修复
`ccswitch.lastError` 透出，`/api/ccswitch` 返回 error 字段；供应商/设置弹窗顶部显示警告横幅。

### B12. codex resume 时携带 `-i` 图片参数未验证 — ✅ 已修复
本机 Codex 优先走 app-server 的 `localImage` 原生附件；旧版 `exec resume` 先探测 `-i/--image`
能力，支持时原生附加，不支持时明确提示并忽略，不再静默把图片当普通文本。

### B13. MAX_THINKING_TOKENS（推理强度-claude 路径）有效性未验证 — ✅ 已修复
推理强度同时写入进程 env 和 `--settings` 会话级文件的 env 块，覆盖 `~/.claude/settings.json` 优先级问题。

---

## 🟡 低（瑕疵 / 长期健康）

### B14. sessions.json 无限增长 — ✅ 已修复
新增活跃会话上限（默认 500，可用 `AGENTHUB_MAX_ACTIVE_SESSIONS` 调整）。超过上限时按更新时间把
未置顶、未运行、未被定时任务引用的旧会话追加到 `data/sessions-archive.jsonl`，活跃列表移除；
归档内容仍保留完整消息，可通过命令面板「打开归档会话」恢复。归档失败时保留活跃数据，不会静默丢会话。

### B15. 搜索结果同一会话重复多条 — ✅ 已修复
每会话最多一条命中（标题命中后不再追加消息命中）。

### B16. 旧格式会话导出丢交错顺序 — ➖ 接受（历史数据一次性问题）

### B17. 终端默认 PowerShell — ✅ 已修复
设置中新增本机终端选择：自动（优先 PowerShell 7）、PowerShell 7、Windows PowerShell、命令提示符；
不再把终端类型写死为 PowerShell，且只允许白名单命令。

### B18. `#btnModelDD`、`.cfg-dd` 等残留死代码/CSS — ✅ 已修复
style.css 全量重写，旧死样式清除；隐藏的原生 select 保留作为下拉数据源（功能性）。

### B19. toast 提示音首次可能不响 — ➖ 接受（浏览器自动播放策略）

### B20. 置顶组内不显示项目来源 — ✅ 已修复
置顶会话现在同样渲染 meta 行（主机图标 / 模型 / 时间）。

---

## 修复记录（2026-09-08）

### 补充：SSH/WSL 会话模型切换不生效（2026-09-09，用户实测反馈）
现象：SSH 会话里选了模型，回复仍是远端旧配置的 MiniMax-M3，且报 `unrecognized_model`。
根因（两层）：
1. 未显式选供应商的远程/WSL 会话不会映射任何本地配置，远端用它自己 `~/.claude/settings.json`
   （其本机 cc-switch 写的 MiniMax 中转）；界面选的模型名该中转不认识 → 回落默认模型。
2. 即使映射了 env，**远端 settings.json 的 env 块优先级高于进程环境变量**（与本地同坑），
   必须用 `--settings` 会话级文件才能覆盖。
修复：
- 服务端 `handleChat`：远程/WSL 会话未选供应商时自动映射本地默认供应商（★ 或 cc-switch 当前），
  状态栏提示「已映射本地默认供应商 X 到远程」；
- `runRemote` / `runWSL`（claude 路径）：把供应商 baseUrl/key/env 写成远端 `/tmp/agenthub-claude-settings-<id>.json`
  并追加 `--settings` 覆盖远端配置；推理强度 `MAX_THINKING_TOKENS`、供应商额外 env 一并导出到远端；
- 修掉上轮引入的 bug：`--settings` 本地临时文件路径泄漏进远程命令（远程现在只写远端文件）。
已实测（10.2.8.48 真机）：映射后回复模型从 MiniMax-M3 变为所选的 DeepSeek V4 Flash。
注：若中转站对 claude 的会话标题子请求（query_source=generate_session_title）不认识所选模型，
仍会打出一条 `unrecognized_model` 告警——那是中转站对该子请求的限制，不影响正式回复。

### 主体修复（2026-09-08）

**后端（server.js / lib/）**
- `lib/agents.js`：codex resume 改 `-c sandbox_mode="workspace-write"`（修复 `unexpected argument '-s'`，问题#17）；
  推理强度 `--settings` 注入；新增 OpenCode 内置定义；远程 codex 供应商映射（远端 CODEX_HOME 写入 config.toml+auth.json，问题#21）；
  异步 agent 检测与能力预热。
- `server.js`：block 时间戳 `_t0/_t1`（时间线步骤耗时）、assistant.elapsed（"已工作 X"）；
  上下文占用改为最后一次 API 调用（修复 3.72M/200K=100% 的错误数字，问题#10）；
  会话锁定（问过话后 cwd/remoteHostId 不可改，问题#23）；`/api/fs/raw` 图片预览端点（本地/WSL/SSH，问题#12）；
  模型目录缓存 `data/model-cache.json`（问题#3）；B1/B3/B4/B10/B11/B15 如上。
- `lib/ccswitch.js`：`lastError` 透出（B11）。

**前端（public/）**
- `app.js` 全量重写：
  - **harness 风格时间线**（问题#25/#14/#15）：步骤行（思考/工具/中间输出，含耗时与状态），完成后合并为
    「已工作 X · N 个步骤」摘要行，点击展开/收起；运行中扫光动画；最终回答独立渲染区；
  - **token 速度**（问题#19）：优先真实 usage 累计，字符估算兜底；
  - **markdown 重写**（问题#1）：块级解析（表格/列表/引用/任务清单/代码围栏），修复表格不渲染与列表巨大间距；
    mermaid 图表渲染；
  - **多主题**（问题#8）：田园核风 / 墨夜 / 纸白 / 护眼林，🎨 菜单切换，xterm/mermaid 跟随；
  - **真实值**（问题#11）：供应商芯片显示实际默认供应商；模型芯片显示当前模型；
  - **会话锁定**（问题#23）/**目录锁定提示**；**排队气泡**（B8）；**WS 断线恢复**（B6）；**beforeunload**（B7）；
  - 修复 `refreshProviderModels` 未定义导致的切换供应商/模型 JS 报错（问题#22）；
  - 附件条样式补全（问题#16）；toast 移至右下角（问题#18）；文件选择器交互修复（问题#20）；
  - 远程/WSL 图标贯穿侧栏分组、会话项、头部徽章、发送栏（问题#5/#9）。
- `style.css` 全量重写：CSS 变量主题体系 + 时间线/步骤行/摘要行/pills 组件。
- `index.html`：引入 mermaid；主题按钮改为 🎨 菜单。

**已验证**：真实 claude 会话 E2E（流式/工具卡/耗时/续接/上下文仪表/锁定提示）、主题切换、markdown 表格、
用量弹窗（今日/累计）、接口冒烟（providers/ccswitch/fs/sessions）。

---

## 原生化改造轮（2026-09-09）：headless 能力对齐交互式

> 目标：网页只是「同步输入 / 同步输出」的壳，agent 能力与单独在终端里使用完全一致。
> 以下每条均经真实 CLI 端到端实测（本地 claude 2.1.218 / codex 0.153.4 / 远程 2.1.263）。

### C1. Claude「询问」权限模式在 headless 下自动拒绝 — ✅ 已修复（原生权限桥）
旧实现逐轮起 `-p` 进程，需确认的写操作被 CLI 静默拒绝，agent 实质丧失写入能力。
现在 Claude 改为**常驻双向流式会话**（lib/claude-bridge.js）：`--input-format stream-json`
+ `--permission-prompt-tool stdio`（SDK 原生协议）。权限请求（`control_request/can_use_tool`）
实时桥到网页卡片，用户点「允许 / 拒绝 / 允许并本会话切换模式（setMode 建议）」后回
`control_response`——与终端里的确认框同一语义。已实测：允许 → 文件真正落盘；拒绝 →
模型收到「用户拒绝了此操作」并自行调整。
注意：`--permission-mode` 合法值不含 `default`（误传会卡死无输出），询问模式 = 不传旗标；
`--permission-prompt-tool` 是隐藏旗标（`--help` 探测不到），默认随 stream-json 启用，
老版 CLI 不认时由运行时探测降级重发（自动摘除该旗标 + `--resume` 续接）。

### C2. Claude AskUserQuestion 在 headless 不可用 — ✅ 已修复（同一控制通道）
提问经 `can_use_tool` 桥到网页：单选点选即答、多选勾选提交；答案以「问题原文」为 key
写入 `updatedInput.answers`（可选备注走 `annotations`）回给 CLI。实测模型正确收到
"Your questions have been answered: …" 并按选择继续。刷新页面/断线重连后，未应答的卡片
经 `GET /api/bridge/pending` 重新挂上；回合结束时未应答卡片收到 `perm-expired` 置灰。

### C3. codex resume 带图片「让模型用 shell 看」是残缺的 — ✅ 已修复（原生 -i）
codex 0.153+ 的 `codex exec resume` 已支持 `-i`（实测模型真实看到图并答对颜色；新会话
`-i` 原本就支持）。删除旧的提示词注入；更老版本自动探测降级并明确提示「已忽略图片」。
本地/WSL（路径自动 `/mnt` 翻译）可用；远程 codex 图片仍不支持（文件在本机）。
claude 侧图片升级为原生 content block（base64 随消息进上下文，本地/WSL/远程均可用），
不再绕 Read 工具；当前中转若不支持视觉，行为与终端贴图一致（上游限制，非管线问题）。

### C4. Claude/Codex/ZCode 上下文回放有损 — ✅ 已修复（原生边界优先）
rewind / 编辑重发 / 重试 / 分叉优先使用 Agent 自己的原生历史边界：Claude/Codex 使用本地会话文件
截断复制，ZCode 使用官方 `session/messages + session/fork`；换新 `cliSessionId` 后仍由原生协议续接，
不把工具调用压成网页侧纯文字。原生边界不可用时（旧版、WSL/SSH 历史不在本机、文件手术失败）
才使用有限预算的文本回放兜底，并销毁旧桥进程，避免旧内存上下文残留。

### C5. Claude/ZCode/Codex 多轮不再逐轮重启 CLI — ✅ 已修复（本机及支持协议的 WSL/SSH 原生桥）
旧实现每条消息起一个 `-p --resume` 进程。现在 Claude 进程按会话常驻（与交互式一致），多轮原生
续接；闲置 10 分钟回收；回收 / 服务器重启 /
进程崩溃后的下一轮自动 `--resume`
重挂（上下文在磁盘，无损，实测暗号答对）。停止 = 原生 interrupt 控制请求，3 秒未响应
降级整树强杀；实测工具收到「用户不想继续」等同交互式 Esc。换模型/供应商/权限模式自动
重建进程并 resume。ZCode 本机使用官方 `app-server` 的 `session/*` 协议，Codex 本机使用官方
`app-server --stdio` 的 `thread/*`/`turn/*` 协议；两者多轮均复用同一原生进程/会话，官方权限
请求也会回到网页。首次启动仍包含官方 CLI 初始化（可能加载插件/缓存），不是每条消息重新启动。
WSL/SSH 现在会在目标环境探测并保持原生桥接通道；旧版会先尝试目标环境自己的更新命令，更新失败才使用兼容回退。

### C6. 远程（SSH）claude 也走流式桥 — ✅ 已修复
`ssh.execStream` 支持流式 stdin（`write()`，连接就绪前入队、就绪后按序刷出，首条消息不丢）；
`handleChat` 的 remote exec 包装透传 `write/end`。远程 claude 2.1.263 实测流式回复正常。

### C7. codex 沙箱与审批映射修正 — ✅ 已修复
本机 app-server：自动权限 = `approvalPolicy=never + danger-full-access`；计划 = `read-only`；
询问/接受编辑 = 官方 `on-request + workspace-write`，命令、文件修改、额外权限和用户提问
均通过网页卡片回传官方应答（包括当前版本只有 `cancel` 的拒绝项）。WSL/SSH 的原生 app-server
也使用同一类双向审批通道；目标 CLI 不支持原生协议时才按 exec 的 headless 沙箱语义回退。

### C9. ZCode/Codex 原生协议桥未接入 — ✅ 已修复
本机及支持协议的 WSL/SSH ZCode 接入官方 `app-server`，Codex 接入官方 `app-server --stdio`。
正常输入、模型输出、工具调用、会话续接、停止和权限/提问不再依赖每轮文本回放；原生桥不可用时仍
保留兼容回退，并在网页状态栏明确提示。远程/WSL 首次连接会探测目标 CLI，旧版会尝试执行
`claude update` / `codex update`；ZCode 可在设置填写升级命令。

### C8. 设置里的自定义 CLI 路径从未生效 — ✅ 已修复（存量 bug）
设置存于 `settings.agents.<id>.bin`，而适配层按顶层 `settings.<id>` 取值，永远取空。
新增 `agentSettings()` 兼容两种形态，全链路（检测/本地/WSL/远程/桥）统一走它。

### 遗留 / 说明
- WSL 内未安装 claude，WSL 流式路径未实测（代码与本地同构；老版 WSL CLI 自动回落一次性路径）。
- ZCode 用量扫描读取 `~/.zcode/cli/db/db.sqlite` 的只读 `model_usage` 记录；数据库被锁定或 Node 不支持
  `node:sqlite` 时只跳过扫描，不影响已有用量数据。
- 一次性路径（老版 CLI / raw / gemini / opencode）行为不变；claude 老版图片仍走 Read 注入。
- 推理强度映射（claude `MAX_THINKING_TOKENS` / codex `-c model_reasoning_effort`）保留——
  这是「推理强度」选择器的功能语义，不是能力损失。
- 工具输出 9000 字截断、思考 4000 字截断仅作用于网页显示与存档；原生会话路径的模型上下文
  不受该显示截断影响。ZCode 的回放兜底仍可能丢失工具内部细节。
- ZCode 的官方 headless Browser Use 已保留；网页尚未把用户桌面 Chrome/外部浏览器标签页映射
  成 ZCode 的 `interaction/browserExecute` 宿主，因此依赖外部浏览器标签的任务仍会得到明确的
  backend-unavailable，而不是假装成功。官方 MCP OAuth 也不会伪造登录状态。
- Codex app-server 的原生文件 patch 已转成网页文件事件；对新协议只含 unified diff、没有旧/新
  文本的版本，网页可查看原生 diff，但“自动撤销”仍以旧版文件记录为准。

### 补充（2026-09-11 下午，用户实测反馈三项）

**D1. 回答进行中再发消息会「卡住」— ✅ 已修复（排队/插入选择器）**
旧行为有两处问题：运行中按回车/点发送会被 `#btnSend` 的 stop 态拦截成「打断当前回复」
（正在写的消息发不出去，回复又停了，看起来像卡住）；另外服务端拒绝回合只回
error 事件、不回 chat.started/done，前端 `S.sendPending` 永远不清除，之后发送键
一直静默失效。
修复（与 agent 的输入语义一致——运行中随时可发消息，可选排队或插入）：
- 运行中输入了内容时，回车/点发送弹出「⏳ 排队发送 / ⚡ 插入」选择层
  （Enter=默认排队，Esc=取消）；空输入时发送按钮仍是「停止」。
- 排队沿用 B8 队列；「插入」把消息插到队列最前并发送 chat.cancel，
  回合取消完成后队列立即把插入消息作为新一轮发出（原生桥上下文无损）。
- `handleChatEvent` 收到任意 error 事件即清除 `S.sendPending`，杜绝发送锁死。

**D2. 网页打不开，提示「该站点禁止内嵌显示」— ✅ 已修复（服务端代理）**
绝大多数站点带 `X-Frame-Options` / CSP `frame-ancestors`，网页抽屉 iframe 直连被
浏览器拦截，只能看到回退提示。修复：
- 新增 `GET /api/page/check`：服务端先看目标站响应头，判定可否内嵌；
- 可内嵌 → 照旧直连 iframe；禁止 → 自动改走新增的 `GET /api/page/proxy`：
  服务端取回 HTML，剥掉内嵌 CSP meta、注入 `<base href>`（相对路径子资源仍指原站），
  iframe 侧配 `sandbox`（不给 allow-same-origin），被代理页面的脚本运行在独立源上，
  摸不到本服务 /api；抽屉顶部出现「已通过本机代理读取」提示条，右上角「↗ 新窗口」保留。
- 实测：example.com 直连、github.com（deny）代理成功取回完整页面。
- 附带修复：`readLimitedBody` 不能对异步迭代中的 fetch body 直接 `cancel()`
  （ERR_INVALID_STATE 未处理拒绝会带崩整个服务）；改为 `Readable.fromWeb` + destroy。
  并补了全局 `unhandledRejection` 兜底日志（进程不再因单个异常退出，保护运行中的会话）。

**D3. 计划（TodoWrite）不显示 + md 文件无法预览 — ✅ 已修复**
- Claude 侧解析器本就支持 TodoWrite/ExitPlanMode → 计划卡；ZCode 的两条路径
  （CLI stream-json 解析、app-server 原生桥）此前只把 TodoWrite 当普通工具行，
  现已同步转成 `plan` 事件，网页渲染为可跟踪的「执行计划」卡。
- 内置 Agent 新增 `todo_write` 工具（系统提示词要求多步任务先写计划并随进度更新），
  与 CLI agent 的 TodoWrite 同语义，计划卡同样可见。
- 文件 chip 预览扩展 `.md/.markdown/.txt`：`/api/fs/raw` 支持文本文件
  （512KB 截断），前端 md 走现有 markdown 渲染器（代码高亮 + mermaid），txt 纯文本。
  pptx/xlsx/pdf 原有能力不变。

### 复查轮（2026-09-11 深夜）：上项修复的 bug 修整 + 风格统一

**R1. 排队/插入的边界与气泡准确性 — ✅ 已修复**
- 队列项加 qid，气泡带 `data-qid`：插入消息在 DOM 里排最后但队列序最前，
  旧的「删第一条排队气泡」会删错；drain 现按 qid 精确移除。
- 弹层开着时回合自然结束 → onChatDone 立即收起弹层；点击时再复核运行态，
  已结束就退回普通发送——不会再把消息塞进没有下一轮 done 来消费的死队列。
- 弹层支持点外部关闭、再点发送键收起、切换会话自动收起、Esc 关闭。

**R2. 代理网页安全加固 + 网络兼容 — ✅ 已修复**
- 代理 HTML 响应加 `Content-Security-Policy: sandbox` 头：被代理页面即使被
  用户直接在顶层标签打开（不只内嵌在抽屉）也运行在独立源上，读不到本服务
  localStorage（访问令牌）与 /api。透传响应补 `X-Content-Type-Options: nosniff`。
- 服务端 fetch 接入 undici EnvHttpProxyAgent（新依赖）：`HTTP(S)_PROXY` 环境
  变量生效，网页代理与内置 Agent 的 web_fetch/web_search 在需要系统代理的
  机器上不再间歇性 fetch failed（无代理环境行为不变）。
- 代理错误页配色跟随抽屉当前主题（`&sch=d/l`），不再在暗色抽屉里闪亮色整块。

**R3. 风格统一 — ✅ 已修复**
- 「排队/插入」弹层完全对齐 #flyMenu 规格：`--bg` 底、12px 圆角、shadow-3、
  同款 12.5px 菜单项与 hover 态（此前是另一种卡片风格）。
- 网页抽屉 iframe 占位背景从硬编码 `#fff` 改为主题变量——墨夜等深色主题
  打开网页不再闪一大块白。抽屉加载期间显示「正在打开网页…」占位（原先是
  无反馈白屏）。
- 全部新 UI 走主题变量，6 套主题（含 AionUi 亮/极光/樱粉）自动适配。

**复查验证**：真实 MiniMax 会话端到端——运行中弹层 → 插入 → 当前回合被打断
（4.7s 处出现 stopped 块）→ 队列自动接续发出插入消息并正常回答；排队/插入
气泡文案与移除均正确；暗/亮主题下弹层、抽屉、md 预览截图核对风格统一；
github.com 经代理完整渲染（样式/图片齐全）。

### 继续修复（2026-09-11）
- 远程/WSL 文件撤销已补齐：快照通过 stdin 送到目标环境，目标文件先做字节级“仍等于修改后内容”校验，
  本机先按 Edit 片段生成恢复版本，再把“读取时版本”和恢复版本送到目标环境做二次比对，最后在同目录临时文件中原子 `mv`；
  目标已被改动、删除、片段重复/无法定位或快照过大时拒绝，不会误改本机同名文件。
- 归档会话恢复、历史富内容、手动供应商模型目录和用量记录统一做类型清洗；异常 JSON 不再让网页在
  `.map`、撤销或用量聚合处崩溃。
- 文件预览、粘贴上传、内置 Agent 图片读取改为异步文件 I/O；远程目录/测试输出增加上限，减少大文件和大目录
  对服务事件循环的阻塞。
- 内置 Agent 的文本 `write_file` 会在覆盖前保存旧文本；无法安全保存的二进制/大文件不再显示假撤销按钮，
  空片段和重复片段也不会被误判成新建文件。
- 桥接应答失败现在返回明确 HTTP 错误；过期权限卡不会再被前端误判为成功而永久锁死。
- CLI 能力探测改为异步并带短时“未安装”负缓存；SSH/WSL 长连接暴露存活状态，重挂时旧进程的迟到事件不会结束新回合。
- 原生 Claude 图片读取改为异步；不可安全取得旧文件快照的 Write 覆盖不再显示假撤销按钮，旧会话 ID 的前端 URL 也统一编码。
- 用量历史扫描改为异步逐行读取并合并同一时刻的扫描请求；扫描状态使用哈希集合去重，避免大体积 CLI 日志读取时阻塞网页或反复写盘。
- 会话历史与流式事件中的图片来源收紧为 AgentHub 上传文件或常见栅格图片 data URL；异常协议/历史数据会被丢弃，不再直接进入 `<img src>`。

### 全量验收测试（2026-09-10，29/29 通过）
针对「原生化改造轮」的端到端验收套件（真实 CLI + 真实中转/供应商，全部通过 WS 驱动服务器实测）：
- claude 权限五态（询问-允许落盘 / 拒绝-如实报告 / setMode 建议会话内生效 / acceptEdits：Write 放行 Bash 仍卡 / 自动：零卡片全执行）5/5
- claude 交互（AskUserQuestion 多选答案精确回传 / 计划模式 ExitPlanMode 卡片批准后继续 / 待处理卡片服务端可查-应答清零-重复应答报错 / 取消回合后会话可继续）4/4
- claude 上下文（双会话隔离 / 进程常驻零重启 / 换推理强度重建进程记忆无损 / 分叉(助手)新原生id+上下文完整 / 重试原生截断 / 回退到起点清空无残留 / 图片原生块无管线错误）7/7
- codex（工作区写放行 / 工作区外写被沙箱拒绝 / 自动权限免沙箱可写外+旗标 / effort 旗标 / 分叉边界正确 / 中断后续接）7/7
- 远程 SSH claude（权限卡片经 SSH 双向桥接且文件落在远程 / 多轮零重启 / 回退回落语义一致）3/3
- 兼容性说明：MiniMax/DeepSeek 中转 + 本机 claude 2.1.218 + 远程 2.1.263 均验证

测试中发现并当场修复的两个边界问题：
1. **取消时挂起的权限请求会阻塞回合**：CLI 在 can_use_tool 等待应答期间收到 interrupt 不会自行结束。
   修复：取消时桥接层先对所有挂起请求回「拒绝」（等同交互式终端里 Esc 关掉确认框），再发 interrupt。
2. **重挂后秒退（会话锁/管道竞态）**：配置变更触发重建进程时，新进程可能在旧进程完全退出前启动而被
   竞态秒杀。修复：统一「存活判据」（stdin 可写 + 未退出），死进程先清理；重挂后 8 秒内无 result 秒退
   则退避 1.5 秒自动重试一次。实测重建后暗号记忆无损。

另两条原生语义的实测发现（非 bug，行为与交互式一致）：
- Write 的内容与文件现有内容完全一致时（无变化写入），「询问」模式也会直接放行——CLI 原生优化。
- `echo` 等 CLI 内置安全清单命令在「询问」模式下免审批直接执行。

### 补充验收（2026-09-10，extra 批次 4/4）
- 斜杠命令透传：/context 在桥接会话中原生执行（返回真实上下文占用报告）
- 子代理：Agent/TaskOutput 工具经桥完整派发并返回结果（2.1.218 起子代理工具更名为 Agent；
  模型也可能选用其原生「后台代理」提前收尾——均为 CLI 原生行为）
- 多行 + 特殊字符（引号/反斜杠/反引号/JSON）输入原生透传无损
- ACP 路径回归：dispatch 未受本次改造影响（Cursor Agent 未运行报 initialize 超时为环境性错误，错误正常透出）
- 闲置回收生产证据：server.log 中多处 `session destroyed: ... idle`（约 600 秒 = 10 分钟阈值），
  回收后下一轮自动 --resume 重挂

### 原生 app-server 桥补充验收（2026-09-10）
- ZCode 本机 `session/create → session/send`、第二轮复用、进程重启后的 `session/resume` 已通过；
  供应商配置和图片附件仍由 ZCode 原生会话接收。
- Codex 本机 `thread/start → turn/start`、第二轮复用同一 thread、官方命令审批卡片和拒绝回传已通过；
  当前 routescope 中转的部分实测会额外等待 Codex 官方插件同步/上游重试，这是供应商/官方启动初始化
  延迟，不是 AgentHub 每轮重启 CLI。
