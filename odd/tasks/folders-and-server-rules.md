# Folders, inbox filter settings and server-side rules

Objective: "Guardar" moves an email into a label or folder. Rules become Gmail filters or Outlook inbox rules on a chosen account. Each account controls which unread mail Narsil reviews.
Branch: feat/narsil-agent. Test runner: `npm test`, `npm run typecheck`, `npm run build`.

## Specs

- S1: "el guardar deberia ser guardar en un label o carpeta"
- S2: "el crear regla deberia permitir seleccionar en que carpeta se guardan estos mensajes automaticamente (configurandolos en gmail como automaticos)"
- S3: "curiosamente solo veo los correos de una de las cuentas tengo 2 de gmail"
  - Diagnosed by the parent on 2026-11-26: both Google accounts are connected.
  - Narsil's query `in:inbox is:unread newer_than:2d -category:promotions -category:social` returns 0 for hernan.figueroac@cun.edu.co, because its 6 recent unread emails are all in Promotions/Social. It returns 2 for davshn@gmail.com.
  - Fix: per-account inbox settings.
- S4 (user choice "Todas en Gmail/Outlook"):
  - Every rule lives on one account as a Gmail filter or an Outlook inbox rule, with actions: move to a folder or label, archive, or delete.
  - Narsil only manages them, and they keep working with the PC off.
  - Existing local rules keep working locally until the user converts each one by choosing an account. After conversion, the local copy is deleted.
- S5: UI in neutral Spanish; code and docs in English.

## Design (defaults set by the parent)

### Stage A: folders and inbox settings (S1, S3)

- Types:
  - `MailFolder { id: string; name: string }`.
  - `Account` gains `settings: { includeCategories: boolean; windowDays: 2 | 7 | 30 }`, defaulting to `{ includeCategories: false, windowDays: 2 }`. Registry entries without settings read as the defaults.
  - For Gmail, `includeCategories` includes the Promotions and Social tabs. For Outlook, it includes the "Other" folder of Focused Inbox, meaning the `inferenceClassification` filter is not applied.
- `MailProvider` gains these methods; `save(id)` is replaced by `moveToFolder`:
  - `listFolders(): Promise<MailFolder[]>`
    - Gmail: user labels (`type === 'user'`), sorted by name.
    - Outlook: `/me/mailFolders?$top=100`, including one level of child folders shown as `Parent/Child`, without the well-known Inbox, Drafts, Sent Items, Deleted Items, Junk Email, Outbox and Conversation History.
  - `createFolder(name: string): Promise<MailFolder>`
    - Gmail: `labels.create` with `labelListVisibility: 'labelShow'` and `messageListVisibility: 'show'`.
    - Outlook: `POST /me/mailFolders`.
  - `moveToFolder(id: string, folderId: string): Promise<void>`
    - Gmail: add the label, remove INBOX and UNREAD.
    - Outlook: mark read, then move.
  - `listUnread(settings)` uses the account settings.
    - Gmail query: `in:inbox is:unread newer_than:<N>d`, plus `-category:promotions -category:social` unless `includeCategories`.
    - Outlook: `receivedDateTime ge now-N days`, plus `inferenceClassification eq 'focused'` unless `includeCategories`.
- IPC:
  - `listFolders(accountId)`
  - `createFolder(accountId, name)`, with the name trimmed, 1-100 chars, and `/` allowed for nested Gmail labels
  - `applyAction(key, 'save', folderId)`, where `save` requires `folderId`
  - `setAccountSettings(accountId, settings)`, which triggers that account's full poll
- UI:
  - "Guardar" on a card opens a small picker listing the account's folders, plus "Nueva carpeta…" with an inline name input. Picking one moves the email.
  - Ajustes → Cuentas: each account gets a toggle ("Incluir Promociones y Social" for Gmail, "Incluir la bandeja Otros" for Outlook) and a window select (2, 7 or 30 días).
  - Triage's `recommendedAction: 'save'` still highlights Guardar.

### Stage B: server-side rules (S2, S4)

- Scopes:
  - Google adds `https://www.googleapis.com/auth/gmail.settings.basic`.
  - Microsoft adds `MailboxSettings.ReadWrite`.
