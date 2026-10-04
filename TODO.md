# TODO

待办与已知取舍。用法与配置见 [README](README.md)，开发与硬性规范见
[CONTRIBUTING](CONTRIBUTING.md)；这里只列"还没做 / 不打算现在做"的事，每条写清
现状、原因与打算怎么办。

## 待办：刷屏防护（队列已删，还没有替代）

- 现状：`enqueueTurn` 直接把每条放行消息 `agent.followup()` 下去，**没有每聊天回合
  上限**。串行与排队由 dsh agent 自己的 inbox 负责（每个 followup 各自成为一个回合，
  driver 逐个消费）。
- 为什么删掉原来的队列：它（`turnChains` 串行 + `pendingTurns` 计数 +
  `max_pending_turns` 上限）是 dsh 已经提供的能力的重复实现，而且引入了第二个"回合
  状态"来源，出问题时表现为静默丢消息。
- 风险：白名单内的聊天在 agent 忙时连发 N 条，就是 N 个完整 LLM 回合排队（内存 +
  费用）。目前只有白名单与 `prefix` 两道闸门。
- 怎么办：还没定。候选是"按聊天做时间窗合并/丢弃"，或基于 `agent.status` / inbox
  长度做背压；不是把旧队列搬回来。

## 已知限制（不是 bug，是当前没做）

- **只支持正向 WebSocket**：反向 WS / HTTP 未实现；连接方式由 adapter 声明，新增一
  种连接方式是 adapter 的工作。
- **`onebot_get_msg_history` 依赖 NapCat/go-cqhttp 的扩展 action**：换其他实现端会
  直接报错并提示改用 `onebot_get_content`，没有回退路径。
- **会话 id 与工作区是本插件的约定**：会话 id `onebot-<kind>-<id>`，会话 cwd
  `<workspace_root>/chats/<sessionId>`。如果 dsh 之后允许按会话自定义持久化根或路由，
  这两处可以合并回 dsh 的默认做法。
- **会话与 web 隔离靠覆盖持久化根**：bundle patch 把 `session-persistence-jsonl.root`
  指到 `$DSH_HOME/sessions-hidden`，web profile（扫 `sessions/`）就看不到也 resume
  不了这些会话（原理见 README「会话与 web 隔离」与 `src/session.ts`）。上游若提供
  "某类会话不外扫"的正规开关，就改用那个。
