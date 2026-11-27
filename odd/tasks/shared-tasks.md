# Shared task lists in Narsil (Supabase)

Objective: Narsil users share task lists. They assign tasks to each other, see changes live, and do the same through MCP. Personal Pendientes stay local.
Branch: one branch and one pull request per phase (`feat/shared-tasks` for F0-F1). Delivery: one PR per phase, merged before the next starts. Test runner: `npm test`, `npm run typecheck`, `npm run build`; F2 adds database policy tests against a local Supabase.

## Specs

- S1: Shared lists live in Supabase (free plan), apart from personal Pendientes, which stay in `tasks.json`. "yo ponerle tareas compartidas a alguien y que su aplicación las traiga. Y lo mismo yo ver las que la otra persona me pone y ver las actualizaciones."
- S2: Each user signs in to shared lists with Google from Ajustes. Supabase knows the user from a signed session that Narsil stores encrypted. The flow is OAuth PKCE with a fixed loopback redirect, `http://127.0.0.1:47813/auth/callback`, run in the main process.
- S3: Lists have members, invited by Google email. A task is assigned to a member who accepted, picked by real name.
  - Decision (2026-11-27, D4): "Aceptar la invitación". An invited person sees only the list name and its owner until they accept or decline. Nobody sees their name before they accept. Any member but the owner can leave.
- S4: Database rules (row level security) decide every permission; the app only follows them:
  - Only members see a list and its tasks.
  - Any member creates and assigns tasks.
  - The assignee and the creator change a task's status.
  - Decision (2026-11-27): "sí, el responsable puede editar nombre y descripción".
  - Decision (2026-11-27): "Cada lista solo puede tener un dueño." Only the owner invites and removes members.
  - Decision (2026-11-27): "las tareas después de que alguien es expulsado son eliminadas". Confirmed at F2: the tasks assigned to the removed member ("Las asignadas a esa persona"); tasks they created for others stay.
