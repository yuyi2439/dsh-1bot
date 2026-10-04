# dsh-1bot

把 OneBot 11 变成 dsh 的一个 UI 表面 —— 与 web / tui
平级的 profile bundle，骑在 `@deepseek-ai/dsh-base` 之上。每个 QQ 聊天（私聊/群）对应一个
dsh agent + session：消息进来驱动回合；模型要说话必须显式调用 `onebot_send`
（每次调用立即发送，同一回合内可多段）。

Onebot 协议层（连接/重连/echo/类型化 API）由 [onebot.js](https://www.npmjs.com/package/onebot.js) 提供

## 快速开始

#### 安装 dsh-1bot
```sh
dsh plugin --profile onebot add dsh-1bot     # 初始化 profile 并从 npm 安装
```

#### 修改配置
编辑 `$DSH_HOME/profiles/onebot/cordis.patch.yml` (`$DSH_HOME`默认为`~/.dsh`)

#### 启动：
```sh
dsh --profile onebot
```

## 配置

> **连接方式**：目前**只支持正向 WebSocket**（本插件主动连到 OneBot 实现端的
> `url`）。反向 WebSocket（实现端连过来）与 HTTP API 都**未实现**。

### 通用字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 启动桥接 |
| `access_token` | `""` | 可选令牌，以 `?access_token=` 查询参数附加到 adapter 的连接 `url`（OneBot 11 正向 WS 约定） |
| `prefix` | `""` | 只回复以它开头的消息，并剥掉前缀。**群聊生产环境强烈建议设置**：留空时白名单内的每条消息都会触发一次完整 agent 回合（成本） |
| `adapters` | 一条 QQ 记录 | 要接入的 adapter 列表，见下节 |
| `workspace_root` | `$DSH_HOME/workspaces/onebot` | 聊天工作区根；每聊天一个 `<root>/chats/<sessionId>` 子目录（自动创建）。**稳定路径**，勿用随启动目录变化的路径，否则会话 cwd 冲突 |
| `connect_retries` | `5` | 启动连接失败后的重试次数（每次间隔 `connect_retry_delay_secs`） |
| `connect_retry_delay_secs` | `1` | 启动连接重试间隔（秒） |
| `reply_chunk_size` | `4000` | 出站消息分块上限 |
| `reply_chunk_delay_ms` | `300` | 同一条回复的分块发送间隔（毫秒），避免多块连发触发风控 |
| `console_log` | `true` | 把 onebot 日志打到控制台 |
| `log_local_time` | `true` | 控制台日志的时间戳用本机时区（`Date#toString()`）；关闭则用 ISO/UTC（`toISOString()`） |

### adapters（平台相关的配置）

每个 adapter 负责一种聊天平台的接入方式，并**自带**它需要的配置字段：连接地址、
白名单等。通用字段里没有它们；按 `type` 选中 adapter，具体可用的 `type` 与各自的
`config` 字段见 `src/adapter/` 下的实现：

```yaml
- id: onebot
  config:
    enabled: true
    adapters:
      - type: qq                        # adapter 类型（取值见 src/adapter/ 的实现表）
        config:
          url: 'ws://127.0.0.1:3001'    # 实现端的正向 WebSocket 地址
          friend_ids: [123456789]       # 该 adapter 自己的白名单字段
          group_ids: []
```

`config` 里没写的字段用该 adapter 声明的默认值。未列出的 adapter = 不接入；
adapter 里没声明的路由种类一律不放行（白名单为空 = 谁都不放行）。
连接地址也来自 adapter 的配置：没有任何已启用 adapter 声明连接地址时，插件报错
退出而不是空转。

## 工具

`onebot_send`（唯一发送途径，即时发送，可多段：先回复、查资料、再回复）、`onebot_get_msg_history`（会话历史）、`onebot_get_content`、`onebot_status`（含连接状态）、
`onebot_voice_text`。统一 `onebot_` 前缀（`send_message` 是子 agent 控制的保留名）。
**所有出站消息都由模型显式调用 `onebot_send` 发送**；prompt/persona 注入由独立的 persona 层插件负责（本插件是纯 adapter）。
非白名单目标的 `onebot_send` 直接报错：白名单外一律直接拒绝。

## 行为要点

- 入站非文本段按类型渲染（默认 `[<type> msg id:N k=v …]`，带上全部 data 和消息 id），模型用 `onebot_get_content` / `onebot_voice_text` 取内容。
- 每聊天一个 agent/session（会话 id 为 `onebot-<kind>-<id>`，种类由 adapter 声明；用 `-` 分隔避免磁盘转义），JSONL 持久化、可 resume；每聊天一个独立工作区 `<workspace_root>/chats/<sessionId>`。
- **首次启动若配置里没有 onebot 配置**：自动在 `$DSH_HOME/profiles/onebot/cordis.patch.yml` 追加带注释的配置模板并提示你编辑，然后退出；编辑好再启动。
- **启动连不上 OneBot 是致命的**：重试 `connect_retries` 次（默认 5 次 × 1 秒）后报错退出，并打印一条自足诊断：失败原因、实际尝试的 `ws_url`、`access_token` 是否设置、解析后的配置文件路径、重试预算，以及**实测** TCP 可达性给出的下一步（端口没人监听 → 启动实现端；端口通却被拒 → 核对令牌/路径）。此路径不写配置文件（唯一写配置的是首次运行的模板门）；改完运行 `dsh --profile onebot`。
- **单实例**：第二个 dsh-1bot 进程会因锁（`<workspace_root>/.onebot.lock`）拒绝启动 —— 两个实例同时写同一会话会损坏日志。
- **会话与 web 隔离**：onebot 会话持久化在 `$DSH_HOME/sessions-hidden`（非 `sessions/`）。web UI 打开它可见的会话会 resume 成第二个写入者导致日志损坏，隔离后 web 看不到也碰不到；监视请用 onebot 进程控制台日志。

## 开发与贡献

开发者/贡献者请看 [CONTRIBUTING.md](CONTRIBUTING.md)（仓库结构、构建/测试命令、
发布流程、硬性规范与事件流）；待办与已知取舍见 [TODO.md](TODO.md)。

## 致谢

- [nota](https://github.com/yuyi2439/nota)：本插件的 OneBot 桥接与工具最早从它的
  Rust `nota-onebot` 模块移植而来。

## License

Apache-2.0。
