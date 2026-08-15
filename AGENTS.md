# AGENTS.md

Project notes for AI coding assistants. Read [README](README.md) first for the
what and why, then follow this file when working on the code.

## What this is

`dsh-onebot` is a Cordis plugin / dsh profile bundle that makes OneBot 11 (QQ)
a dsh UI surface (same standing as web/tui). Each QQ chat maps to one dsh
agent + session; inbound messages drive agent turns and the final assistant
text is sent back to QQ; outbound messages and tool permissions outside the
allowlist go through in-chat approval (同意/拒绝). The logic is ported from the
`nota-onebot` crate of the local `nota` repo (Apache-2.0).

## Commands

```sh
pnpm install      # dependencies
pnpm build        # src/*.ts → lib/*.js (the profile loads the compiled output)
pnpm typecheck    # type-check src + test
pnpm test         # unit tests (Node ≥ 23.6 runs .ts natively, no build needed)
```

**Always `pnpm build` after changing `src/`** — the profile links to this repo
and otherwise keeps loading the stale `lib/`.

## Layout

```
src/
  index.ts    plugin entry: name/inject/Config/apply; console log exporter; ctx.onebot service
  client.ts   OneBotClient: forward WS, echo-correlated call(), reconnect backoff (terminate-style stop)
  bridge.ts   OneBotBridge: chat⇄agent, allowlist, outbound chunking, QQ in-chat approval answerer
  tools.ts    5 defineTool definitions (onebot_* family)
  protocol.ts protocol types + segment rendering/chunking/approval parsing/target parsing/action builders (dependency-free)
  types.ts    shared types: OnebotConfig / BridgeServices (structural service slice) / OnebotService
test/         node:test, imports src/*.ts directly
```

## Hard rules (do not break)

1. **Tool names must carry the `onebot_` prefix.** `send_message` is a reserved
   dsh ecosystem name (the subagent-control follow-up tool); a global duplicate
   fails the boot.
2. **schemastery has no `.optional()`** — object fields are optional by default,
   `cwd: z.string()` is enough.
3. **Use `.ts` extensions for relative imports inside `src/`** (Node runs them
   natively; tsc's `rewriteRelativeImportExtensions` rewrites them to `.js` in
   the emitted output).
4. **`defineTool` infers `execute`'s `args` and return type from `parameters` /
   `output.schema`**; the returned value must match the output schema
   (`additionalProperties: false` is enforced).
5. **OneBot response success check**: `retcode === 0`, or `status === "ok"`
   when `retcode` is absent; otherwise throw a model-facing error (with the
   action name / status / retcode / data detail).
   `get_friend_msg_history` is a NapCat/go-cqhttp extension — on incompatibility
   error out and suggest `onebot_get_msg` instead of silently treating it as
   "no messages".
6. **The console exporter's `levels` must include `default: -1`**: write
   `{ onebot: 2, default: -1 }` so only the onebot logger passes. `{ onebot: 2 }`
   alone leaks every other plugin's info logs to the console; the
   `[onebot info]` label comes from `message.name`, never hardcode it.
7. **Tear down with `ctx.effect(() => () => {...})`** (cordis 4 has no typed
   `dispose` event); the cleanup must call both `client.stop()` and
   `bridge.dispose()`, or HMR reloads leave zombie connections.
8. **Session id format** `onebot:private:<QQ>` / `onebot:group:<群号>`
   (reversed by `sessionToRoute`; the JSONL backend escapes ids into safe path
   segments, colons are fine).
9. **Profile user-layer patches replace the whole config**: when editing
   `$DSH_HOME/profiles/onebot/cordis.patch.yml`, restate every field you keep.
10. **`lib/` is gitignored**: commits/release only carry `src/` and
    `cordis.patch.yml`; the npm `files` field ships only the built `lib/`.

## How it works (event flow)

```
QQ inbound ──► OneBotClient (forward WS) ──► Bridge.onMessageEvent
  · self-messages (user_id===self_id) / allowlist gate / approval commands (同意/拒绝) are intercepted here, never reach the agent
  · non-text segments → `[<type> msg id:<id>]`; identity prefix `[好友 A(QQ)]` / `[群 N A(QQ)]`
→ enqueueTurn (serialized per chat) → ensureAgent (agents.create + default model selection + installModelSelection)
→ agent.followup(userMessage) → whenIdle() → sessions.flush()
→ fold the event interval (from firstSeq) for the last non-empty assistant text
→ sendReply: chunked (reply_chunk_size) → send_private_msg / send_group_msg
```

Permissions: `onebot_send` to a non-allowlisted target →
`bridge.requestApproval` → `ctx.approval.request` → the `approval/request`
waterfall answerer (this plugin claims only onebot sessions, delegates
everything else with `next()`) → notice in the chat awaiting 同意/拒绝; no
answerer / timeout / disconnect fails closed (`unavailable`).

## Porting sources

- Protocol layer: `nota/crates/nota-onebot/src/{types,client,api}.rs`
- Bridge/approval: `nota/crates/nota-onebot/src/{bridge,config,tools}.rs`
- Session driving (agents.create / followup / whenIdle / event folding): modeled
  on the `@deepseek-ai/dsh-headless` runner.
