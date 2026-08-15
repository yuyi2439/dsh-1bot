# dsh-onebot

把 OneBot 11（QQ，NapCat / LLOneBot / Lagrange）变成 dsh 的一个 UI 表面 —— 与 web / tui
平级的 profile bundle，骑在 `@deepseek-ai/dsh-base` 之上。每个 QQ 聊天（私聊/群）对应一个
dsh agent + session：消息进来驱动回合，最终回复自动发回 QQ。

逻辑移植自本地 nota 项目的 `nota-onebot` crate（Apache-2.0）。

## 快速开始

```sh
cd <本仓库>
dsh plugin --profile onebot add .     # 初始化 profile 并安装本包
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
| `cwd` | `process.cwd()` | agent 会话工作区根 |
| `reply_chunk_size` | `4000` | 出站消息分块上限 |
| `approval_timeout_secs` | `300` | QQ 内审批超时（秒） |
| `console_log` | `true` | 把 onebot 日志打到控制台 |

## 工具

`onebot_send`、`onebot_read`（群/私聊历史）、`onebot_get_msg`、`onebot_status`（含连接状态）、
`onebot_voice_text`。统一 `onebot_` 前缀（`send_message` 是子 agent 控制的保留名）。
非白名单出站走 QQ 内审批：聊天里回复「同意」/「拒绝」（可带序号）裁决，超时/断连 fail-closed。

## 行为要点

- 入站非文本段渲染为 `[image msg id:N]` 占位符，模型用 `onebot_get_msg` / `onebot_voice_text` 取内容。
- 每聊天一个 agent/session（`onebot:private:<QQ>` / `onebot:group:<群号>`），JSONL 持久化、可 resume。
- 白名单为空 = 所有消息被忽略（启动时控制台会警告）。
- 日志形如 `[onebot info] 2026-…`；连不上 NapCat 会看到 `reconnecting` 重连循环。

## 开发

```sh
pnpm install      # 依赖（typescript / @types/node / @types/ws）
pnpm build        # src/*.ts → lib/*.js（profile 加载编译产物，改源码后必跑）
pnpm typecheck    # src + test 类型检查
pnpm test         # 23 个单测（Node ≥23.6 原生跑 .ts）
```

## License

Apache-2.0（移植自 nota）。
