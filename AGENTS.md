# AGENTS.md

Working notes for AI coding assistants editing this repo. All developer and
maintainer material lives in [CONTRIBUTING.md](CONTRIBUTING.md) — read it
before touching anything. The user-facing [README.md](README.md) describes
what the plugin is and how to use and configure it; read it first, then
CONTRIBUTING.md for layout, build/test commands, the release flow, the hard
rules (including the "resume instead of re-create an existing session log" fix),
the event flow, and dependency sources.

## Important Rule

### KISS and First Principles

Follow the KISS principle and reason from first principles during development. Start by identifying the real problem, required behavior, and smallest useful change before adding code. Do not pile on features, configuration switches, abstractions, dependencies, or compatibility layers unless they directly solve the current problem and have clear evidence of need.

Prefer the simplest implementation that is correct, maintainable, and consistent with the existing codebase. If a broader design seems attractive, reduce it to the essential behavior needed now and leave optional expansion for a later, explicit requirement.

### No Unnecessary Helpers

Prioritize inline implementation over abstraction. Avoid over-engineering and do not create helper functions unless absolutely necessary.

1. **Inline-First Rule**: If a logic block can be implemented directly within the main function without breaking overall readability, **do not** extract it into a new helper function.
2. **Strict Justification for Helpers**: You may only create a separate helper function if it meets at least one of these criteria:
   - **High Reuse**: The exact same logic is repeated across **3 or more** different locations.
   - **Extreme Complexity**: Inlining the logic makes the main function too long (e.g., >50 lines) or severely derails the main execution flow.
3. **No Fragmentation**: Do not split continuous linear logic (e.g., a single API call, simple form validation, or one-time data formatting) into tiny functions just for the sake of "clean code."
4. **Keep Context Compact**: Handle edge cases, error catching, and logging directly inside the main function block instead of offloading them.
5. **Refactoring Constraint**: When modifying existing code, do not alter the current function structure or extract code into new helpers unless the existing code already violates the complexity or reuse rules above.

### Comments Must Not Enumerate Constants

Do not repeat an enumerated constant's values in comments or any other prose. Describe it abstractly instead; a reader who needs the concrete values looks at the declaration itself.

- Write "must be one of the implemented adapter types — see the implementation table", not a list of those types.
- Write "the route kinds an adapter declares", not the kind names.
- This applies to comments, doc comments, log/prompt wording, README and CONTRIBUTING text. The values live in exactly one declaration; restating them guarantees they drift.

## Note

- `OneBotBridge` 是插件中枢：它持有完整的 `OneBotClient` 与 `apply` 收到的
  `Context`，dsh 服务都从 ctx 上取。`ctx.agents` 这类属性写法要求**声明该服务的包
  进入了编译**（本插件 import 了 dsh-agent / dsh-session，所以这两个有类型）；
  `agentDefaultModel` 与 `sessionPersistence` 的声明包没有，所以用
  `ctx.get("名字")` —— 想改成属性就先加 `import type {} from "<声明包>"`。
  **不要为了测试好写给生产代码加服务切片参数**——测试用 `new Context()` +
  `ctx.provide(名字, 假件)` 造同样的形状。
- 平台相关的东西放进 `src/adapter/`：一个 adapter 声明自己的路由种类、出站/读历史
  动作、白名单配置字段与配置 schema（契约定在 `src/adapter/types.ts`，实现表在
  `src/adapter/index.ts`）。通用配置（连接、分块）留在 `src/config.ts` 的
  `Config`。**其余模块不认识任何具体平台**——它们只通过 adapter 的声明工作，新增
  一种 adapter 不需要改动它们。
- 改配置字段只动 `src/config.ts` 的 schema + README 配置表：`OnebotConfig` 由
  schema 推导（`ReturnType<typeof Config>`），没有第二份字段清单要同步。默认值
  一律取 `DEFAULTS`（adapter 自己的默认值由各 adapter 声明），不要在 bridge /
  种子模板里另写常量，也不要写 `?? 默认值` 兜底 —— 解析结果总是完整的。
- 改完 `src/` 必须 `pnpm build`：profile 加载的是本 linked repo 的 `lib/`
  编译产物，不重建会一直跑旧代码。
