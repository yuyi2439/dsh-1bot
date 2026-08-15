# AGENTS.md

Working notes for AI coding assistants editing this repo. The user-facing
[README](README.md) describes what the plugin is and how to use and configure
it — read it first. This file only holds what an agent needs that the README
does not: code structure, the release flow, and hard rules not to break.

## Layout

```
src/
  index.ts    plugin entry: name/inject/Config/apply; console log exporter; ctx.onebot service
  client.ts   OneBotClient: forward WS, echo-correlated call(), bounded startup
              retries (unreachable server → fatal exit), reconnect backoff
              (terminate-style stop)
  bridge.ts   OneBotBridge: chat⇄agent, allowlist, outbound chunking, QQ in-chat approval answerer
  tools.ts    5 defineTool definitions (onebot_* family)
  protocol.ts protocol types + segment rendering/chunking/approval parsing/target parsing/action builders (dependency-free)
  types.ts    shared types: OnebotConfig / BridgeServices (structural service slice) / OnebotService
test/         node:test, imports src/*.ts directly
```

`lib/` is the compiled build output (gitignored) — **always `pnpm build` after
changing `src/`**: the profile loads `lib/` from this linked repo and would
otherwise keep the stale build. Build/typecheck/test commands live in the
README's 开发 section.

## Releasing

Tag-driven, version checked not rewritten: bump `package.json` `version`
first (commit it), then tag with the matching version —
`git tag v0.0.1 && git push origin main && git push --force origin v0.0.1`.
`.github/workflows/publish.yml` fails fast when `package.json` version does
not match the tag, runs typecheck + tests, and publishes to npm with the
`NPM_TOKEN` repository secret (must be a bypass-2FA token). `lib/` is
gitignored, so the workflow relies on `prepack: pnpm build` to ship a fresh
build.

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
   error out and suggest `onebot_get_content` instead of silently treating it
   as "no messages".
6. **Never auto-suppress the reply — guide the model via the TOOL
   DESCRIPTION, never prompt injection**: the bridge always sends the final
   assistant text to the source chat. Double answers happen when the model
   replies via `onebot_send` in the current chat; the fix is the `onebot_send`
   description ("reply is delivered automatically; do not use this tool to
   reply in the current chat"), NOT post-hoc skip logic. dsh-1bot is an
   ADAPTER only: it must never register system-prompt sections or persona
   (that belongs to the persona layer, dsh-nota).
7. **The console exporter's `levels` must include `default: -1`**: write
   `{ onebot: 2, default: -1 }` so only the onebot logger passes. `{ onebot: 2 }`
   alone leaks every other plugin's info logs to the console; the
   `[onebot info]` label comes from `message.name`, never hardcode it.
8. **Tear down with `ctx.effect(() => () => {...})`** (cordis 4 has no typed
   `dispose` event); the cleanup must call both `client.stop()` and
   `bridge.dispose()`, or HMR reloads leave zombie connections.
9. **Session id format** `onebot-private-<QQ>` / `onebot-group-<群号>`
   (reversed by `sessionToRoute`). Separators are `-` on purpose: `:` would be
   escaped to `~003A` on disk by the JSONL backend (Windows-safe path
   segments), `-` stays verbatim.
10. **Profile user-layer patches replace the whole config**: when editing
    `$DSH_HOME/profiles/onebot/cordis.patch.yml`, restate every field you keep.
11. **`lib/` is gitignored**: commits/release only carry `src/` and
    `cordis.patch.yml`; the npm `files` field ships only the built `lib/`.
12. **`ctx.onebot`**: runtime = `ctx.provide("onebot", service)` in apply
    (auto-disposed with the plugin fiber); type side = the
    `declare module "@deepseek-ai/cordis"` augmentation in src/index.ts.
    Consumers read it via `ctx.onebot` / `ctx.get("onebot")`.
13. **Session cwd must be launch-dir independent**: the default workspace
    root is the stable `$DSH_HOME/workspaces/onebot`
    (`defaultWorkspaceRoot()`), and each chat session gets
    `<root>/chats/<sessionId>` (`chatWorkspace()`, created on first use).
    Never derive the session cwd from `process.cwd()` — the session id is
    stable across restarts, so a launch-dir-dependent cwd makes the store
    reject the id with a persisted-vs-live cwd collision.
14. **One instance only**: two `dsh` processes running the onebot plugin
    against the same profile both bridge the same chats and append to the
    same persisted sessions with independent seq counters, which CORRUPTS the
    logs (duplicate/missing seq — the web UI then reports "corrupt session
    log"). `apply` takes a pid lock at `<workspace_root>/.onebot.lock`
    (`acquireSingletonLock`, src/singleton.ts) and refuses to start when
    another live instance holds it; the teardown releases it. Never run the
    onebot profile twice, and never also mount the onebot row in another
    profile.
15. **Onebot sessions live under `$DSH_HOME/sessions-hidden`, never
    `sessions/`**: the web UI resumes any session it can see when you open it
    (`agents.resume` in dsh-host-apiproxy), turning it into a second live
    writer on the same log and corrupting it (duplicate seq). The bundle patch
    overrides `session-persistence-jsonl.root` to `dshHomePath('sessions-hidden')`
    — the same jsonl backend and defaults, only the root differs, so the web
    profile (which scans `sessions/`) can neither see nor resume them. On
    startup the plugin also creates the root and seeds `README.md` there
    (`ensureHiddenSessionsDocs`, src/hidden-sessions.ts).
16. **Startup connect failure is FATAL**: `client.start()` resolves only after
    the first connection; `connect_retries` (default 5) attempts ×
    `connect_retry_delay_secs` (default 1) later it rejects, and `apply` logs
    guidance and calls `process.exit(1)`. Runtime drops after a successful
    connect still reconnect forever (backoff) — only the STARTUP window is
    bounded and fatal.

## How it works (event flow)

```
QQ inbound ──► OneBotClient (forward WS) ──► Bridge.onMessageEvent
  · self-messages (user_id===self_id) / allowlist gate / approval commands (同意/拒绝) are intercepted here, never reach the agent
  · non-text segments → `[<type> msg id:<id>]`; identity prefix `[好友 A(QQ)]` / `[群 N A(QQ)]`
→ enqueueTurn (serialized per chat) → ensureAgent (agents.create + default
   model selection + installModelSelection; session cwd =
   `workspace_root/chats/<sessionId>`, mkdir -p first)
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
