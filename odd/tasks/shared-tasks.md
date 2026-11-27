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