- S5: Narsil syncs and keeps a local copy to read while offline. Editing needs a connection. A desktop notification shows when someone assigns you a task.
  - Decision (2026-11-27, D5): "Sí, consulta cada 10 segundos". Narsil polls every 10 seconds instead of using Supabase Realtime. It also refreshes right after the user's own writes and when the window regains focus.
  - Decision (2026-11-27): a desktop notification also shows when someone invites the user to a list. User: "Sí, agrégalo". No email is sent.
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
- [x] F2 [S3, S4] Schema, migrations and row level security with policy tests on a local Supabase. Route: inline. Risk: item 2 (security), so it gets an independent verifier and review. Commits: 6f359b0, 334e78c, 6910727, 3b09979 (PR #8, merged; applied to the real project on 2026-11-27).
- [x] F3 [S5] Sync adapter: polling every 10 seconds, local cache, notification on assignment. Route: inline. Branch: `feat/shared-sync`. Risk: none. Evidence: L24-L25.
- [x] F4 [S6] Interface. Route: inline. Branch: `feat/shared-ui`. Risk: none. Evidence: L26.
- [x] F5 [S7] MCP tools. Route: inline. Branch: `feat/shared-mcp`. Risk: none. Evidence: L29.
- [ ] F6 [S8] Docs and a two-account end-to-end test. Route: inline. Branch: `docs/shared-lists`. Docs done (L30); the test below waits for a second Google account.

## Two-account test (F6)

A is the owner, B the second account; each runs Narsil on their own computer or Windows user. Wait up to 10 seconds after each step.

1. A creates the list "Prueba F6" and invites B's email. B is shown as "invitación pendiente".
2. B signs in. B gets the notification "A te invitó a una lista" and sees the invitation with A's name, and no tasks or members.
3. B accepts. A sees B as a member, by name.
4. A adds a task assigned to B. B gets "A te asignó una tarea", and B's Pendientes count goes up by one.
5. B sets it to "En curso". A sees "Último cambio: B, hoy a las …".
6. On that task B sees **Editar** but not **Eliminar**: only the creator and the owner delete.
7. B adds a task assigned to A. A gets the notification.
8. From Claude on A's computer: "asigna a <B's first name> una tarea en Prueba F6". The task shows up for B.
9. A removes B. B loses the list, and the task assigned to B is gone. The task B created for A stays.
10. A deletes the list.

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
- L11 Independent verifier: S2 PASS, no blockers. It reported, with reproductions:
  1. A legacy `service_role` JWT passed `validSharedConfig`, because the role sits in the base64url payload.
  2. When `openBrowser` threw, the timeout timer leaked into an unhandled rejection.

  It also suggested two hardening items: pass the `sb_flow_id` to `exchangeCodeForSession`, and stop the old client's auto-refresh when the project changes.
- L12 All four are fixed:
  - The JWT payload role must be `anon`, and `service_role` is refused as a secret key.
  - `callback()` returns a cancel function, which `finally` calls.
  - The flow id is passed when present.
  - `setConfig` calls `stopAutoRefresh()` on the old client.

  Regression tests failed first, then passed.
- L13 (2026-11-27) F1 was merged (davshn/narsil-proxy#7). User: "Continúa". On removing a member, the user chose "Las asignadas a esa persona (Recommended)".
- L14 F2 design:
  - Membership is by confirmed email. A profile is created only once the email is confirmed, so an unconfirmed sign-up can neither open an invitation nor show a made-up name.
  - `lists.owner_id` is a single column, so a list has one owner.
  - A composite foreign key `(list_id, assignee_email) → list_members` with `on delete cascade` makes "assign only to members" and "removing a member deletes their assigned tasks" structural.
  - Triggers keep the owner a member, keep a task's creator and list fixed, and stamp `updated_by` and `updated_at`.
- L15 Evidence:
  - The pgTAP suite `supabase/tests/shared_lists.test.sql` (43 tests) failed first (RED: no tables), then passed.
  - A mutation check weakened the task update policy, and exactly test 17 failed; a reset restored a full pass.
  - `supabase db advisors` gave 0 findings, after wrapping `auth.uid()` in `(select …)`.
- L16 Adversarial verifier: S3 PASS, S4 PARTIAL, no blockers. 43 tests observed passing. Six minor defects:
  - D1: a removed creator could still delete their tasks with `where true`, because the delete policy did not require membership.
  - D2: on insert, `updated_by` and the timestamps could be spoofed, and an update could change a task's id.
  - D3: the profile email did not follow a changed account email, while membership did.
  - D4: anyone can confirm that an email has an account and auto-join that person to their list, with no way out.
  - D5: `revoke execute … from anon` did nothing while `public` kept execute.
  - D6: `authenticated` kept TRUNCATE, TRIGGER and REFERENCES.
- L17 Fixed D1, D2, D3, D5 and D6 in the same migration, which has not reached the real project yet:
  - The delete policy requires membership.
  - The stamp trigger runs on insert too, and refuses an id change.
  - `sync_profile` also runs on email updates, as an upsert.
  - Execute on the helpers is revoked from public and granted to authenticated.
  - Truncate, trigger and references are revoked.

  Eight regression tests failed first; 50 pass now and the advisors report 0 findings. The README says to keep Confirm email and Secure email change on. D4 waits on the owner.
- L18 D4: the user chose "Aceptar la invitación (Recommended)".
  - Schema: `list_members.accepted_at`, the helpers `is_invited` and `is_accepted`, and a `normalize_member` trigger. On insert it marks only the owner's row accepted; on update it stamps `now()`.
  - Column grants: insert only `(list_id, email)`, update only `(accepted_at)`.
  - Policies: an accept policy, and delete for "the owner removes, and anyone leaves". Tasks are assigned only to accepted members.
  - Profiles: an invited person sees the owner, never the other way round before accepting.
- L19 Evidence: the rewritten pgTAP suite has 74 tests. RED: `accepted_at` did not exist; then a full pass.
  - Mutation: `is_member` ignoring acceptance made tests 17-19, 24 and 64 fail; a reset restored the pass.
  - Advisors: 0 findings.
- L20 Focused recheck: D1, D2, D3, D5 and D6 are CLOSED, and the acceptance flow passed every attack. Two new minor findings:
  - `is_accepted(list, email)` answered anyone, so a pending invitee or a former member could probe who joined.
  - An email change left memberships under the old email: the person lost access, and someone signing up later with the old email could inherit them.

  The recheck also noted a stale header comment. It asked whether S4's "Any member creates and assigns tasks" means any member may reassign. The current reading keeps reassigning to the creator and the assignee, as the owner described the plan.
- L21 Fixed:
  - `is_accepted` answers only members of that list.
  - `sync_profile` moves memberships to the new email. Where the new email is already in a list, it hands over the tasks and drops the old row.
  - The assignee key gained `on update cascade`, so tasks follow.
  - `normalize_member` stamps acceptance only on a user update. A system email move keeps the answer, which I found while fixing; before this, a moved pending invitation would have been auto-accepted.
  - The header comment now describes acceptance.

  Four regression tests failed first. Then 79 pass, a mutation of the old trigger failed test 76, and the advisors report 0 findings.
- L22 (2026-11-27) PR #8 merged. The migration was not live at first: REST answered 404 PGRST205 for every table. The owner ran it in the SQL Editor; then the four tables answer 401 to the publishable key without a session, as expected.
- L23 (2026-11-27) F3 design. Realtime `postgres_changes` would need a publication migration, its own reconnection and token refresh, and it sends delete events without row level security. The parent proposed polling every 10 seconds. User: "Sí, consulta cada 10 segundos".
- L24 (2026-11-27) F3 built test first. RED: 4 `SharedAuth.session` tests failed and the sync suite could not import its module. GREEN: 16 sync tests and 21 auth tests pass; the full suite is 424/424, typecheck and build pass.
  - `SharedSync` polls every 10 s, runs one sync at a time plus one more when asked during it, keeps the stored copy when Supabase or the session refresh cannot be reached, and forgets it on sign-out.
  - It reports a task as newly assigned only against a previous copy of the same user, and only when someone else assigned it.
  - `SharedAuth.session()` throws when the session exists but cannot be read, so an offline refresh never looks like a sign-out.
- L25 (2026-11-27) Live check against the real project: after a restart Narsil wrote `shared-cache.json` with 0 profiles, although the user's own profile should be visible. Cause: the owner signed in at F1, before the schema, so the profile trigger never ran. Fix: migration `20261127150402_backfill_profiles.sql`. Checked on the local database: a confirmed pre-schema account gets its profile with a lowercased email, an unconfirmed one gets none, and a second run adds nothing. After `db reset`, 79 policy tests pass and the advisors report 0 findings. No pgTAP test: the statement lives in a migration and runs once.
- L26 (2026-11-27) F4 built test first.
  - Writes: `SharedLists` and one `sharedAction` IPC channel validated by zod. RED: the auth test failed on `session.write` and the suite could not import the module. GREEN: 14 tests. Each change is checked first, written with the user's session, explained in Spanish when refused (42501, 23505, 23503, trigger messages, zero rows touched), then synced.
  - Screens: **Mías / Compartidas** switch, invitations, lists, members, tasks with assignee, status and last change. The view logic (`sharedView.ts`) has 9 tests; RED was a missing module.
  - The tab count adds unfinished shared tasks assigned to the user. A clicked assignment notification opens Compartidas.
  - Full suite 447/447, typecheck and build pass. After a restart Narsil kept syncing. Not checked on screen: the desktop approval was not available over Remote Control, so the owner checks the screens.
- L27 (2026-11-27) User asked whether an invitation sends an email. It does not: it only adds a member row, which the invited person sees after signing in. User: "Sí, agrégalo" to a desktop notification on new invitations (S5).
- L28 (2026-11-27) Invitation notifications built test first. RED: 1 of 3 new sync tests failed. GREEN: 450/450, typecheck and build pass. A new invitation is reported only against a previous copy of the same user, never on a first sync, and never again once reported or accepted.
- L29 (2026-11-27) F5 built test first. RED: the shared MCP suite could not import its module. GREEN: 15 tests; full suite 465/465, typecheck and build pass.
  - 11 tools (27 in all). They call the same `SharedLists.apply` and sync as the screens, so they act with the user's session.
  - Assigning by name matches the accepted members by email, full name or first name, ignoring case and accents. An ambiguous or unknown name fails and lists the candidates, so Claude asks the user.
  - The deleting tools are marked destructive and say "Confirm with the user first."
  - The tool argument parser moved to `protocol.ts` (`parseToolArgs`) so both handler modules share it.
  - Live check through the real bridge against the real project: the bridge listed 27 tools; then Claude's calls created "Prueba MCP", refused an unknown assignee, added a task assigned by email, set it in progress, and deleted the task and the list. The project was left with 0 lists.
- L30 (2026-11-27) F6 docs: the README section is no longer "in progress" and gains "Adding another person", with the owner's steps (test user, URL and public key, invitation) and the other person's (install, project, sign-in, accept). Checked first: only the mail tab needs mail accounts and a Claude key, so a person who only uses shared lists needs neither.
