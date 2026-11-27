# Shared task lists in Narsil (Supabase)

Objective: Narsil users share task lists. They assign tasks to each other, see changes live, and do the same through MCP. Personal Pendientes stay local.
Branch: one branch and one pull request per phase (`feat/shared-tasks` for F0-F1). Delivery: one PR per phase, merged before the next starts. Test runner: `npm test`, `npm run typecheck`, `npm run build`; F2 adds database policy tests against a local Supabase.

## Specs

- S1: Shared lists live in Supabase (free plan), apart from personal Pendientes, which stay in `tasks.json`. "yo ponerle tareas compartidas a alguien y que su aplicación las traiga. Y lo mismo yo ver las que la otra persona me pone y ver las actualizaciones."
- S2: Each user signs in to shared lists with Google from Ajustes. Supabase knows the user from a signed session that Narsil stores encrypted. The flow is OAuth PKCE with a fixed loopback redirect, `http://127.0.0.1:47813/auth/callback`, run in the main process.
- S3: Lists have members, invited by Google email. A task is assigned to a member, picked by real name. Invitations stay pending until the invited person signs in with that email.
- S4: Database rules (row level security) decide every permission; the app only follows them:
  - Only members see a list and its tasks.
  - Any member creates and assigns tasks.
  - The assignee and the creator change a task's status.
  - Decision (2026-11-27): "sí, el responsable puede editar nombre y descripción".
  - Decision (2026-11-27): "Cada lista solo puede tener un dueño." Only the owner invites and removes members.
  - Decision (2026-11-27): "las tareas después de que alguien es expulsado son eliminadas". Assumption to confirm at F2: this means the tasks assigned to the removed member.
- S5: Narsil syncs in real time and keeps a local copy to read while offline. Editing needs a connection. A desktop notification shows when someone assigns you a task.
- S6: Pendientes gets a **Mías / Compartidas** switch. Compartidas shows:
  - list creation and invitations;
  - an assignee picker with names;
  - the same status labels as personal tasks;
  - who changed a task last, and when.

  The tab count adds unfinished shared tasks assigned to you.
- S7: MCP tools cover lists, members, shared tasks, create and assign, and change status. Claude acts with the signed-in user's session, never as anyone else. Assigning by name first reads the members and asks when a name is ambiguous. Deleting is marked destructive.
- S8: The README explains the owner's one-time setup and the steps for another person. A real end-to-end test runs with two Google accounts.

## Tasks

- [x] F0 [S2] Owner sets up the Supabase project, Google sign-in and the redirect URL. Route: the owner, guided.
- [x] F1 [S2] Sign-in spike in Narsil: PKCE, loopback on port 47813, encrypted session with refresh, Ajustes shows the signed-in email. Route: inline.
- [ ] F2 [S3, S4] Schema, migrations and row level security with policy tests on a local Supabase. Route: inline. Risk: item 2 (security), so it gets an independent verifier and review.
- [ ] F3 [S5] Sync adapter: realtime, cache, reconnect, notification on assignment. Route: inline.
- [ ] F4 [S6] Interface. Route: inline.
- [ ] F5 [S7] MCP tools. Route: inline.
- [ ] F6 [S8] Docs and a two-account end-to-end test. Route: inline.

## Log

- L1 (2026-11-27) User: "¿Sería muy difícil compartir el tablero de tareas? Es decir, que estuviera publicado en algún lado para, por ejemplo, ponerle tareas a alguien más que tuviera la aplicación."
- L2 (2026-11-27) User: "¿y podríamos traerlo a la aplicación? Es decir, yo ponerle tareas compartidas a alguien y que su aplicación las traiga. Y lo mismo yo ver las que la otra persona me pone y ver las actualizaciones."
- L3 (2026-11-27) User: "también podría conectarse por MCP ... ¿Cómo sabríamos a qué persona se las estamos poniendo? ¿Complicaría en algo el login?"
- L4 (2026-11-27) The parent proposed phases F0-F6. User: "Sí, el responsable puede editar nombre y descripción ... Cada lista solo puede tener un dueño. Y las tareas después de que alguien es expulsado son eliminadas." Then: "arrancamos".
- L5 Evidence:
  - Supabase Free plan: 500 MB database, 50,000 monthly active users. A project pauses after a week of low activity; Pro starts at 25 USD a month (supabase.com/pricing).
  - Supabase supports PKCE (`signInWithOAuth`, then `exchangeCodeForSession`). There is no official Electron loopback guide, and code-verifier storage is a known pitfall (supabase-js #1686). Hence F1 is a spike.
- L6 The Engram mirror is pending: the project "narsil-proxy" is unknown to Engram (see mcp-bridge L4).
- L7 (2026-11-27) F0 is done. The owner created the project, set up Google sign-in and the redirect URL, and asked where test users are added: under Google Auth Platform → Audience.
- L8 F1 is built:
  - `app/sharedAuth.ts`: PKCE through `signInWithOAuth` with `skipBrowserRedirect`, a loopback server on 47813, `exchangeCodeForSession`, and the session in the encrypted secret `shared-session`.
  - `adapters/supabaseClient.ts` and `adapters/sharedConfigStore.ts` (`shared.json`).
  - The Ajustes step "Listas compartidas" and the IPC calls `getSharedStatus`, `setSharedConfig`, `sharedSignIn` and `sharedSignOut`.
  - The config check refuses `sb_secret_` and `service_role` keys.
  - The project URL and key are not committed: the repository is public.
- L9 Evidence: 13 new tests failed first (RED), then passed. 400 tests pass; typecheck, eslint and build are clean. Real sign-in by the owner, user: "Funcionó".
- L10 Risk: item 2 (sign-in, a session token stored on disk) and item 5 (new dependency `@supabase/supabase-js` 2.119.2).
