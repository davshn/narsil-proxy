# MCP bridge: Claude can use Narsil's features

Objective: Claude (Desktop or Code) connects to the running Narsil through MCP. Phase 1 (merged in davshn/narsil-proxy#2) covers queries and Pendientes; phase 2 adds mail actions, meetings and rules.
Branch: feat/mcp-bridge (phase 1), feat/mcp-mail-actions (phase 2). Delivery: ask-on-risk. Test runner: `npm test`, `npm run typecheck`, `npm run build`.

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
- S7: Phase 2 tools, as proposed and accepted ("Sí, hazlo así."):
  - "Archivar, eliminar y mover correos a una carpeta."
  - "Responder correos, usando los borradores de la clasificación o un texto propio."
  - "Crear reuniones en el calendario."
  - "Crear reglas, locales o de Gmail y Outlook."
  - Each tool calls the existing `NarsilService` method, which already validates and updates the window: `applyAction`, `sendReply`, `createMeeting`, `saveRule`, `saveServerRule`. Rules are create-only; editing and deleting rules were not requested.
- S8: Safety, as accepted: "excepto por la confirmación dentro del Narsil. Creo que no es necesaria."
  - There is no confirmation inside Narsil.
  - Mail actions (archive, delete, move, reply) and rule creation carry `destructiveHint`, so Claude asks for each use.
  - S3 still holds: accounts, keys and client IDs stay out.
- S9: The README lists the phase 2 tools and says that Claude's permission prompt is the only confirmation.

## Tasks

- [x] T1 [S1, S4] Pipe server and token in the main process. Route: inline (no writer reason). Commit: C1.
- [x] T2 [S2, S3, S5] Tool handlers in the app and the tasks-changed event to the renderer. Route: inline. Commit: C1.
- [x] T3 [S1, S2] Stdio bridge with `@modelcontextprotocol/sdk` 1.32.2 and its build entry. Route: inline. Commit: C2.
- [x] T4 [S6] README and an end-to-end check with a real MCP client against the running app. Route: inline. Commit: C2.
- [x] T5 [S7, S8] Phase 2 tools in protocol.ts and handlers in mcpTools.ts, with tests. Route: inline (one unit, no writer reason).
- [x] T6 [S9] README. Route: inline.

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
- L9 Independent verifier: S1-S6 PASS, no blockers, 350 tests and the typecheck observed. It reported three minor findings:
  1. A result that JSON cannot hold jammed the connection's queue and caused an unhandled rejection.
  2. There was no bound on queued answers per connection.
  3. The bridge never checks the discovery `pid` against the pipe server.
- L10 Fixed 1 and 2 in `mcpPipe.ts`:
  - each answer is serialized inside try/catch;
  - a connection with more than 64 pending requests is dropped.
  - Regression tests failed without the fix and pass with it; the suite has 352 passing.
- L10 Not fixed: finding 3. A real check needs `GetNamedPipeServerProcessId` (native code), and the attack needs another local user plus a Narsil crash.
- L10 The `save_task` description no longer claims that projects match ignoring case.
- L11 Fix committed as e544347.
- L11 Native review: the user granted consent for lineage review-4135166a19fb9064 (lenses: risk, resilience, reliability).
- L11 All three captures failed in preflight with no mutation. The `claude` CLI that runs the reviewer reported: "OAuth session expired and could not be refreshed".
- L11 STATUS re-offers the same three slots. Review is pending until the user signs in to the Claude CLI again.
- L12 (2026-11-27) User: "¿Nos queda una fase 2 de esa tarea? ¿O ya terminamos?"
- L12 The parent listed phase 2. User: "Sí, hazlo así." Then: "Espera, hazlo así, excepto por la confirmación dentro del Narsil. Creo que no es necesaria."
- L12 The parent noted the tradeoff once: if the user picks "always allow" in Claude for send or delete, a malicious email could trigger those actions unseen.
- L13 RED: 11 new mcpTools tests and the bridge annotations test failed before the implementation. GREEN: `npm test` 363 passed; typecheck, eslint and build clean.
- L13 End to end against the running Narsil, error paths only, so no real mail, calendar or rule changed:
  - 16 tools are listed, and 7 are marked destructive.
  - An unknown key gives "Este correo ya no está en la lista.".
  - A blank reply is refused by the schema.
  - An end before the start gives "La hora de fin debe ser posterior a la de inicio.".
  - A rule without conditions gives "Agrega al menos una condición." (local and server).
  - An unknown account gives "Esta cuenta ya no está conectada.".
- L13 Not run: the success path on real mail, by design. Claude Desktop keeps the old bridge process until it restarts.
- L13 Risk: item 2. Mail-changing actions are now reachable through the token-guarded pipe, with Claude's permission prompt as the only confirmation.
- L14 Independent verifier (phase 2): S7, S8 and S9 PASS, S2-S4 still hold, no blockers; it observed 363 tests and the typecheck passing. It reported four minor findings:
  1. The server instructions still said "read".
  2. The docs did not say that `create_server_rule` acts on the current list.
  3. The reply body was trimmed before sending.
  4. Confirm wording was uneven across the destructive tools.
- L14 All four are fixed. Regression tests (an untouched reply body, confirm wording on every destructive tool, the instructions) failed first. GREEN: 364 tests.
- L14 Unverified premise: whether a Claude client honors `destructiveHint` per use is client behavior.
