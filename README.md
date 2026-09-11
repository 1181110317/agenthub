# AgentHub · 聚合 Agent 工作台

一个本地 Web 工作台，把多个编码 Agent（Claude Code / Codex / ZCode / Gemini CLI / OpenCode / 自定义）聚合到同一个界面里。

> **内置 Agent（无需 CLI）**：借鉴 AionUi 的"零配置"能力——不装任何 CLI，选中「内置 Agent」+ 供应商 + 模型即可对话。引擎直连 Anthropic / OpenAI 兼容协议（自动识别），工具齐全：读写文件、列目录、执行命令、联网搜索(web_search)/网页抓取(web_fetch)、**一键生成 PPT / Word / Excel**。
> **定时任务**：侧栏「定时」可创建 每N分钟 / 每天定时 的自动化任务，到点自动向指定会话发送提示词（会话忙自动跳过）。
> **命令面板**：Ctrl+Shift+P 打开，新建任务 / 切主题 / 打开各面板 / 切 Agent 全部键盘可达。
> **会话分叉**：任意消息一键分叉为新会话（配置完整复制；本机支持的原生会话优先走原生分叉，旧版/远程不可用时才有限预算回放）。
> **界面缩放**：设置里可调 85%–130%，窄屏（手机/半屏）侧栏自动收纳为抽屉。
界面采用 harness 风格时间线（参考 deepseek-harness），架构上借鉴 AionUi 的「REST + WS 驱动 agent 内核」思想，保持零构建的原生 Web 实现。

## 启动

```bash
cd C:\agent\agenthub
npm start        # 或 node server.js
```

打开 http://127.0.0.1:7261 （仅监听本机）

**局域网 / 手机访问**（可选）：设环境变量后重启
```bash
AGENTHUB_HOST=0.0.0.0 AGENTHUB_TOKEN=任意密钥 npm start
```
手机/其他电脑访问 `http://本机IP:7261/?token=密钥`，令牌会记住。

## 功能

### 1. 多 Agent 切换 + harness 时间线
- 侧栏 Agent 卡片切换 Claude Code / Codex / ZCode / Gemini CLI / OpenCode，每个 Agent 有独立会话列表
- **时间线渲染（deepseek-harness 风格）**：每轮回复 = 过程步骤行（思考 / 工具调用 / 中间输出，带独立耗时与状态图标）
  + 最终回答区；运行中步骤行有扫光动画、头部显示「工作中 · N 秒 · tok/s」；
  **完成后自动合并为「已工作 X 分 X 秒 · N 个步骤」摘要行**，点击可随时展开回看全过程
- Claude 使用 **常驻双向流式桥**（`--input-format stream-json` 原生 SDK 协议）：多轮同进程原生续接、
  「询问」权限经 `--permission-prompt-tool stdio` 桥到网页确认（允许/拒绝真实生效）、AskUserQuestion
  在网页点选作答、图片以原生 content block 进上下文；闲置回收 / 重启后自动 `--resume` 无损重挂
- ZCode 本机使用官方 `app-server`（`session/create|resume|send|stop`）原生双向协议，多轮复用同一
  进程；权限/AskUserQuestion 由官方 interaction 请求桥到网页，图片走原生附件，内部 headless
  Browser Use 仍由 ZCode 自己执行。WSL/SSH 会在目标环境探测 `app-server`，通过持久 WSL/SSH
  stdin 通道走同一原生协议；不支持时才回落官方 CLI 入口。ZCode 没有统一的自更新命令，可在设置
  中填写目标环境的 `remoteBin` / `upgradeCommand`。
- Codex 本机使用官方 `app-server --stdio`（`thread/start|resume`、`turn/start|interrupt`）原生双向协议，
  多轮复用同一 thread；官方命令/文件/权限审批和用户提问桥到网页，图片走 `localImage` 原生附件。
  WSL/SSH 同样通过目标环境的持久 stdin 通道运行 `app-server --stdio`；若探测到旧版，会先调用
  目标环境的 `codex update`，升级失败才回落 `codex exec` / `exec resume`。
- Claude 的 WSL/SSH 也会探测 `--input-format`；不兼容时先调用目标环境的 `claude update`，成功后继续使用
  常驻 stream-json 桥。
- **rewind / 重试 / 分叉原生化**：Claude/Codex 直接对 CLI 自己的会话历史做「截断复制」换新会话
  id 续接；ZCode 本机使用官方 `session/fork`。只有旧版 CLI、远程协议不支持或原生文件手术失败时，
  才使用有预算的文本回放兜底，并在界面保留明确提示。
