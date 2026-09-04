# CONTRIBUTING

面向贡献者/维护者（含 AI 编码助手）的开发说明。普通用户请看
[README.md](README.md) —— 本文件只放 README 之外的内容：仓库结构、
构建/测试、发布流程、硬性规则、事件流、排障与移植来源。

## 仓库结构

```
src/
  index.ts    plugin entry: name/inject/Config/apply; console log exporter; ctx.onebot service
  bridge.ts   OneBotBridge: chat⇄agent, allowlist, explicit onebot_send sends, outbound chunking
  tools.ts    5 defineTool definitions (onebot_* family)
  protocol.ts messageToText (per-type segment rendering, default data key=value) + target parsing + history formatting (dependency-free)
  types.ts    shared types: OnebotConfig / BridgeServices (structural service slice) / OnebotService
  hidden-sessions.ts  seeds `$DSH_HOME/sessions-hidden/README.md` (web-resume hazard)
  profile-setup.ts    seeds the profile patch with a commented config template on first setup
test/         node:test, imports src/*.ts directly (client.test.ts exercises onebot.js
              over a local ws server; the rest use structural fakes)
```

WS 协议层（连接/重连/echo/类型化 API/OnebotApiError）由
[onebot.js](https://www.npmjs.com/package/onebot.js) 提供——本项目不再自带
client 适配层，`index.ts` 用它的 `connect()` 工厂建立连接。

`lib/` 是编译产物（gitignore）——**改完 `src/` 必须 `pnpm build`**：profile
加载的是本 linked repo 的 `lib/`，不重建会一直用旧产物。

## 构建 / 类型检查 / 测试

```sh
pnpm install      # 依赖（typescript / @types/node / @types/ws）
pnpm build        # src/*.ts → lib/*.js（profile 加载编译产物，改源码后必跑）
pnpm typecheck    # src + test 类型检查
pnpm test         # 43 个单测（Node ≥23.6 原生跑 .ts）
```

## 发布流程

Tag 驱动、版本只校验不改写：先改 `package.json` 的 `version`（提交），再打
匹配的 tag —— `git tag v0.0.1 && git push origin main && git push --force origin v0.0.1`。
`.github/workflows/publish.yml` 在 `package.json` version 与 tag 不一致时快速失败，
跑 typecheck + tests 后用仓库 secret `NPM_TOKEN`（必须是 bypass-2FA 的 token）
发布到 npm。`lib/` 被 gitignore，workflow 靠 `prepack: pnpm build` 发布新构建。

## 硬性规则（不可破坏）

1. **工具名必须带 `onebot_` 前缀。** `send_message` 是 dsh 生态保留名（子
   agent 控制的 follow-up 工具）；全局重名会导致启动失败。
2. **schemastery 没有 `.optional()`** —— 对象字段默认可选，`cwd: z.string()`
   即可。
3. **`src/` 内相对导入必须带 `.ts` 后缀**（Node 原生执行；tsc 的
   `rewriteRelativeImportExtensions` 会在产物里改写为 `.js`）。
4. **`defineTool` 从 `parameters` / `output.schema` 推断 `execute` 的 `args`
   和返回类型**；返回值必须匹配 output schema（`additionalProperties: false`
   强制）。
5. **OneBot 响应成功判定**：`retcode === 0`，或缺 `retcode` 时 `status === "ok"`；
   否则抛模型可读错误（带 action 名 / status / retcode / data 详情）。
   `get_friend_msg_history` 是 NapCat/go-cqhttp 扩展——不兼容时直接报错并
   建议改用 `onebot_get_content`（静默返回"没有消息"的空结果已移除，避免
   模型误判）。
6. **自动发送与回复槽已移除——出站全部显式走 `onebot_send`**：桥接层曾在
   回合结束时自动投递最终助手文本，导致与模型主动发送重复（双重回答），
   该机制连同按聊天暂存回复的槽一并移除（槽机制只增加延迟）。现在唯一发送
   途径是 `onebot_send`（目标须白名单，非白名单抛错），每次调用立即发送，
   模型可以"先回复、再查资料、再回复"（同回合多段）；`sendReply` 对每次
   调用原样发送（只做分块），重复与否由模型自己负责，插件不做任何去重。
   prompt/persona 注入不在本插件内（adapter 定位，由独立的 persona 层插件负责）。
7. **控制台 exporter 的 `levels` 必须含 `default: -1`**：写
   `{ onebot: 2, default: -1 }` 只放行 onebot logger。只写 `{ onebot: 2 }`
   会泄漏其他插件的 info 日志到控制台；`[onebot info]` 标签来自
   `message.name`，绝不硬编码。
8. **用 `ctx.effect(() => () => {...})` 做清理**（cordis 4 没有类型化的
   `dispose` 事件）；清理必须同时调 `client.disconnect()` 和 `bridge.dispose()`，
   否则 HMR 重载会留下僵尸连接。
9. **会话 id 格式** `onebot-private-<QQ>` / `onebot-group-<群号>`
   （`sessionToRoute` 反向解析）。分隔符故意用 `-`：`:` 会被 JSONL 后端转义成
   `~003A`（Windows 安全路径段），`-` 原样保留。
10. **profile 用户层 patch 整体替换 config**：编辑
    `$DSH_HOME/profiles/onebot/cordis.patch.yml` 时要重述所有保留字段。
11. **`lib/` 被 gitignore**：提交/发布只带 `src/` 和 `cordis.patch.yml`；
    npm `files` 只发布构建后的 `lib/`。
12. **`ctx.onebot`**：运行时 = apply 里 `ctx.provide("onebot", service)`
    （随插件 fiber 自动释放）；类型侧 = src/index.ts 里的
    `declare module "@deepseek-ai/cordis"` 增强。消费方用 `ctx.onebot` /
    `ctx.get("onebot")`。
13. **会话 cwd 必须与启动目录无关**：默认工作区根是稳定的
    `$DSH_HOME/workspaces/onebot`（`defaultWorkspaceRoot()`），每个聊天会话用
    `<root>/chats/<sessionId>`（`chatWorkspace()`，首次使用时创建）。绝不要用
    `process.cwd()` 推导会话 cwd——会话 id 跨重启稳定，随启动目录变化的 cwd
    会让 store 以 persisted-vs-live cwd 冲突拒绝该 id。
14. **只能有一个实例**：两个 `dsh` 进程在同一 profile 上跑 onebot 插件会桥接
    同样的聊天、以各自独立的 seq 计数器追加到同一持久化会话，损坏日志
    （重复/缺失 seq——web UI 报 "corrupt session log"）。`apply` 在
    `<workspace_root>/.onebot.lock` 拿 pid 锁（`acquireSingletonLock`，
    src/singleton.ts），另一个活实例持锁时拒绝启动；teardown 释放。onebot
    行只挂在 onebot profile，同一聊天只由一个实例桥接。
15. **onebot 会话只放 `$DSH_HOME/sessions-hidden`，绝不放 `sessions/`**：
    web UI 打开它可见的会话会 resume（dsh-host-apiproxy 的 `agents.resume`），
    变成同一日志的第二个活写入者导致损坏（重复 seq）。bundle patch 把
    `session-persistence-jsonl.root` 覆盖为 `dshHomePath('sessions-hidden')`——
    同样的 jsonl 后端和默认值，只是根不同，web profile（扫 `sessions/`）既看不到
    也无法 resume。启动时插件还会建根并种下 README（`ensureHiddenSessionsDocs`，
    src/hidden-sessions.ts）。
16. **启动连不上是致命的**：`client.start()` 只在首次连接成功后 resolve；
    `connect_retries`（默认 5）次 × `connect_retry_delay_secs`（默认 1）后
    reject，`apply` 打日志给指引并 `process.exit(1)`。此路径绝不能写配置文件——
    下面的首次运行 gate 是唯一写入者。重连完全由 onebot.js 的
    `reconnection` 驱动：运行期掉线用同样的预算（次数 + 间隔）重试，耗尽后
    **停止重连**（不再有旧的永久重连循环），恢复需重启进程。
17. **首次运行配置 gate**：profile patch 没有 `- id: onebot` 行时，
    `seedProfilePatch` 往 `$DSH_HOME/profiles/onebot/cordis.patch.yml` APPEND
    一个全注释的配置模板，`apply` 打印如何配置并 `process.exit(1)`（在连接之前）。
    这是唯一写配置文件的地方。已存在的内容一律 append，覆盖写入已禁止；
    触发条件固定为"缺 `- id: onebot` 行"。
18. **seed 不匹配 id collision（每次改工具/模型后都会复发）**：会话 seed
    （初始 `request/header` + 工具定义快照）每次 `agents.create` 都会重新生成。
    改了 onebot 工具集（名字、描述）、默认模型或 `agentOptions` 就会变 seed，
    持久化层因此拒绝把新活会话接到旧磁盘日志上：
    `session "<id>" already has a persisted log on disk that does not match
    this live session (id collision)`（dsh-session-persistence 的
    `adoptLivePrefix` 要求 `seedCoversPrefix`——活 seed 必须逐条前缀匹配已存
    事件，`JSON.stringify` 相等）。这是**防损坏保护，不是 bug**：日志 append-only，
    混两个 seed 会破坏回放。处理：停 dsh，删
    `$DSH_HOME/sessions-hidden/<normalized-cwd-dir>/<sessionId>/` 下的旧日志
    （目录名是 `--` + cwd 分隔符归一化成 `-` + `--`，例如
    `--C-Users-<user>-.dsh-workspaces-onebot-chats-onebot-group-551947633--`），
    重启，下一条消息会建全新会话。代价：该聊天旧历史反正已不可恢复。凡动工具或
    模型选择的重构后都预期会遇到——发版说明里提一句。升级 dsh 基线（peer
    版本变更）同样会改 seed（`request/header` 由 dsh 侧组装），处理方式相同。

## 事件流

```
QQ inbound ──► OneBotClient (forward WS) ──► Bridge.onMessageEvent
  · self-messages (user_id===self_id) / allowlist gate 在这里拦截，绝不进 agent
  · 非文本段 → 按类型渲染（默认 `[<type> msg id:<id> k=v …]`）；身份前缀
    `[好友 A(QQ)]` / `[群 N A(QQ)]`
→ enqueueTurn（每聊天串行）→ ensureAgent（agents.create + 默认模型选择 +
   installModelSelection；会话 cwd = `workspace_root/chats/<sessionId>`，
   先 mkdir -p）
→ agent.followup(userMessage) → whenIdle() → sessions.flush()
→ （自动发送已移除；模型在同回合内任意时刻调 onebot_send，每次调用立即投递）
→ sendReply：分块（reply_chunk_size）→ send_private_msg / send_group_msg
```

非白名单目标的 `onebot_send` 抛错；`onebot_send` 是唯一出站途径，当前聊天
回复也用它（目标为该聊天 id），即时发送、可多段。

## 移植来源

- 协议层 / Bridge / 审批 / 工具：移植自 nota 项目（Rust）的 `nota-onebot`
  模块（types / client / api / bridge / config / tools）。
- WS 协议/echo 层：[onebot.js](https://www.npmjs.com/package/onebot.js)
  （node-napcat-ts 的改名 fork；`fetch_ptt_text` 扩展、宽松成功判定、
  `OnebotApiError`/`invoke`/`connect` 工厂在本 fork 补充）。
- 会话驱动（agents.create / followup / whenIdle / event folding）：参照
  `@deepseek-ai/dsh-headless` runner。
