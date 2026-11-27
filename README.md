# Narsil

Narsil is a small assistant that floats in the bottom-right corner of your Windows desktop. It:

- connects any number of Google accounts (Gmail and Google Calendar) and Microsoft accounts (Outlook.com, Hotmail and Microsoft 365), and shows them as one inbox and one meetings list,
- watches each inbox for unread mail from the last two days by default, skipping Gmail's Promotions and Social tabs and Outlook's "Other" tab (see [Inbox settings](#inbox-settings)),
- uses Claude to summarize each email, recommend **reply**, **save**, **archive** or **delete**, and draft up to three replies you can edit before sending,
- reads each account's calendar and reminds you **15 minutes** and again **5 minutes** before each meeting, with a Windows notification and a banner that has a "Unirse a la llamada" (join call) button. The interface is in Spanish.

Nothing is sent, archived or deleted without your click. With more than one account connected, each email and meeting shows the address of the account it belongs to, and a reply always goes out from the account that received the email.

| Button | Gmail | Outlook |
| --- | --- | --- |
| Guardar (save) | Opens a list of your labels, plus **Nueva carpeta…** (new folder) to create one. Picking a label adds it, removes the email from the inbox and marks it read. A `/` in a new name nests the label, as in `Facturas/2026`. | Opens a list of your folders, with subfolders shown as `Parent/Child`, plus **Nueva carpeta…** to create one. Picking a folder marks the email read and moves it there. |
| Archivar (archive) | Removes it from the inbox and marks it read. It stays in All Mail. | Moves it to the Archive folder and marks it read. |
| Eliminar (delete) | Moves it to Trash, where Gmail keeps it for 30 days. | Moves it to Deleted Items. |
| Enviar respuesta (send reply) | Sends your reply in the same thread and marks the email read. | Sends your reply in the same conversation and marks the email read. |

## Requirements

- Windows 10 or 11, or macOS 12 or later (see [On a Mac](#on-a-mac); not yet tested on real hardware)
- Node.js 20 or later
- At least one Google account (Gmail and Google Calendar) or Microsoft account (Outlook.com, Hotmail or Microsoft 365)
- An Anthropic API key from <https://console.anthropic.com/>

## 1. Create a Google OAuth client (one time, for Google accounts)

Narsil talks to Gmail and Calendar with your own Google Cloud project, so your data never passes through a third-party server.

1. Open <https://console.cloud.google.com/> and create a project, for example "Narsil".
2. Under **APIs & Services > Library**, enable the **Gmail API** and the **Google Calendar API**.
3. Under **APIs & Services > OAuth consent screen**, choose **External**, fill in the app name and your email, and add yourself as a **test user**.
4. Under **APIs & Services > Credentials**, click **Create credentials > OAuth client ID**, choose **Desktop app**, and download the JSON file.

Keep that file private. Narsil asks for these permissions:

- `gmail.modify`: read mail, create and apply labels, archive and move to Trash (it cannot permanently delete)
- `gmail.send`: send the replies you approve
- `gmail.settings.basic`: list, create and delete the Gmail filters that hold your rules
- `calendar.events`: read your events and add the meetings you create in **Reuniones**

Data access: while the consent screen is in "Testing" mode, you do not need to change anything for the new `gmail.settings.basic` and `calendar.events` scopes. You can optionally add it under **Google Auth Platform → Data access → Add or remove scopes**, so the consent screen lists it with the other Gmail scopes.

One OAuth client serves every Google account you add. While the consent screen is in "Testing" mode, add each account as a test user. Google expires the sign-in after 7 days, so you then need to remove the account under **Cuentas** (accounts) and add it again. Setting the publishing status to **In production** removes that limit. Because Gmail scopes are restricted, Google then shows an "unverified app" warning at sign-in, which you can accept for your own account.

## Register a Microsoft app (one time)

Narsil signs in to Outlook.com, Hotmail and Microsoft 365 accounts with your own app registration.

1. Open the [Azure portal](https://portal.azure.com) and go to **Microsoft Entra ID → App registrations → New registration**.
2. Enter a name, for example `Narsil`.
3. Under **Supported account types**, choose **Accounts in any organizational directory and personal Microsoft accounts**.
4. Under **Redirect URI**, choose the platform **Mobile and desktop applications** and enter `http://localhost`.
5. Select **Register**.
6. On the app's **Overview** page, copy the **Application (client) ID** (a GUID).
7. Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add:
   - `Mail.ReadWrite`
   - `Mail.Send`
   - `MailboxSettings.ReadWrite` (for the Outlook inbox rules that hold your rules)
   - `Calendars.ReadWrite` (to read your events and add meetings; it replaces `Calendars.Read`)
   - `User.Read`
   - `offline_access`
8. In Narsil, paste the Application (client) ID in **Ajustes**, then add your Microsoft accounts.

Narsil uses no client secret. Each person grants these permissions when they sign in. A work or school account may need its administrator to approve the app.

## 2. Run Narsil

```powershell
npm install
node node_modules/electron/install.js
npm run build
npm start
```

The second command downloads the Electron runtime. Recent npm versions skip that download during `npm install`.

Under `npm start` Windows labels Narsil's notifications "Electron" with Electron's icon, because the app is not installed. To get notifications from "Narsil" with her icon, install it instead:

```powershell
npm run dist
```

Then run the installer from `dist/`. It creates a **Narsil** shortcut in the Start Menu, which is how Windows learns the app's name and icon (app id `com.narsil.desktop`). Each notification shows Narsil's face, in her light or dark look depending on the hour.

Narsil sits above the taskbar as a little sea serpent, drawn with the art from narsilPet. Click her to open the panel, then go to **Ajustes** (settings):

1. **Elegir archivo de cliente** (choose client file): for Google accounts, pick the JSON you downloaded.
2. **Guardar ID** (save ID): for Microsoft accounts, paste the Application (client) ID of your Microsoft app.
3. **Agregar cuenta de Google** / **Agregar cuenta de Microsoft** (add Google / Microsoft account): your browser opens. Sign in and allow access. Repeat for every account you want. Each button stays disabled until its provider is set up in step 1 or 2. **Quitar** (remove) next to an account under **Cuentas** (accounts) signs it out and drops its emails and meetings.
4. **Guardar clave** (save key): paste your Anthropic API key. If `ANTHROPIC_API_KEY` is set in your environment, Narsil uses that instead.

If you used an earlier version with one Google account, Narsil moves it to the new account list on first start, so you do not need to sign in again.

Secrets are encrypted with Windows DPAPI (Electron `safeStorage`) under `%APPDATA%\narsil-proxy\secrets`.

### On a Mac

The same code runs on macOS. Run it from the repository the same way:

```sh
npm ci
node node_modules/electron/install.js
npm run build
npm start
```

To get an installable app, build it on the Mac itself:

```sh
npm run dist:mac
```

This writes `dist/Narsil-<version>.dmg`. Open it and drag Narsil to Applications.

The build is not signed or notarized with an Apple Developer ID. A copy you build on your own Mac opens normally. A copy downloaded from elsewhere gets blocked by macOS: right-click it and choose **Abrir** (Open), or run `xattr -cr /Applications/Narsil.app`.

What changes on a Mac:

- **Where Narsil lives:** in the menu bar, not the Dock. Clicking the app again in Finder or Spotlight brings her back.
- **Tray menu:** the checkbox reads **Abrir al iniciar sesión** (open at login).
- **Secrets:** encrypted with the macOS Keychain (Electron `safeStorage`) under `~/Library/Application Support/narsil-proxy/secrets`. The first time, macOS may ask to let Narsil use its Keychain entry; choose **Permitir siempre** (always allow).
- **MCP bridge:** Narsil listens on a Unix socket instead of a named pipe (see [How the bridge finds Narsil](#use-narsil-from-claude-mcp)).
- **Icon:** the app icon is the 256 px icon scaled up to 512 px (`resources/icon-512.png`). Replace it with a native 1024 px icon for a sharper Dock and Finder icon.
- **Not tried on a Mac yet:** signing in with Google or Microsoft, notifications, and the menu bar icon.

## Using it

- The number next to Narsil shows how many unread emails are waiting.
- Her pose shows what is going on: idle (she bobs in the water with narsilPet's `parada` loop), reading new mail while Claude triages it, asking for attention when mail waits or a meeting is about to start, showing an error, or celebrating for a few seconds after an action or reply succeeds.
- The look follows the clock like the narsil-skin mod: a light theme from 6:00 to 17:59 and a dark theme the rest of the day, re-checked every 10 seconds. With reduced motion turned on in Windows, Narsil uses her still drawings and the theme changes without a fade.
- Drag the bar above her, or the panel header, to move Narsil.
- The tray icon (narsilPet's icon) lets you show or hide Narsil, check now, start Narsil with Windows, or quit.
- Closing the panel (the minus button) shrinks Narsil back to the docked serpent. It keeps running.

### Rules

Rules live in your accounts: each rule is a Gmail filter or an Outlook inbox rule on one account, so it keeps working with your PC off. Narsil only manages them. The **Reglas** (rules) tab shows **Reglas en tus cuentas** (rules in your accounts), grouped by account.

**Nueva regla** (new rule) opens a form with:

- **Cuenta** (account): the account that stores the rule.
- Up to three case-insensitive "contains" conditions: sender, subject and body text. All the conditions you fill in must match, and a rule needs at least one.
- **Acción** (action): **Mover a carpeta** (move to a folder, which you pick or create in the folder list), **Archivar** (archive) or **Eliminar** (move to Trash in Gmail, or to Deleted Items in Outlook; never a permanent delete).

More about server rules:

- Creating a rule also applies it once to that account's emails already in the list, and **Actividad reciente** (recent activity) logs each of those actions. After that, Gmail or Outlook applies it to new mail.
- **Editar** (edit) deletes the rule and creates it again, because Gmail filters cannot be updated.
- Gmail filters have no name, so Narsil names them after their conditions.
- Filters or rules you made outside Narsil with other conditions or actions show as read-only. You can still delete them.
- **Crear regla** (create rule) on an email opens the form prefilled with its sender, on the account that received it.

#### New permissions and Reconectar

Rules need one more permission: `gmail.settings.basic` for Google and `MailboxSettings.ReadWrite` for Microsoft. Adding meetings needs another: `calendar.events` for Google (instead of `calendar.readonly`) and `Calendars.ReadWrite` for Microsoft (instead of `Calendars.Read`). Accounts you added before these versions never granted them. Narsil notices the first time it lists their rules or you add a meeting, and shows "Reconecta esta cuenta para administrar sus reglas y agregar reuniones" with a **Reconectar** (reconnect) button, in **Ajustes**, in **Reglas** and in the **Agregar reunión** form. Click it once per account: your browser opens, you sign in with the same address and allow the new permissions. Narsil keeps the account, its settings and its mail; signing in with another address is rejected and the old sign-in stays. Mail and reading the calendar keep working with the old permissions while an account waits for its reconnect.

#### Local rules

Rules made with earlier versions were local: Narsil ran them on new mail before Claude saw it, only while it was open. They are stored in `%APPDATA%\narsil-proxy\rules.json` and show under **Reglas locales** (local rules), where they keep running as before until you move them:

- **Pasar a una cuenta…** (move to an account) creates the matching rule in an account, then deletes the local copy. If the account rejects the rule, the local rule stays.
- A local **Mover a carpeta** rule goes to the account that owns its folder, with that folder. Any other local rule asks which account to use. A "save" rule created before folders existed ("archivar (regla anterior sin carpeta)") also asks for a folder.
- **Activa** (enabled) and **Borrar** (delete) still work on local rules. The first enabled local rule that matches, in list order, wins, and a local **Mover a carpeta** rule only acts on the mail of its folder's account.

### Meetings

The **Reuniones** (meetings) tab lists the timed meetings of the next 24 hours from every account. **Agregar reunión** (add meeting) opens a form:

- **Título** (title): required.
- **Cuenta** (account): which account's main calendar gets the meeting; the first account is preselected.
- **Fecha** (date), **Inicio** (start) and **Fin** (end): in your local time zone. Inicio starts at the next half hour and Fin 30 minutes later; moving Inicio keeps the length. Fin must be after Inicio.
- **Ubicación** (location): optional.
- **Repetir cada semana** (repeat every week): optional. It turns the meeting into a weekly series:
  - **Los días** (the days) chooses one or more weekdays. It starts with the weekday of Fecha.
  - **Hasta** (until) is the last date the series may fall on. It starts eight weeks after Fecha.
  - If Fecha is not one of the chosen days, the first meeting is the next chosen day.
  - The button reads **Agregar serie** (add series).

  Google gets a weekly `RRULE` and Outlook a weekly pattern, both in your local time zone, so a 19:00 Tuesday class stays on Tuesdays at 19:00. Each meeting of the series gets its own reminders, like any other.

**Agregar** (add) creates the meeting in that calendar, then Narsil reads the calendar again so it shows in the list and gets its reminders. Problems show under the form in Spanish. An account that still has the old read-only calendar permission shows **Reconectar** there instead.

### Pendientes

The **Pendientes** (to-dos) tab keeps the tasks you jot down. Each task has:

- **Nombre** (name): required.
- **Proyecto** (project): optional. The field suggests the projects you already used.
- **Descripción** (description): optional.
- **Estado** (status): a label under the task that you change from its menu. A new task starts as **Por hacer**; the others are **Iniciada**, **En curso**, **En pausa** and **Terminada**.

Tasks are grouped by project, ignoring case, and tasks without a project come last. Inside a group, unfinished tasks come first, newest first, and **Terminada** ones go last. You can edit a task or delete it when you no longer need it; deleting asks once more. When there is more than one group, a selector shows a single project. The tab label shows how many tasks are not finished yet.

Tasks saved before statuses existed keep working: a task marked done becomes **Terminada** and the rest **Por hacer**.

Tasks are stored on this computer only, as plain JSON in `%APPDATA%\narsil-proxy\tasks.json`. They are never sent to Claude or to your mail accounts.

### Shared lists (in progress)

Shared lists let Narsil users give each other tasks. They live in a [Supabase](https://supabase.com) project, apart from your personal Pendientes, which stay on this computer. So far Narsil signs you in and the database holds the lists and their rules; the screens for them come next.

**One-time setup (the project owner)**

1. In Supabase, create a project. The Free plan is enough. Free projects pause after a week of low activity; resume them from the dashboard.
2. In Google Cloud Console, create an OAuth client of type **Web application**. Add `https://<project>.supabase.co/auth/v1/callback` as an authorized redirect URI.
   - While the consent screen is in testing, add every person who will use shared lists under **Google Auth Platform → Audience → Test users**.
3. In Supabase, open **Authentication → Sign In / Providers → Google**. Turn it on, then paste that client's ID and secret.
4. In Supabase, open **Authentication → URL Configuration → Redirect URLs** and add exactly `http://127.0.0.1:47813/auth/callback`.
5. In Supabase, open **Authentication → Sign In / Providers → Email**. Turn off sign-ups with email, because shared lists only use Google, but keep **Confirm email** and **Secure email change** on: membership is checked against the confirmed email.
6. Create the tables and their rules from `supabase/migrations/`. Use one of these:
   - **SQL Editor:** paste each file, in order, into the Supabase **SQL Editor** and run it.
   - **CLI:** run `npx supabase link --project-ref <project>`, then `npx supabase db push`. It asks for your database password.

**How the data is protected**

Every permission is a row level security policy in `supabase/migrations/`, so it holds whatever app or tool calls the database:

- **Invitations are by confirmed email and must be accepted.**
  - An invited person sees only the list name and who owns it, then accepts or declines.
  - Until they accept, they see no task or member, and nobody in the list sees their name.
- **Seeing:** only members who accepted see a list's members, its tasks and each other's names.
- **Tasks:** any member creates tasks and assigns them, only to members who accepted.
  - The assignee and the creator change a task: its status, name, description and assignee.
  - The creator or the list owner deletes a task.
- **Owner:** a list has exactly one owner. Only the owner invites, removes members, renames or deletes the list, and the owner cannot leave it.
- **Leaving:** any other member can leave. Removing or leaving deletes the tasks assigned to that person; tasks they created for others stay.
- **Server-side history:** who changed a task last, and when, always comes from the session and the server clock.
- **Email changes:** when a person changes their account email, their memberships, pending invitations and assigned tasks move to the new email. Nobody who later signs up with the old email inherits them.

The policies are tested in `supabase/tests/` against a local Supabase in Docker:

```powershell
npx supabase db start
```

```powershell
npx supabase test db
```

**Signing in (everyone)**

In **Ajustes → Listas compartidas**, paste the project URL and its **public** key (`sb_publishable_…`, or a legacy `anon` key), then choose **Guardar proyecto**. Narsil refuses a secret or `service_role` key, which would give full access.

**Iniciar sesión con Google** opens your browser and comes back to Narsil on port 47813 through OAuth PKCE. If another sign-in holds that port, close it first.

The session is encrypted under `secrets/shared-session.bin` and survives restarts. The project URL and key are saved in `shared.json`. Saving another project signs you out of the previous one.

### Inbox settings

**Ajustes → Cuentas** (settings, accounts) has two settings for each account:

- **Incluir Promociones y Social** (Gmail) or **Incluir la bandeja Otros** (Outlook): also review the mail Gmail sorts into its Promotions and Social tabs, or the mail Outlook's Focused Inbox puts in "Other". Off by default.
- **Revisar** (review): how far back Narsil looks for unread mail, 2, 7 or 30 days. 2 by default.

Narsil reviews that account's inbox again as soon as you change a setting. At most 20 unread emails per account are listed.

### New-mail notifications

Every 15 seconds Narsil runs a cheap change check on each account: Gmail's mailbox `historyId`, or the Outlook inbox's unread and total counts plus its newest message id. Only when that changes does Narsil read the full list of unread mail. The full list is also read every 60 seconds as a safety net.

When new mail arrives, rules run first, then Claude reads it, then Windows shows a notification with the sender, the subject, Claude's summary and its suggestion (for example "Sugerencia: archivar"). With several accounts the notification also names the account. When several emails arrive in one check you get one notification, "N correos nuevos", listing up to three subjects.

Clicking a notification opens the panel on the **Correo** tab and scrolls to that email, which flashes an amber outline. A grouped notification just opens the list.

These never notify:

- mail that was already unread when Narsil started, or when you added the account,
- mail a rule handled.

This is fast polling, not true push. Push needs a public HTTPS endpoint that Microsoft Graph can call, and a Google Cloud Pub/Sub topic for Gmail, which a desktop app on your own PC does not have.

### Check cadence

Narsil checks each inbox for changes every 15 seconds, reads the full unread list every minute, and reads the calendars every 5 minutes. Each account is checked on its own, so a problem with one account shows an error that starts with its address while the others keep working. Reminders cover timed events on each account's main calendar in the next 24 hours. All-day, cancelled and declined events are skipped. If Narsil starts less than 5 minutes before a meeting, you get only the 5-minute reminder.

## Use Narsil from Claude (MCP)

Claude Desktop and Claude Code can use Narsil through MCP. Claude starts a small bridge, `out/main/mcp.js`, which forwards each call to **the Narsil that is already open**. The bridge holds no credentials of its own: Narsil runs every call with the accounts it already has. If Narsil is closed, every tool answers that it is closed.

What Claude can do:

| Tool | What it does |
| --- | --- |
| `get_status` | Lists the connected accounts and the last error. |
| `get_inbox` | Reads the mail Narsil is watching, with its triage. |
| `get_meetings` | Lists the upcoming meetings. |
| `get_rules` | Lists the local rules and each account's Gmail filters or Outlook rules. |
| `list_folders` | Lists one account's labels or folders. |
| `list_tasks` | Lists the tasks in Pendientes. |
| `save_task` | Adds a task, or edits one. |
| `set_task_status` | Changes a task's status. |
| `delete_task` | Deletes a task. Marked destructive, so Claude asks first. |
| `archive_email` | Archives an email from the list. Marked destructive. |
| `delete_email` | Moves an email from the list to the trash. Marked destructive. |
| `move_email` | Moves an email to a label or folder of its account. Marked destructive. |
| `reply_email` | Sends a reply from the account that received the email. Marked destructive. |
| `create_meeting` | Adds a meeting to an account's calendar, or a weekly series on chosen days until a date. |
| `create_rule` | Creates a local Narsil rule. It also acts on the current list right away. Marked destructive. |
| `create_server_rule` | Creates a Gmail filter or an Outlook inbox rule in one account. It also acts on the current list right away. Marked destructive. |

Claude cannot edit or delete rules, and cannot touch accounts, keys or settings. Whatever Claude does shows up in the open window right away.

Narsil does not ask again before a mail action. The only confirmation is Claude's own permission prompt for tools marked destructive. Email text comes from outside senders, and a malicious email could try to talk Claude into sending or deleting mail. Do not choose "always allow" for any tool marked destructive.

**Setup**

1. Build Narsil once with `npm run build` (`npm start` builds too), and keep Narsil open.
2. Add the bridge to Claude, replacing `<repo>` with this folder's full path:
   - **Claude Desktop:** edit `%APPDATA%\Claude\claude_desktop_config.json`, then restart Claude Desktop:

     ```json
     {
       "mcpServers": {
         "narsil": { "command": "node", "args": ["<repo>\\out\\main\\mcp.js"] }
       }
     }
     ```

   - **Claude Desktop on a Mac:** edit `~/Library/Application Support/Claude/claude_desktop_config.json` the same way, with `"args": ["<repo>/out/main/mcp.js"]`. If Claude cannot find `node`, use its full path from `which node` as `command`.
   - **Claude Code:**

     ```powershell
     claude mcp add narsil --scope user -- node <repo>\out\main\mcp.js
     ```

**How the bridge finds Narsil**

On every start, Narsil opens a local endpoint with a random name:

- **Windows:** a named pipe, with its details in `%LOCALAPPDATA%\Narsil\mcp.json`.
- **Mac:** a Unix socket in `~/Library/Application Support/Narsil/`, with its details in `mcp.json` in that same folder.
- **Linux:** under `~/.local/state/narsil/`.

That file holds the endpoint and a random token, and lives in a folder only your user can read. On a Mac the socket and the file are also limited to your user. The bridge sends the token with every call, and Narsil refuses any call without it. When Narsil quits, it deletes the file.

## Claude usage and privacy

Each new email's sender, subject, date and text (up to 12,000 characters) is sent to the Claude API (`claude-opus-5-5`, low effort) once. The system prompt is cached, so repeated calls are cheaper. Email content is treated as untrusted data: Claude only returns a summary, a recommendation and reply drafts, and cannot act on your mailbox.

The MCP bridge is separate from that triage. When you use it, whatever a tool reads (for example the inbox with its snippets) goes to the Claude app you called it from, under that app's own privacy terms.

The request opts into server-side refusal fallbacks (`fallbacks: "default"`), so if Claude's safety classifiers decline an email, the API retries it on Anthropic's recommended fallback model. Remove the `betas` and `fallbacks` lines in `src/main/adapters/claude.ts` to turn that off.

## Development

```powershell
npm run dev
```

```powershell
npm test
```

```powershell
npm run typecheck
```

```powershell
npm run dist
```

`npm run dist` builds a Windows installer in `dist/`. The app and installer icon is `resources/icon-oscuro.ico`. The tray icon and Narsil's notification faces are PNGs in `resources/`, which electron-builder copies next to the app as `resources/icons` (`extraResources`); unpackaged, Narsil reads them from the repository's `resources/` folder.

### Layout

```
src/
  shared/types.ts          Types and IPC channel names shared by every process
  main/
    domain/                Pure logic with unit tests: reminders, weekly series, email parsing, reply MIME, triage prompt
    adapters/              Google (OAuth loopback + PKCE, Gmail, Gmail filters, Calendar), Microsoft (Graph mail,
                           inbox rules, calendar), Claude, encrypted store
    app/ports.ts           The provider port every account type implements
    app/accounts.ts        The account list and the legacy Google account migration
    app/narsilService.ts   Polling every account, triage queue, rules and reminder scheduling
    app/tasks.ts           The Pendientes list and its validation
    app/mcpTools.ts        What each MCP tool does inside Narsil
    adapters/mcpPipe.ts    The named pipe the MCP bridge calls, with its token check
    index.ts               Window, tray, notifications and validated IPC handlers
  preload/index.ts         The narrow `window.narsil` bridge
  mcp/                     The stdio MCP bridge (main.ts), its tool list (protocol.ts) and pipe client
  renderer/                React UI
resources/                 App, tray and notification icons (copied next to the packaged app)
tests/                     Vitest unit tests for the domain layer, providers and service
```