- **会话归档**：活跃会话超过上限时自动归档旧的非运行会话；可从命令面板恢复，归档失败不会删除活跃数据。
- 未检测到 CLI 的 Agent 可在「设置」里指定路径，也可添加自定义 Agent（原文流式输出）
- 会话级配置：供应商、模型、工作目录（问过话后锁定）、自动权限、推理强度（claude 走 `--settings` env、codex 走 `-c model_reasoning_effort`）、远程主机
- 文件修改 chips（diff 查看/撤销）、执行计划、图片内联、mermaid 图表渲染、网页 chip（内嵌浏览器抽屉）

### 1.5 会话内用量
- 头部「Σ 会话用量」：每轮输入/输出/缓存/合计 + 总计行 + 模型分布 + 上下文占用（按最后一次 API 调用计算）
- 每条回复尾部统计 pills：用时 / 输出 / 输入 / 实际模型

### 2. 供应商 / 模型管理（读取 cc-switch）
- 自动读取 cc-switch 的 SQLite 数据库，claude / codex / gemini / openclaw 供应商全部列出，密钥脱敏
- 拉取过的 `/v1/models` 模型目录会缓存（`data/model-cache.json`），发送栏模型菜单按「供应商目录 / 通用候选」分组展示
- Codex 供应商通过会话级 `CODEX_HOME` 注入 config.toml + auth.json；远程会话也会把配置映射到远端 `~/.agenthub-codex/`
- Claude 供应商通过 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` + `--settings` 会话级覆盖注入；
  ZCode 供应商通过进程级 `ZCODE_MODEL` / `ZCODE_BASE_URL` / `ZCODE_API_KEY` 注入（切换必生效）。ZCode 当前适配
  Anthropic Messages 通道；BigModel/Z.ai Coding Plan 的 OpenAI 地址会自动切换到官方 Anthropic 地址，普通资源包/预付余额的
  OpenAI 地址不能混用，界面会明确提示改用内置 Agent 的 OpenAI 通道或配置 Anthropic 兼容地址。
- 手动添加供应商（仅本应用）；余额查询（DeepSeek / OpenRouter / one-api 系自动识别）

### 3. Token 用量统计
- 实时落盘 + cc-switch 聚合 + 本地历史扫描（~/.claude / ~/.codex / ~/.zcode）
- 统计页首行：**今日 / 近 N 天 / 累计全部** 卡片 + 输入/输出/缓存/费用；每日堆叠柱状图、模型/Agent 环形图、明细表

### 4. SSH / WSL 远程
- SSH 主机管理（密码 / 私钥 / agent 认证，凭据仅存本机），远程会话流式回传，🖥 标识
- 本机 WSL 作为一等公民：🐧 独立分组、WSL 会话、WSL 终端，全部异步执行不阻塞服务
- 远程生成的图片可一键预览（走 SSH base64 回传）

### 5. 主题
- 🎨 菜单切换 4 套主题：**田园核风 / 墨夜 / 纸白 / 护眼林**；xterm 与 mermaid 配色跟随；本地记忆偏好

## 目录结构

```
agenthub/
├─ server.js          # Express + WebSocket 服务（API + 聊天/终端 WS 桥 + 图片预览 + 模型缓存）
├─ lib/
│  ├─ agents.js       # Agent 适配器（claude/codex/zcode/gemini/opencode/自定义，本地+WSL+远程）
│  ├─ ccswitch.js     # cc-switch SQLite 只读（providers / usage_rollups / 定价 / 错误透出）
│  ├─ balance.js      # 余额查询 + 模型列表
│  ├─ usage.js        # 用量记录 / 本地扫描 / 聚合
│  ├─ ssh.js          # ssh2 连接池 / exec / shell
│  └─ store.js        # JSON 持久化
├─ public/            # 前端（原生 JS 单页 + harness 时间线 + echarts + xterm + mermaid）
└─ data/              # 运行数据（sessions/usage/ssh/model-cache/settings）
```

## 说明

- 依赖：Node ≥ 22.5（内置 `node:sqlite` 读 cc-switch 数据库）；本机或 WSL/SSH 目标环境需安装对应的
  claude / codex / zcode CLI，远程原生桥会在首次连接时检查并按配置升级
- cc-switch 正在运行时以只读模式打开数据库，互不影响；不可读时界面会提示而不是静默空列表
- 「设为默认供应商」（★）只影响本应用新会话；不修改 cc-switch / 全局 CLI 配置
- 已知问题与修复记录见 [BUGS.md](BUGS.md)
