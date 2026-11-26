# Narsil

Narsil is a small assistant that floats in the bottom-right corner of your Windows desktop. It:

- watches your Gmail inbox for unread mail from the last two days (skipping the Promotions and Social tabs),
- uses Claude to summarize each email, recommend **reply**, **save**, **archive** or **delete**, and draft up to three replies you can edit before sending,
- reads your Google Calendar and reminds you **15 minutes** and again **5 minutes** before each meeting, with a Windows notification and a banner that has a "Unirse a la llamada" (join call) button. The interface is in Spanish.

Nothing is sent, archived or deleted without your click.

| Button | What it does in Gmail |
| --- | --- |
| Guardar (save) | Stars the email and marks it read. It stays in the inbox. |
| Archivar (archive) | Removes it from the inbox and marks it read. It stays in All Mail. |
| Eliminar (delete) | Moves it to Trash, where Gmail keeps it for 30 days. |
| Enviar respuesta (send reply) | Sends your reply in the same thread and marks the email read. |

## Requirements

- Windows 10 or 11
- Node.js 20 or later
- A Google account (Gmail and Google Calendar)
- An Anthropic API key from <https://console.anthropic.com/>

## 1. Create a Google OAuth client (one time)

Narsil talks to Gmail and Calendar with your own Google Cloud project, so your data never passes through a third-party server.

1. Open <https://console.cloud.google.com/> and create a project, for example "Narsil".
2. Under **APIs & Services > Library**, enable the **Gmail API** and the **Google Calendar API**.
3. Under **APIs & Services > OAuth consent screen**, choose **External**, fill in the app name and your email, and add yourself as a **test user**.
4. Under **APIs & Services > Credentials**, click **Create credentials > OAuth client ID**, choose **Desktop app**, and download the JSON file.

Keep that file private. Narsil asks for these permissions:

- `gmail.modify`: read mail, star, archive and move to Trash (it cannot permanently delete)
- `gmail.send`: send the replies you approve
- `calendar.readonly`: read your events

While the consent screen is in "Testing" mode, Google expires the sign-in after 7 days and you will need to click **Conectar Google** again. Setting the publishing status to **In production** removes that limit. Because Gmail scopes are restricted, Google then shows an "unverified app" warning at sign-in, which you can accept for your own account.

## 2. Run Narsil

```powershell
npm install
node node_modules/electron/install.js
npm run build
npm start
```

The second command downloads the Electron runtime. Recent npm versions skip that download during `npm install`.

Narsil appears as a steel shard above the taskbar. Click it to open the panel, then go to **Ajustes** (settings):

1. **Elegir archivo de cliente**: pick the JSON you downloaded.
2. **Conectar Google**: your browser opens. Sign in and allow access.
3. **Guardar clave**: paste your Anthropic API key. If `ANTHROPIC_API_KEY` is set in your environment, Narsil uses that instead.

Secrets are encrypted with Windows DPAPI (Electron `safeStorage`) under `%APPDATA%\narsil\secrets`.

## Using it

- The number on the shard shows how many unread emails are waiting.
- Drag the bar above the shard, or the panel header, to move Narsil.
- The tray icon lets you show or hide Narsil, check now, start Narsil with Windows, or quit.
- Closing the panel (the minus button) shrinks Narsil back to the shard. It keeps running.

### Rules

The **Reglas** (rules) tab holds rules you define, such as "sender contains `shop.example`: move to Trash". Each rule has up to three case-insensitive "contains" conditions (sender, subject, body text). All the conditions you fill in must match, and a rule needs at least one. Its action is archive, move to Trash, or save.

- Rules run on every new email **before** Claude sees it, so a handled email never costs an API call and never appears in the list.
- Saving a rule also applies it to the emails already in the list.
- The first enabled rule that matches, in list order, wins.
- **Crear regla** (create rule) on an email opens the form prefilled with its sender.
- **Actividad reciente** (recent activity) lists the last 50 actions rules took, including failures. A failed action leaves the email in the list.
- Rules only run while Narsil is open. They are stored as plain JSON in `%APPDATA%\narsil-proxy\rules.json`.

Rules never delete permanently: "Eliminar" moves the email to Trash, where Gmail keeps it for 30 days.

Narsil checks mail every minute and the calendar every 5 minutes. Reminders cover timed events on your primary calendar in the next 24 hours. All-day, cancelled and declined events are skipped. If Narsil starts less than 5 minutes before a meeting, you get only the 5-minute reminder.

## Claude usage and privacy

Each new email's sender, subject, date and text (up to 12,000 characters) is sent to the Claude API (`claude-opus-5-5`, low effort) once. The system prompt is cached, so repeated calls are cheaper. Email content is treated as untrusted data: Claude only returns a summary, a recommendation and reply drafts, and cannot act on your mailbox.

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

`npm run dist` builds a Windows installer in `dist/`.

### Layout

```
src/
  shared/types.ts          Types and IPC channel names shared by every process
  main/
    domain/                Pure logic with unit tests: reminders, email parsing, reply MIME, triage prompt
    adapters/              Gmail, Calendar, Google OAuth (loopback + PKCE), Claude, encrypted store
    app/narsilService.ts   Polling, triage queue and reminder scheduling
    index.ts               Window, tray, notifications and validated IPC handlers
  preload/index.ts         The narrow `window.narsil` bridge
  renderer/                React UI
tests/                     Vitest unit tests for the domain layer
```
