# CONTRIBUTING

## 仓库结构

```
src/
  index.ts    插件入口：name/inject/Config/apply；把配置与日志接入 cordis 生命周期；ctx.onebot 服务
  config.ts   **通用**配置 schema + 由它推导的 OnebotConfig 类型 + DEFAULTS
              + 每聊天工作区路径（defaultWorkspaceRoot/chatWorkspace）
  adapter/    **平台相关的一切**：见下节
    types.ts  adapter 契约：ChatRoute / RouteKind / RouteSpec / Adapter
    index.ts  实现表 + 注册表与解析辅助（routeSpecFor / parseTarget / routeHistory /
              sessionToRoute / allowlistFor…）
    qq.ts     QQ adapter 的实现（路由种类、OneBot action 名、白名单字段与 schema）
  log.ts      控制台导出器（mountConsoleExporter）+ 纯文本行渲染（formatLogLine）；
              **唯一**常规写进程控制台的地方（见「日志」）
  bridge.ts   OneBotBridge：**插件中枢**，持有完整的 OneBotClient 与 apply 收到的
              Context；dsh 服务（agents / sessions / sessionPersistence /
              agentDefaultModel）一律从 ctx 上取。回合路径（活 agent 复用 /
              resume / create → followup → flush）与出站分块都在这里
  service.ts  **对外的 `ctx.onebot` 服务**：OnebotService 形状 + 由 bridge 造值的
              publicService()。其他插件能看到的一切只在这里定义
  tools.ts    5 个 defineTool 定义（onebot_* 家族）；目标写法与历史动作取自 adapter 声明
  protocol.ts 与平台无关的报文处理：messageToText（按类型渲染消息段，默认 data 键=值）
              + 身份显示名 + 分块 + 历史格式化（零依赖）
  session.ts  会话身份（chatSessionId / chatRoute / messageRoute / sessionToRoute）
              与 sessions-hidden 根与 README。agent 与会话生命周期都由 dsh 提供
  profile-setup.ts    首次设置时向 profile patch 追加注释版配置模板
  connect-error.ts    拼装启动连接失败的致命报告（TCP 探测 + 文案）
  singleton.ts        pid 锁位于 `<workspace_root>/.onebot.lock`（只允许一个桥接实例）
test/         node:test，直接导入 src/*.ts（client.test.ts 经本地 ws 服务器实测 onebot.js；
              其余测试用真实 cordis Context + ctx.provide 装假件）
```

## adapter 层（平台相关的一切）

一个 **adapter** 就是"某种聊天平台/协议在 dsh 里的接入方式"。它声明：

- `routes` —— 支持哪些**路由种类**，以及每个种类的全部接线方式：会话 id 里承载
  目标号的字段、身份标签、目标字符串解析、出站动作、读历史动作；
- `allowlists` —— 路由种类 → 该种类白名单所在的配置字段名；
- `config` / `defaults` —— 它自己的配置 schema 与默认值。

**通用配置**（连接地址、分块、工作区…）不属于任何 adapter，留在
config.ts。**平台相关的配置**由各 adapter 声明，在配置里通过 `adapters` 列表按
`type` 选中：

```yaml
adapters:
  - type: <已实现的 adapter 类型之一>   # 具体取值见 src/adapter/index.ts 的实现表
    config: { … }                      # 该 adapter 自己的字段（如白名单）
```

**新增一种 adapter** = 在 `src/adapter/` 加一个实现文件 + 注册进实现表。会话 id、
目标解析、出站、读历史、白名单、启动摘要与种子模板都会自动支持；session.ts /
bridge.ts / tools.ts 都不需要改动。契约与实现表见 adapter/types.ts 与
adapter/index.ts —— **类型清单只在实现表里出现一次，其它地方一律抽象表述**
（见 AGENTS.md「Comments Must Not Enumerate Constants」）。

**config.ts 是唯一通用配置真源**：`Config` 是通用字段的**唯一**定义处，
`OnebotConfig` 由它推导（`ReturnType<typeof Config>`），**不手写第二份字段
清单**——手写接口与 schema 会各自漂移，而 `z<手写接口>` 只是类型断言，管不住
漏写的字段。默认值都取自 `DEFAULTS`；每个字段都有默认值，所以解析结果总是完整
的，调用方不需要 `?? 默认值` 兜底。

**session.ts 是唯一会话身份真源**：会话 id 只在 `chatSessionId` / `chatRoute`
里拼、只在 `sessionToRoute` / `messageRoute` 里解析，bridge.ts / tools.ts 绝不
自己拼。会话与 agent 的生命周期、回合队列、持久化都直接用 dsh 的
`ctx.sessions` / `ctx.agents` / `ctx.sessionPersistence`——本插件不再自建管理器。

