# Narsil

Narsil is a small assistant that floats in the bottom-right corner of your Windows desktop. It:

- connects any number of Google accounts (Gmail and Google Calendar) and Microsoft accounts (Outlook.com, Hotmail and Microsoft 365), and shows them as one inbox and one meetings list,
- watches each inbox for unread mail from the last two days (skipping Gmail's Promotions and Social tabs),
- uses Claude to summarize each email, recommend **reply**, **save**, **archive** or **delete**, and draft up to three replies you can edit before sending,
- reads each account's calendar and reminds you **15 minutes** and again **5 minutes** before each meeting, with a Windows notification and a banner that has a "Unirse a la llamada" (join call) button. The interface is in Spanish.

Nothing is sent, archived or deleted without your click. With more than one account connected, each email and meeting shows the address of the account it belongs to, and a reply always goes out from the account that received the email.

| Button | Gmail | Outlook |
| --- | --- | --- |
| Guardar (save) | Stars the email and marks it read. It stays in the inbox. | Flags the email and marks it read. It stays in the inbox. |
| Archivar (archive) | Removes it from the inbox and marks it read. It stays in All Mail. | Moves it to the Archive folder and marks it read. |
| Eliminar (delete) | Moves it to Trash, where Gmail keeps it for 30 days. | Moves it to Deleted Items. |
| Enviar respuesta (send reply) | Sends your reply in the same thread and marks the email read. | Sends your reply in the same conversation and marks the email read. |

## Requirements

- Windows 10 or 11
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

- `gmail.modify`: read mail, star, archive and move to Trash (it cannot permanently delete)
- `gmail.send`: send the replies you approve
- `calendar.readonly`: read your events

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
   - `Calendars.Read`
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

Narsil appears as a steel shard above the taskbar. Click it to open the panel, then go to **Ajustes** (settings):

1. **Elegir archivo de cliente** (choose client file): for Google accounts, pick the JSON you downloaded.
2. **Guardar ID** (save ID): for Microsoft accounts, paste the Application (client) ID of your Microsoft app.
3. **Agregar cuenta de Google** / **Agregar cuenta de Microsoft** (add Google / Microsoft account): your browser opens. Sign in and allow access. Repeat for every account you want. Each button stays disabled until its provider is set up in step 1 or 2. **Quitar** (remove) next to an account under **Cuentas** (accounts) signs it out and drops its emails and meetings.
4. **Guardar clave** (save key): paste your Anthropic API key. If `ANTHROPIC_API_KEY` is set in your environment, Narsil uses that instead.

If you used an earlier version with one Google account, Narsil moves it to the new account list on first start, so you do not need to sign in again.

Secrets are encrypted with Windows DPAPI (Electron `safeStorage`) under `%APPDATA%\narsil-proxy\secrets`.

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

Rules apply to the mail of every connected account. They never delete permanently: "Eliminar" moves the email to Trash in Gmail, where it stays for 30 days, or to Deleted Items in Outlook.

### New-mail notifications

Every 15 seconds Narsil runs a cheap change check on each account: Gmail's mailbox `historyId`, or the Outlook inbox's unread and total counts plus its newest message id. Only when that changes does Narsil read the full list of unread mail. The full list is also read every 60 seconds as a safety net.

When new mail arrives, rules run first, then Claude reads it, then Windows shows a notification with the sender, the subject, Claude's summary and its suggestion (for example "Sugerencia: archivar"). With several accounts the notification also names the account. When several emails arrive in one check you get one notification, "N correos nuevos", listing up to three subjects.

Clicking a notification opens the panel on the **Correo** tab and scrolls to that email, which flashes an ember outline. A grouped notification just opens the list.

These never notify:

- mail that was already unread when Narsil started, or when you added the account,
- mail a rule handled.

This is fast polling, not true push. Push needs a public HTTPS endpoint that Microsoft Graph can call, and a Google Cloud Pub/Sub topic for Gmail, which a desktop app on your own PC does not have.

### Check cadence

Narsil checks each inbox for changes every 15 seconds, reads the full unread list every minute, and reads the calendars every 5 minutes. Each account is checked on its own, so a problem with one account shows an error that starts with its address while the others keep working. Reminders cover timed events on each account's main calendar in the next 24 hours. All-day, cancelled and declined events are skipped. If Narsil starts less than 5 minutes before a meeting, you get only the 5-minute reminder.

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
    adapters/              Google (OAuth loopback + PKCE, Gmail, Calendar), Microsoft (Graph), Claude, encrypted store
    app/ports.ts           The provider port every account type implements
    app/accounts.ts        The account list and the legacy Google account migration
    app/narsilService.ts   Polling every account, triage queue, rules and reminder scheduling
    index.ts               Window, tray, notifications and validated IPC handlers
  preload/index.ts         The narrow `window.narsil` bridge
  renderer/                React UI
tests/                     Vitest unit tests for the domain layer, providers and service
```
