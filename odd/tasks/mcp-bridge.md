# MCP bridge: Claude can use Narsil's features

Objective: Claude (Desktop or Code) connects to the running Narsil through MCP. Phase 1 covers queries and Pendientes; mail actions are phase 2.
Branch: feat/mcp-bridge. Delivery: ask-on-risk (forecast about 600 authored lines). Test runner: `npm test`, `npm run typecheck`, `npm run build`.

## Specs

- S1: Transport.
  - Claude launches a small **stdio bridge** (`narsil-mcp`).
  - The bridge connects over a Windows named pipe to **the Narsil that is already open** and forwards each tool call to it.
  - Narsil runs the call with its existing services (`NarsilService`, `TaskList`, rules), so tokens and queries are never duplicated.
  - "Si Narsil está cerrada, el puente lo dice con claridad y no intenta nada."
- S2: Phase 1 tools, as proposed: "Fase 1, sin riesgo:"
  - Queries: "consultar la bandeja con su clasificación, las reuniones, las reglas y las carpetas".
  - Pendientes: "todo lo de Pendientes: listar, crear, editar, cambiar el estado y eliminar."
- S3: Excluded, as proposed: "Las credenciales y los ajustes quedan fuera del MCP: agregar cuentas, la API key y los client IDs". Phase 2 mail actions (archive, delete, move, reply, meetings, rules) are not part of this feature.
- S4: Security (assumption, from the proposal's "named pipe de Windows que solo puede usar tu usuario"):
  - The pipe rejects requests without the random token that Narsil writes on each start to its userData folder, a folder only the current user can read.
  - Tools carry MCP annotations: queries are `readOnlyHint`, and `delete_task` is `destructiveHint`.
- S5: (assumption, needed for S2 to be visible) when Claude changes a task, the open Pendientes tab updates without reopening it.
- S6: The README explains how to add the bridge to Claude Desktop and Claude Code.

## Tasks

- [x] T1 [S1, S4] Pipe server and token in the main process. Route: inline (no writer reason). Commit: C1.
- [x] T2 [S2, S3, S5] Tool handlers in the app and the tasks-changed event to the renderer. Route: inline. Commit: C1.
- [x] T3 [S1, S2] Stdio bridge with `@modelcontextprotocol/sdk` 1.32.2 and its build entry. Route: inline. Commit: C2.
- [x] T4 [S6] README and an end-to-end check with a real MCP client against the running app. Route: inline. Commit: C2.

## Log

- L1 (2026-11-26) User: "¿Creéis que podamos hacer un MCP para conectar todas las funcionalidades de la aplicación con Claude?"
- L2 (2026-11-26) The parent proposed a stdio bridge, a named pipe to the running app, and two phases. User: "Hazlo." This authorizes phase 1.
- L3 Evidence:
  - Tokens are encrypted with Electron `safeStorage` (`src/main/adapters/secureStore.ts`).
  - The app holds a single-instance lock (`src/main/index.ts:363`).
  - `@modelcontextprotocol/sdk` 1.32.2 accepts zod 4 (peer `^3.25 || ^4.0`), and `registerTool` takes `inputSchema` and `annotations`.
- L4 Engram mirror pending: mem_save refused project "narsil-proxy" as unknown_project.
- L5 RED: the mcpTools and mcpPipe tests failed on missing modules before the implementation. The bridge test was written together with the bridge, so it has no separate RED.
- L6 Design changes during the work:
  - The discovery file lives at `%LOCALAPPDATA%\Narsil\mcp.json`, not in userData, because the bridge cannot know Electron's userData path.
  - The protocol module lives in `src/mcp/`, because `tsconfig.web.json` also compiles `src/shared`, which must stay free of Node imports.
- L7 Evidence:
  - `npm test`: 350 passed. `npm run typecheck`: clean. `eslint`: clean.
  - `electron-vite build` emits `out/main/mcp.js`, which requires only the SDK, `zod` and `node:*` modules, never Electron.
  - End to end, a real SDK client over stdio talked to the running Narsil:
    - 9 tools were listed.
    - Every query answered, reporting counts only.
    - A test task was created, moved to in-progress, edited and deleted, leaving the task count unchanged.
  - Not verified visually: the open Pendientes tab updating live after an MCP change.
- L8 Risk: item 2 (a new local IPC endpoint guarded by a token) and item 5 (new dependency `@modelcontextprotocol/sdk`).