**adapter/index.ts 是唯一路由真源**：路由种类与接线方式由各 adapter 声明并汇总
到那里；本插件面向整个 OneBot 协议族（不止 QQ），具体种类只是当前实现表的内容。
见硬性规则 9。

## 日志

**插件只使用 cordis 的 logger**：入口 `apply` 与 bridge 都用
`ctx.logger("onebot")` 取同一个 logger（同样的 name 就是同一个 logger）。`ctx.logger`
是 cordis 的内建服务（`Context` 构造时就装好），任何 ctx 都有它 —— 不存在"没有
logger 的 ctx"，所以任何地方都不写 `?? console` 之类的兜底，也不直接调
`console.*`。名字固定为 `onebot`：控制台 exporter 按 `message.name` 精确匹配等级
（硬性规则 7），换个名字的 logger 会被 `default: -1` 吞掉。

允许写进程控制台的只有两处：`src/log.ts` 的 `mountConsoleExporter`（它存在的意义
就是把结构化记录渲染成终端可见的行），以及**无法挽回的崩溃**路径 —— 那种时候
logger 通路本身可能已经不可用，用 `console` / `process.stderr.write` 应急输出是
允许的。onebot.js 的 WS 客户端也只通过调用方传入的 logger 记录自己的生命周期与
协议告警，本插件传进去的就是这个 `onebot` logger。

## 构建 / 类型检查 / 测试

```sh
pnpm install      # 依赖（typescript / @types/node / @types/ws）
pnpm build        # src/*.ts → lib/*.js（profile 加载编译产物，改源码后必跑）
pnpm typecheck    # src + test 类型检查
pnpm test         # 运行测试（Node ≥23.6 原生跑 .ts）
```

**测试与平台无关**：断言里不得出现某个操作系统的字面量（盘符、反斜杠路径、专有
目录名）；需要路径样本时用 `node:os` 的 `tmpdir()` / `homedir()` 配合 `join()`
拼出来，`process.chdir` 之类改变全局状态的操作也要在同一测试里还原。时区、区域
设置、临时目录位置等系统配置的差异都不能改变结果 —— CI 与发布都跑在 Linux 上。

**测试不得反过来塑造主体代码**：`OneBotBridge` 拿的是完整的 `client` 与 `Context`，
测试就照这个形状来 —— `new Context()` + `ctx.provide(名字, 假件)`
（`test/bridge.test.ts` 的做法），而不是为了好替身而给生产代码加一层服务切片参数。

**服务取法**：运行时只有一种取法（按名字查表），`ctx.agents` 只是糖。能写成属性
的前提是**声明该服务的包的类型进入了编译**——本插件 import 了 `dsh-agent` /
`dsh-session`，所以 `ctx.agents` / `ctx.sessions` 有类型；`agentDefaultModel` 与
`sessionPersistence` 的声明包没有（前者没被任何文件 import，后者还不是依赖），
所以这两处用 `ctx.get("名字")`。想让它们也变成属性，得加一条
`import type {} from "@deepseek-ai/dsh-agent-default-model"`（以及把
`@deepseek-ai/dsh-session-persistence` 加进 peer/devDependencies 后同样处理）。

## 发布流程

Tag 驱动、版本只校验不改写：先改 `package.json` 的 `version`（提交），再打
匹配的 tag —— `git tag v0.0.1 && git push origin main && git push --force origin v0.0.1`。
`.github/workflows/publish.yml` 在 `package.json` version 与 tag 不一致时快速失败，
跑 typecheck + tests 后用仓库 secret `NPM_TOKEN`（必须是 bypass-2FA 的 token）
发布到 npm。`lib/` 被 gitignore，workflow 靠 `prepack: pnpm build` 发布新构建。

## 硬性规则（不可破坏）

1. **工具名必须带`onebot_`前缀。** `send_message` 是 dsh 生态保留名（子
   agent 控制的 follow-up 工具）；全局重名会导致启动失败。
2. **schemastery 没有`.optional()`** —— 对象字段默认可选，`cwd: z.string()`
   即可。
3. **`src/`内相对导入必须带`.ts`后缀**（Node 原生执行；tsc 的
   `rewriteRelativeImportExtensions` 会在产物里改写为 `.js`）。
4. **`defineTool`从`parameters`/`output.schema`推断`execute`的`args`
   和返回类型**；返回值必须匹配 output schema（`additionalProperties: false`
   强制）。
