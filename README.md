# Narsil

<p align="center">
  <img src="https://raw.githubusercontent.com/davshn/narsil-pet/main/assets/readme/greeting-claro.svg" width="150" alt="Narsil says hello (light mode)">
  <img src="https://raw.githubusercontent.com/davshn/narsil-pet/main/assets/readme/greeting-oscuro.svg" width="150" alt="Narsil says hello (dark mode)">
</p>

> **Narsil Workshop · [narsil.davshn.tech](https://narsil.davshn.tech)**
>
> A free workshop, in English, Spanish, Italian, French, and Brazilian Portuguese, that teaches step by step how to build Claude Code mods like [Narsil](https://github.com/davshn/narsil-pet) and [Narsil Check](https://github.com/davshn/narsil-check), and how to build a Narsil desk bot with a body. No sign-up, no analytics, and it never asks for tokens or keys.

Narsil is the desktop mail and calendar assistant of the [Narsil](https://github.com/davshn/narsil-pet) family: a small sea serpent that floats in the bottom-right corner of your Windows desktop. She:

- connects any number of Google accounts (Gmail and Google Calendar) and Microsoft accounts (Outlook.com, Hotmail and Microsoft 365), and shows them as one inbox and one meetings list,
- watches each inbox for unread mail from the last two days by default, skipping Gmail's Promotions and Social tabs and Outlook's "Other" tab (see [Inbox settings](#inbox-settings)),
- uses Claude to summarize each email, recommend **reply**, **save**, **archive** or **delete**, and draft up to three replies you can edit before sending,
- reads each account's calendar and reminds you **15 minutes** and again **5 minutes** before each meeting, with a Windows notification and a banner that has a "Unirse a la llamada" (join call) button.

Nothing is sent, archived or deleted without your click.

It is an **open source** app, released under the [MIT](#license) license. It is not affiliated with Anthropic.

> **Language note:** Narsil's interface is in Spanish. This README keeps its labels as they appear on screen, with their English meaning next to them.

## Contents

- [Features](#features)
- [Installation](#installation)
- [Use Narsil from Claude (MCP)](#use-narsil-from-claude-mcp)
- [Supported systems](#supported-systems)
- [Claude usage and privacy](#claude-usage-and-privacy)
- [Other Narsil mods](#other-narsil-mods)
- [Development](#development)
- [License](#license)

## Features

### One inbox for every account
With more than one account connected, each email and meeting shows the address of the account it belongs to, and a reply always goes out from the account that received the email. Each email has these buttons:

| Button | Gmail | Outlook |
| --- | --- | --- |
| **Guardar** (save) | Opens a list of your labels, plus **Nueva carpeta…** (new folder) to create one. Picking a label adds it, removes the email from the inbox and marks it read. A `/` in a new name nests the label, as in `Facturas/2026`. | Opens a list of your folders, with subfolders shown as `Parent/Child`, plus **Nueva carpeta…** to create one. Picking a folder marks the email read and moves it there. |
| **Archivar** (archive) | Removes it from the inbox and marks it read. It stays in All Mail. | Moves it to the Archive folder and marks it read. |
| **Eliminar** (delete) | Moves it to Trash, where Gmail keeps it for 30 days. | Moves it to Deleted Items. |
| **Enviar respuesta** (send reply) | Sends your reply in the same thread and marks the email read. | Sends your reply in the same conversation and marks the email read. |

### Narsil on your desktop
Narsil sits above the taskbar as a little sea serpent, drawn with the art from narsilPet.

- The number next to Narsil shows how many unread emails are waiting.
- Her pose shows what is going on: idle (she bobs in the water with narsilPet's `parada` loop), reading new mail while Claude triages it, asking for attention when mail waits or a meeting is about to start, showing an error, or celebrating for a few seconds after an action or reply succeeds.
- The look follows the clock like the narsil-skin mod: a light theme from 6:00 to 17:59 and a dark theme the rest of the day, re-checked every 10 seconds. With reduced motion turned on in Windows, Narsil uses her still drawings and the theme changes without a fade.
- Click her to open the panel. Drag the bar above her, or the panel header, to move Narsil.
- Closing the panel (the minus button) shrinks Narsil back to the docked serpent. It keeps running.
- The tray icon (narsilPet's icon) lets you show or hide Narsil, check now, start Narsil with Windows, or quit.

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
Rules need one more permission: `gmail.settings.basic` for Google and `MailboxSettings.ReadWrite` for Microsoft. Adding meetings needs another: `calendar.events` for Google (instead of `calendar.readonly`) and `Calendars.ReadWrite` for Microsoft (instead of `Calendars.Read`). Accounts you added before these versions never granted them.

Narsil notices the first time it lists their rules or you add a meeting, and shows "Reconecta esta cuenta para administrar sus reglas y agregar reuniones" (*reconnect this account to manage its rules and add meetings*) with a **Reconectar** (reconnect) button, in **Ajustes**, in **Reglas** and in the **Agregar reunión** form. Click it once per account: your browser opens, you sign in with the same address and allow the new permissions.

Narsil keeps the account, its settings and its mail; signing in with another address is rejected and the old sign-in stays. Mail and reading the calendar keep working with the old permissions while an account waits for its reconnect.

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
- **Estado** (status): a label under the task that you change from its menu. A new task starts as **Por hacer** (to do); the others are **Iniciada** (started), **En curso** (in progress), **En pausa** (paused) and **Terminada** (done).

Tasks are grouped by project, ignoring case, and tasks without a project come last. Inside a group, unfinished tasks come first, newest first, and **Terminada** ones go last. You can edit a task or delete it when you no longer need it; deleting asks once more. When there is more than one group, a selector shows a single project. The tab label shows how many tasks are not finished yet.

Tasks saved before statuses existed keep working: a task marked done becomes **Terminada** and the rest **Por hacer**.

Tasks are stored on this computer only, as plain JSON in `%APPDATA%\narsil-proxy\tasks.json`. They are never sent to Claude or to your mail accounts.

### Shared lists
Shared lists let Narsil users give each other tasks. They live in a [Supabase](https://supabase.com) project, apart from your personal Pendientes, which stay on this computer. They show in **Pendientes → Compartidas** (shared), and Claude can use them through [MCP](#use-narsil-from-claude-mcp).

**Pendientes** has two views, **Mías** (your own tasks) and **Compartidas**. The tab count adds the unfinished shared tasks assigned to you.

- **Nueva lista** (new list) creates a list you own. Open its members line to invite people by their Google email, remove them, rename the list or delete it.
- An invitation shows at the top of Compartidas, with **Aceptar** (accept) and **Rechazar** (decline). Members other than the owner can **Salir de la lista** (leave the list).
- **Agregar tarea** (add task) adds a task, and **Para** (for) assigns it to a member who accepted. Each task shows who it is for and who changed it last, and when.
- The status label and **Editar** appear for the creator and the assignee; **Eliminar** appears for the creator and the list owner. The database enforces the same rules.
- Changes need a connection. Offline, Compartidas shows the last copy, with a note saying the sync failed.

To set them up, see [Shared lists setup](#shared-lists-setup).

#### Syncing
While you are signed in, Narsil reads your shared lists every 10 seconds. It also reads them right after you sign in and when you bring its window back. It polls instead of using Supabase Realtime, which needs no extra database setup and never sends you events about rows you cannot see.

The last copy is kept in `shared-cache.json`, so the lists still show while you are offline. Signing out deletes it. When someone else assigns you a task, or reassigns one to you, Windows shows "*Name* te asignó una tarea" (*Name assigned you a task*) with the task and its list. Several at once arrive as one notification, "N tareas nuevas para ti" (*N new tasks for you*). An invitation to a list also shows one, "*Name* te invitó a una lista" (*Name invited you to a list*). No email is sent: tell the person, and they see the invitation in Compartidas once they sign in with that Google email.

#### How the data is protected
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

The policies are tested in `supabase/tests/` (see [Development](#development)).

### Inbox settings
**Ajustes → Cuentas** (settings, accounts) has two settings for each account:

- **Incluir Promociones y Social** (Gmail) or **Incluir la bandeja Otros** (Outlook): also review the mail Gmail sorts into its Promotions and Social tabs, or the mail Outlook's Focused Inbox puts in "Other". Off by default.
- **Revisar** (review): how far back Narsil looks for unread mail, 2, 7 or 30 days. 2 by default.

Narsil reviews that account's inbox again as soon as you change a setting. At most 20 unread emails per account are listed.

### New-mail notifications
Every 15 seconds Narsil runs a cheap change check on each account: Gmail's mailbox `historyId`, or the Outlook inbox's unread and total counts plus its newest message id. Only when that changes does Narsil read the full list of unread mail. The full list is also read every 60 seconds as a safety net.

When new mail arrives, rules run first, then Claude reads it, then Windows shows a notification with the sender, the subject, Claude's summary and its suggestion (for example "Sugerencia: archivar", *suggestion: archive*). With several accounts the notification also names the account. When several emails arrive in one check you get one notification, "N correos nuevos" (*N new emails*), listing up to three subjects. Each notification shows Narsil's face, in her light or dark look depending on the hour.

Clicking a notification opens the panel on the **Correo** (mail) tab and scrolls to that email, which flashes an amber outline. A grouped notification just opens the list.

These never notify:

- mail that was already unread when Narsil started, or when you added the account,
- mail a rule handled.

This is fast polling, not true push. Push needs a public HTTPS endpoint that Microsoft Graph can call, and a Google Cloud Pub/Sub topic for Gmail, which a desktop app on your own PC does not have.

### Check cadence
Narsil checks each inbox for changes every 15 seconds, reads the full unread list every minute, and reads the calendars every 5 minutes. Each account is checked on its own, so a problem with one account shows an error that starts with its address while the others keep working.

Reminders cover timed events on each account's main calendar in the next 24 hours. All-day, cancelled and declined events are skipped. If Narsil starts less than 5 minutes before a meeting, you get only the 5-minute reminder.

## Installation

You need:

- Windows 10 or 11, or macOS 12 or later (see [On a Mac](#on-a-mac); not yet tested on real hardware)
- [Node.js](https://nodejs.org) 20 or later
- At least one Google account (Gmail and Google Calendar) or Microsoft account (Outlook.com, Hotmail or Microsoft 365)
- An Anthropic API key from <https://console.anthropic.com/>

### 1. Create a Google OAuth client (one time, for Google accounts)
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

Data access: while the consent screen is in "Testing" mode, you do not need to change anything for the new `gmail.settings.basic` and `calendar.events` scopes. You can optionally add them under **Google Auth Platform → Data access → Add or remove scopes**, so the consent screen lists them with the other Gmail scopes.

One OAuth client serves every Google account you add. While the consent screen is in "Testing" mode, add each account as a test user. Google expires the sign-in after 7 days, so you then need to remove the account under **Cuentas** (accounts) and add it again. Setting the publishing status to **In production** removes that limit. Because Gmail scopes are restricted, Google then shows an "unverified app" warning at sign-in, which you can accept for your own account.

### 2. Register a Microsoft app (one time, for Microsoft accounts)
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

### 3. Run Narsil
In a copy of this repository:

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

Then run the installer from `dist/`. It creates a **Narsil** shortcut in the Start Menu, which is how Windows learns the app's name and icon (app id `com.narsil.desktop`).

### 4. Connect your accounts
Click Narsil to open the panel, then go to **Ajustes** (settings):

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

The first time, macOS may ask to let Narsil use its Keychain entry; choose **Permitir siempre** (always allow). See [Supported systems](#supported-systems) for what else changes on a Mac.

### Shared lists setup
Shared lists are optional and need a [Supabase](https://supabase.com) project.

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

If you signed in before the tables existed, apply every migration, including `…_backfill_profiles.sql`: it creates the profile that account is missing.

**Adding another person**

The owner, once per person:

1. Add their Google email under **Google Auth Platform → Audience → Test users**, while the consent screen is in testing. Without it, Google refuses their sign-in.
2. Send them the project URL and the public key. Both are public by design: what each person may read or change is decided by the database rules, not by the key. Never send the secret key or the database password.
3. In **Pendientes → Compartidas**, invite their Google email to a list. No email is sent, so tell them.

The other person:

1. Install Narsil: run the installer the owner built with `npm run dist`, or follow [Run Narsil](#3-run-narsil). For shared lists alone they need no mail account, Google OAuth client or Anthropic key.
2. In **Ajustes → Listas compartidas** (shared lists), paste the project URL and the public key, choose **Guardar proyecto** (save project), then **Iniciar sesión con Google** (sign in with Google) with the email the owner invited.
3. Within 10 seconds Narsil shows "*Name* te invitó a una lista". Accept it at the top of **Pendientes → Compartidas**.

**Signing in (everyone)**

In **Ajustes → Listas compartidas**, paste the project URL and its **public** key (`sb_publishable_…`, or a legacy `anon` key), then choose **Guardar proyecto**. Narsil refuses a secret or `service_role` key, which would give full access.

**Iniciar sesión con Google** opens your browser and comes back to Narsil on port 47813 through OAuth PKCE. If another sign-in holds that port, close it first.

The session is encrypted under `secrets/shared-session.bin` and survives restarts. The project URL and key are saved in `shared.json`. Saving another project signs you out of the previous one.

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
| `get_shared_lists` | Syncs and lists the shared lists, their members and tasks, and the invitations waiting for an answer. |
| `create_shared_list` | Creates a shared list you own. |
| `rename_shared_list` | Renames a list you own. |
| `delete_shared_list` | Deletes a list you own, with its tasks. Marked destructive. |
| `invite_to_shared_list` | Invites a person by Google email. No email is sent. |
| `answer_shared_invitation` | Accepts or declines an invitation. |
| `remove_shared_member` | Removes a member and the tasks assigned to them. Marked destructive. |
| `leave_shared_list` | Leaves a list you do not own. Marked destructive. |
| `save_shared_task` | Adds or edits a shared task, assigned by email or by name. |
| `set_shared_task_status` | Changes a shared task's status. |
| `delete_shared_task` | Deletes a shared task. Marked destructive. |

Claude cannot edit or delete rules, and cannot touch accounts, keys or settings. Whatever Claude does shows up in the open window right away.

Shared-list tools run with your own signed-in session, so the database rules apply to Claude exactly as they apply to you. To assign a task by name, Narsil matches the members who accepted the list by email, full name or first name, ignoring case and accents. When a name fits more than one person, the tool fails and lists them, and Claude asks you which one.

Narsil does not ask again before a mail action. The only confirmation is Claude's own permission prompt for tools marked destructive. Email text comes from outside senders, and a malicious email could try to talk Claude into sending or deleting mail. Do not choose "always allow" for any tool marked destructive.

### Setup

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

### How the bridge finds Narsil

On every start, Narsil opens a local endpoint with a random name:

- **Windows:** a named pipe, with its details in `%LOCALAPPDATA%\Narsil\mcp.json`.
- **Mac:** a Unix socket in `~/Library/Application Support/Narsil/`, with its details in `mcp.json` in that same folder.
- **Linux:** under `~/.local/state/narsil/`.

That file holds the endpoint and a random token, and lives in a folder only your user can read. On a Mac the socket and the file are also limited to your user. The bridge sends the token with every call, and Narsil refuses any call without it. When Narsil quits, it deletes the file.

## Supported systems

Narsil is made for Windows. The same code runs on macOS 12 or later, but it has not been tried on a real Mac yet.

| | Windows | macOS |
| --- | --- | --- |
| Where Narsil lives | Above the taskbar, in the bottom-right corner | In the menu bar, not the Dock. Clicking the app again in Finder or Spotlight brings her back. |
| Start with the system | Tray menu option to start Narsil with Windows | Tray menu checkbox **Abrir al iniciar sesión** (open at login) |
| Secrets | Windows DPAPI (Electron `safeStorage`) under `%APPDATA%\narsil-proxy\secrets` | The macOS Keychain (Electron `safeStorage`) under `~/Library/Application Support/narsil-proxy/secrets` |
| MCP bridge | A named pipe | A Unix socket (see [How the bridge finds Narsil](#how-the-bridge-finds-narsil)) |
| Installer | `npm run dist`: an NSIS installer with a Start Menu shortcut | `npm run dist:mac`: an unsigned `.dmg` |
| Tested | Yes | Not yet: signing in with Google or Microsoft, notifications, and the menu bar icon have not been tried on a Mac |

On a Mac the app icon is the 256 px icon scaled up to 512 px (`resources/icon-512.png`). Replace it with a native 1024 px icon for a sharper Dock and Finder icon.

## Claude usage and privacy

Each new email's sender, subject, date and text (up to 12,000 characters) is sent to the Claude API (`claude-opus-5-5`, low effort) once. The system prompt is cached, so repeated calls are cheaper. Email content is treated as untrusted data: Claude only returns a summary, a recommendation and reply drafts, and cannot act on your mailbox.

The MCP bridge is separate from that triage. When you use it, whatever a tool reads (for example the inbox with its snippets) goes to the Claude app you called it from, under that app's own privacy terms.

The request opts into server-side refusal fallbacks (`fallbacks: "default"`), so if Claude's safety classifiers decline an email, the API retries it on Anthropic's recommended fallback model. Remove the `betas` and `fallbacks` lines in `src/main/adapters/claude.ts` to turn that off.
## Other Narsil mods

Narsil is one of several pieces. Each one installs on its own:

| | What it is |
| --- | --- |
| [Narsil](https://github.com/davshn/narsil-pet) | The Claude Code mod: a band above the prompt that shows what Claude is doing, with voice and alerts. This app uses her art. |
| [Narsil Check](https://github.com/davshn/narsil-check) | A side pane that checks the project you are working on. |
| [Narsil Skin](https://github.com/davshn/narsil-skin) | Color themes and animated wallpapers for the Claude desktop app. |
| [Narsil for Android](https://github.com/davshn/narsil-android) | `claude.ai` and Narsil's phone alerts in one Android app. |
| [Narsil Watch](https://github.com/davshn/narsil-watch) | Narsil on a Wear OS watch. |

## Development

Contributions are welcome: open an issue or a pull request on [GitHub](https://github.com/davshn/narsil-proxy).

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
npm run lint
```

```powershell
npm run format:check
```

```powershell
npm run dist
```

`npm run format` formats the code with Prettier. ESLint runs from `tools/eslint`, which `npm install` sets up, on TypeScript 6 until typescript-eslint supports TypeScript 7. GitHub Actions runs the type check, tests, build, lint and format check on every pull request and push to `main`.

`npm run dist` builds a Windows installer in `dist/`. The app and installer icon is `resources/icon-oscuro.ico`. The tray icon and Narsil's notification faces are PNGs in `resources/`, which electron-builder copies next to the app as `resources/icons` (`extraResources`); unpackaged, Narsil reads them from the repository's `resources/` folder.

The shared-list policies are tested in `supabase/tests/` against a local Supabase in Docker:

```powershell
npx supabase db start
```

```powershell
npx supabase test db
```

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
supabase/                  Shared-list migrations and their policy tests
tests/                     Vitest unit tests for the domain layer, providers and service
tools/eslint/              ESLint and its config, installed apart so it runs on TypeScript 6
```

## License

Narsil is free software under the [MIT](LICENSE) license.

In short: you can use, copy, modify, and share it, also in your own projects, as long as you keep the copyright notice and the license. It comes with no warranty. See the [LICENSE](LICENSE) file for the full text.

Copyright © 2026 Davshn
