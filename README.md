# dsh-1bot

把 OneBot 11（QQ，NapCat / LLOneBot / Lagrange）变成 dsh 的一个 UI 表面 —— 与 web / tui
平级的 profile bundle，骑在 `@deepseek-ai/dsh-base` 之上。每个 QQ 聊天（私聊/群）对应一个
dsh agent + session：消息进来驱动回合；自动发送已移除——模型要说话必须显式
调用 `onebot_send`（每次调用立即发送），因为回合末自动投递会与模型主动发送
重复（双重回答）。

逻辑移植自 nota 项目（Rust）的 OneBot 桥接实现，Apache-2.0。

## 快速开始

```sh
dsh plugin --profile onebot add dsh-1bot     # 初始化 profile 并从 npm 安装
```

编辑 `$DSH_HOME/profiles/onebot/cordis.patch.yml`（id 定向 patch **整段替换** config，需重述所有字段）：

```yaml
- id: onebot
  config:
    enabled: true
    mode: ws
    ws_url: 'ws://127.0.0.1:3001'   # NapCat 正向 WS 地址
    access_token: ''
    prefix: ''
    friend_ids: [123456789]          # 白名单：你的 QQ
    group_ids: []                    # 白名单：群
    reply_chunk_size: 4000
    approval_timeout_secs: 300
    console_log: true
```

启动（NapCat 需开着正向 WS）：

```sh
dsh --profile onebot
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 启动桥接 |
| `mode` | `ws` | 仅支持 `ws`（正向 WebSocket） |
| `ws_url` | `ws://127.0.0.1:3001` | OneBot 实现地址 |
| `access_token` | `""` | 可选令牌（`Authorization: Bearer`） |
| `prefix` | `""` | 只回复以它开头的消息，并剥掉前缀 |
| `friend_ids` | `[]` | 私聊白名单；空 = 无人可入 |
| `group_ids` | `[]` | 群白名单；空 = 无群可入 |
| `workspace_root` | `$DSH_HOME/workspaces/onebot` | 聊天工作区根；每聊天一个 `<root>/chats/<sessionId>` 子目录（自动创建）。**稳定路径**，勿用随启动目录变化的路径，否则会话 cwd 冲突 |
| `connect_retries` | `5` | 启动连接失败后的重试次数（每次间隔 `connect_retry_delay_secs`） |
| `connect_retry_delay_secs` | `1` | 启动连接重试间隔（秒） |
| `reply_chunk_size` | `4000` | 出站消息分块上限 |
| `approval_timeout_secs` | `300` | 审批超时（秒）；QQ 内审批流已移除，字段休眠保留 |
| `console_log` | `true` | 把 onebot 日志打到控制台 |

## 工具

`onebot_send`（唯一发送途径，即时发送，可多段：先回复、查资料、再回复）、`onebot_get_msg_history`（群/私聊历史）、`onebot_get_content`、`onebot_status`（含连接状态）、
`onebot_voice_text`。统一 `onebot_` 前缀（`send_message` 是子 agent 控制的保留名）。
**自动发送已移除**：所有出站消息都由模型显式调用 `onebot_send` 发送；prompt/persona 注入不在本插件内（纯 adapter，由独立的 persona 层插件负责）。
非白名单目标的 `onebot_send` 直接报错——QQ 内审批流已移除，白名单外一律直接拒绝。

## 行为要点

- 入站非文本段按类型渲染（默认 `[<type> msg id:N k=v …]`，带上全部 data 和消息 id），模型用 `onebot_get_content` / `onebot_voice_text` 取内容。
- 每聊天一个 agent/session（`onebot-private-<QQ>` / `onebot-group-<群号>`，用 `-` 分隔避免磁盘转义），JSONL 持久化、可 resume；每聊天一个独立工作区 `<workspace_root>/chats/<sessionId>`。
- 白名单为空 = 所有消息被忽略（启动时控制台会警告）。
- 日志形如 `[onebot info] 2026-…`；连不上 NapCat 会看到 `reconnecting` 重连循环。
- **首次启动若配置里没有 onebot 配置**：自动在 `$DSH_HOME/profiles/onebot/cordis.patch.yml` 追加带注释的配置模板并提示你编辑，然后退出；编辑好再启动。
- **启动连不上 OneBot 是致命的**：重试 `connect_retries` 次（默认 5 次 × 1 秒）后报错退出（此路径不写配置文件——唯一写配置的是首次运行的模板门），检查 `ws_url`/`access_token` 后重新启动。
- **单实例**：第二个 dsh-1bot 进程会因锁（`<workspace_root>/.onebot.lock`）拒绝启动 —— 两个实例同时写同一会话会损坏日志。
- **会话与 web 隔离**：onebot 会话持久化在 `$DSH_HOME/sessions-hidden`（非 `sessions/`）。web UI 打开它可见的会话会 resume 成第二个写入者导致日志损坏，隔离后 web 看不到也碰不到；监视请用 onebot 进程控制台日志。

## 开发与贡献

开发者/贡献者请看 [CONTRIBUTING.md](CONTRIBUTING.md)：仓库结构、构建/测试命令、
发布流程、硬性规范（含改工具/模型后常见的 `session … (id collision)` 报错与处理）、
事件流与移植来源。

## License

Apache-2.0（逻辑移植自 nota 项目）。