5. **OneBot 响应成功判定**：`retcode === 0`，或缺 `retcode` 时 `status === "ok"`；
   否则抛模型可读错误（带 action 名 / status / retcode / data 详情）。
   `get_friend_msg_history` 是 NapCat/go-cqhttp 扩展——不兼容时直接报错并
   建议改用 `onebot_get_content`（用报错代替"没有消息"的空结果，避免模型
   误判）。
6. **出站全部显式走`onebot_send`**：唯一发送途径是 `onebot_send`（目标须
   白名单，非白名单抛错），每次调用立即发送，模型可以"先回复、再查资料、
   再回复"（同回合多段）；`sendReply` 对每次调用原样发送（只做分块，分块间按
   `reply_chunk_delay_ms` 限速，防 QQ 风控），重复与否由模型自己负责，插件
   不做任何去重。
   prompt/persona 注入由独立的 persona 层插件负责（本插件是纯 adapter）。
7. **控制台 exporter 的`levels`必须含`default: -1`**（位于
   src/log.ts 的 `mountConsoleExporter`）：写
   `{ onebot: 2, default: -1 }` 只放行 onebot logger。只写 `{ onebot: 2 }`
   会泄漏其他插件的 info 日志到控制台；`[onebot info]` 标签来自
   `message.name`，绝不硬编码。`test/log.test.ts` 锁住这两点。
8. **用`ctx.effect(() => () => {...})`做清理**：清理必须调 `client.disconnect()`
   并释放单例锁，否则 HMR 重载会留下僵尸连接。创建出的 agent 由 cordis 随创建它
   的 fiber 一起释放，不需要（也不能）手动 dispose。
9. **平台相关的一切只能来自 `src/adapter/` 的 adapter 声明，任何地方都不许写死
   具体的平台、路由种类或它们的 action 名。** 本插件面向**整个 OneBot 协议族
   （不止 QQ）**，当前有哪些种类只是实现表的内容（见 adapter/index.ts）。
   - 新增一种 adapter = 在 `src/adapter/` 加实现 + 注册进实现表。会话 id
     （`onebot-<kind>-<id>`）、目标字符串（`<kind>:<id>`）、入站路由、出站动作名
     与参数、读历史动作、白名单字段全部由 adapter 声明派生；session.ts /
     bridge.ts / tools.ts 都不需要改。
   - 会话 id 只在 src/session.ts 里拼（`chatSessionId`）与在 adapter/index.ts 里
     解析（`sessionToRoute`），其他文件不得自己拼。
   - 出站只在 bridge.ts 的 `sendReply` 里经该种类的 `action(...)` 取动作名与参数；
     任何 action 名字面量只允许出现在 adapter 实现里。
   - **平台相关的配置字段（如白名单）只属于对应 adapter 的 `config` schema，不得
     加回 `src/config.ts` 的通用 `Config`。**
   - `test/adapter.test.ts` 与 `test/session.test.ts` 遍历全部已注册 adapter 与
     种类做往返断言：新增一种 adapter 时它们自动覆盖新种类。
10. **id 定向 patch 整段替换该条目的 `config`**：profile 组合（`dsh-app-boot` 的
    `applyEntryPatches`）把 patch 的顶层键直接赋给目标条目——`config` 是顶层键，
    所以 `- id: X / config: {...}` 是 `target.config = {...}`，不是逐字段合并。
    在 `$DSH_HOME/profiles/onebot/cordis.patch.yml` 里写某个条目的 `config` 时，
    要重述所有想保留的字段；bundle 层给同一条目设过的值会被这一层覆盖掉。
11. **`lib/`被 gitignore**：提交/发布只带 `src/` 和 `cordis.patch.yml`；
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
15. **onebot 会话只放`$DSH_HOME/sessions-hidden`，绝不放`sessions/`**：
    web UI 打开它可见的会话会 resume（`dsh-api-session-controller` 调
    `ctx.agents.resume`），
    变成同一日志的第二个活写入者导致损坏（重复 seq）。bundle patch 把
    `session-persistence-jsonl.root` 覆盖为 `dshHomePath('sessions-hidden')`——
    同样的 jsonl 后端和默认值，只是根不同，web profile（扫 `sessions/`）既看不到
    也无法 resume。启动时插件还会建根并种下 README（`ensureHiddenSessionsDocs` /
    `hiddenSessionsRoot`，src/session.ts）。