- Reconnecting accounts that lack the new scope:
  - Accounts connected before this change lack the scope. A 403 with insufficient scope, or a missing scope in the granted list, marks the account `needsReconnect`.
  - The UI shows "Reconecta esta cuenta para administrar sus reglas" with a "Reconectar" button.
  - Port: `ProviderAuth.reconnect(accountId): Promise<void>` runs the browser sign-in again for that same account: the same email is required, the tokens are replaced, and the account id is kept.
- Port `RuleProvider` (on `AccountConnection.rules`):
  - `list(): Promise<ServerRule[]>`
  - `create(input): Promise<ServerRule>`
  - `remove(ruleId): Promise<void>`
  - Editing = remove, then create, because Gmail filters cannot be updated.
- Server rule shape:
  - `ServerRule { id; accountId; name; conditions: { from; subject; body }; action: 'archive' | 'delete' | 'move'; folderId?: string; folderName?: string; managedByNarsil: boolean }`
  - Rules created outside Narsil that Narsil cannot map show as read-only, and can still be deleted.
- Gmail filter mapping:
  - criteria `{ from, subject, query: body }`, leaving empty ones out;
  - archive: `removeLabelIds: ['INBOX']`;
  - delete: `addLabelIds: ['TRASH']`;
  - move: `addLabelIds: [labelId], removeLabelIds: ['INBOX']`.
  - Gmail filters have no name, so Narsil shows a name generated from the conditions.
- Outlook messageRule mapping:
  - `displayName` = rule name;
  - conditions `senderContains` / `subjectContains` / `bodyContains`;
  - actions: move is `moveToFolder: folderId`; archive is `moveToFolder:` the archive folder id from `GET /me/mailFolders/archive`; delete is `delete: true`;
  - `isEnabled: true`, `stopProcessingRules: false`.
- At least one condition is always required.
- On create, Narsil also applies the action once to matching emails currently listed for that account, and logs this in recent activity.
- Local rules:
  - Unconverted local rules keep running locally as before.
  - Rules tab: a "Reglas en tus cuentas" list grouped by account, then "Reglas locales" with "Pasar a una cuenta…" (pick the account and, for move actions, a folder) that creates the server rule and deletes the local one.
  - "Crear regla" from an email preselects that email's account.
- The rule form gains the fields Cuenta and Acción (Mover a carpeta / Archivar / Eliminar), plus a folder picker when the action is Mover a carpeta.

## Tasks

- T1 [S1, S3, S5] Stage A. Route: delegated writer (context backstop).
- T2 [S2, S4, S5] Stage B, after T1. Route: delegated writer (context backstop).
- T3 Seam check and verifier: Risk item 2 for new scopes and reconnect, item 3 for changing the persisted rules model. Route: parent.

## Log

- L1 (2026-11-26): the user's message is quoted in S1-S3. The parent diagnosed S3 by counting unread messages through the stored tokens; no message content was read. User choice for rules: "Todas en Gmail/Outlook (Recomendado)".
- L2: Stage A done by the writer. The parent fixed a gap outside its surface: rulesStore dropped `folder` on reload (RED→GREEN in tests/rulesStore.test.ts). 203/203 tests, typecheck and build pass. Contract for Stage B: MailFolder, AccountSettings, Account.settings, RuleFolder/Rule.folder; MailProvider listUnread(settings)/listFolders/createFolder/moveToFolder; IPC list-folders, create-folder, set-account-settings, apply-action(key, action, folderId).
- L3: Stage B done by the writer. Port contract change: reconnect(accountId, email). Parent recheck: 248/248 tests, typecheck clean. Risk: items 2 and 3; independent verifier launched (including a UI capture of Reglas and Ajustes).
- L4: The verifier found B1 (Outlook messageRule body: stopProcessingRules misplaced, so Graph would reject every rule), B2 (removing an account during its reconnect resurrected it and kept its tokens), SF1 (edit lost the rule on a failed create), SF2 (reconnect stored grants without the needed scopes), SF3 (folder picker scrollbar), and 4 nits. One correction batch fixed all of them; the UI-only items have no DOM tests. Parent recheck: 262/262 tests, typecheck and build pass; blocker regression tests pass; stash list empty. Known: a name-only edit of a Gmail filter may fail with "Filter already exists" (the old filter is kept). Not tested against real Gmail/Graph APIs.