16. **启动连不上是致命的**：`client.start()` 只在首次连接成功后 resolve；
    `connect_retries`（默认 5）次 × `connect_retry_delay_secs`（默认 1）后
    reject，`apply` 打日志给指引并 `process.exit(1)`。报告由
    `formatConnectFailure`（src/connect-error.ts）拼成**一条**记录：原因 +
    实际尝试的 ws_url + access_token 是否设置 + 解析后的配置文件路径 + 重试
    预算与"进程已退出"，先用 `probeForwardWsPort` 实测一次 TCP 可达性再给指引
    ——"端口没人监听"和"连上被拒"要查的方向相反，而 WS 错误本身分不出来
    （close code/reason 由该 fork 的 `connect()` 回报）。此路径绝不能写
    配置文件——下面的首次运行 gate 是唯一写入者。重连完全由 onebot.js 的
    `reconnection` 驱动：运行期掉线用同样的预算（次数 + 间隔）重试，耗尽后
    **停止重连**，恢复需重启进程。
17. **首次运行配置 gate**：profile patch 没有 `- id: onebot` 行时，
    `seedProfilePatch` 往 `$DSH_HOME/profiles/onebot/cordis.patch.yml` APPEND
    一个全注释的配置模板，`apply` 打印如何配置并 `process.exit(1)`（在连接之前）。
    这是唯一写配置文件的地方。已存在的内容一律 append，覆盖写入已禁止；
    触发条件固定为"缺 `- id: onebot` 行"。
18. **已有持久化日志时绝不能 `create`，必须 `resume`**：`create` 在会话 id 已被
    占用时必然失败 ——`sessionPersistence.create()` 见到该 id 已有日志就无条件抛
    `SessionAlreadyExistsError`（`session "<id>" already exists`）。这是**防损坏
    保护**：日志 append-only，两个 seed 混写会破坏回放。而 `agents.get(id)` 只认
    本进程内存里的活 agent：**重启后日志还在磁盘、注册表已清空**，所以固定走
    `create` 的实现在重启后对每个已有聊天都抛这个错，表现为"连接正常、机器人
    永久不回复"（控制台只有一行 `turn failed … already exists`）。
    正确做法（`OneBotBridge.enqueueTurn`）：先 `agents.get(id)`；没有活 agent 时用
    `ctx.sessionPersistence.stat(id)` 判有无持久化日志（不读事件日志、不取写所有
    权），有则 `agents.resume({ resumeSessionId })`，无则 `agents.create(...)`。
    于是重启、以及改工具/模型选择之后，会话都从既有历史继续，**不需要删日志**。
    seed（首个 `request/header` 事件）不匹配不是问题：resume 把既有事件当 seed
    载入，下个请求追加新的 `request/header`——这也正是 dsh 自己 resume 的路径。
    `test/bridge.test.ts` 把 create / resume / 活 agent 复用三个分支都锁住。

## 事件流

```
QQ inbound ──► OneBotClient (forward WS) ──► Bridge.onMessageEvent
  · self-messages (user_id===self_id) / allowlist / prefix gate 在这里拦截，绝不进 agent
  · 非文本段 → 按类型渲染（默认 `[<type> msg id:<id> k=v …]`）；身份前缀
    `[好友 A(QQ)]` / `[群 N A(QQ)]`（chatRoute，src/session.ts）
→ Bridge.enqueueTurn（`agents.get` 命中就复用；否则 stat → resume / create，
  两条创建路径都装默认模型选择 installModelSelection，cwd = `workspace_root/chats/<sessionId>`）
→ agent.followup(userMessage) → whenIdle() → sessions.flush()
→ （模型在同回合内任意时刻调 onebot_send，每次调用立即投递）
→ sendReply：分块（reply_chunk_size，分块间 reply_chunk_delay_ms 限速）→
   send_private_msg / send_group_msg
```

排队与串行由 dsh agent 自己的 inbox 负责（`followup` 的每个条目各自成为一个
回合），本插件不再自建队列——见 TODO.md 关于刷屏防护的遗留项。

非白名单目标的 `onebot_send` 抛错；`onebot_send` 是唯一出站途径，当前聊天
回复也用它（目标为该聊天 id），即时发送、可多段。

## 依赖来源

- WS 协议/echo 层：[onebot.js](https://www.npmjs.com/package/onebot.js)
  （node-napcat-ts 的改名 fork；本插件用它做连接、invoke 与 echo 关联）。
- 会话驱动（agents.create / resume / followup / whenIdle / flush）：直接用
  dsh 的服务（`ctx.agents` / `ctx.sessions` / `ctx.sessionPersistence`），
  参考实现是 `@deepseek-ai/dsh-headless` 的 runner。

