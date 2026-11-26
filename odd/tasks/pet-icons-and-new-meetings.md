# Animated idle pet, Narsil-branded notifications and adding meetings

Objective: Narsil animates while idle, notifications carry Narsil's face, name and icon, and the user can add meetings to a chosen account's calendar.
Branch: feat/narsil-agent. Test runner: `npm test`, `npm run typecheck`, `npm run build`.

## Specs

- S1: "veo que la imagen de narsil inicial sin notificaciones esta estatica, no estas usando un video? usalo"
  - Verified by the parent: narsilPet has no `base` loop.
  - Its animated loops (`E:\Proyectos\narsilPet\assets\anim\<pose>-<claro|oscuro>.webp`) are hola, trabajando, necesita, parada, terminado and error.
  - The idle pose uses the `parada` loop, and `base` stays only as a still for reduced motion.
- S2: "las notificaciones deberian llegar con la cuenta de narsil, y el nombre narsil, dicen electron y tienen su icono"
  - Every Notification (new mail and meeting reminders) sets `icon` to Narsil's face, in the claro or oscuro variant chosen by the hour (`src/shared/dayNight.ts`).
  - The tray icon and the app/installer icon use narsilPet's icon: `E:\Proyectos\narsilPet\overlay\icon.png` (256×256) and `icon-oscuro.ico`.
  - The packaged app shows the name "Narsil": electron-builder `productName` is Narsil, `appId` is com.narsil.desktop and matches `app.setAppUserModelId`, the NSIS installer creates the Start Menu shortcut, and `win.icon` is set.
  - Under `npm start` (unpackaged) Windows still labels toasts "Electron". This is documented in the README; it is not worked around.
- S3: "quiero un boton de agregar reunion al calendario con selector de fecha y selector de cuenta"
  - "Agregar reunión" in the Reuniones tab opens a form: Título (required); Cuenta (select of connected accounts); Fecha (date picker); Inicio and Fin (time pickers, local time zone, Fin after Inicio, default 30 min); Ubicación (optional).
  - Saving creates the event in that account's primary calendar, then refreshes meetings.
- S4: scopes.
  - Google: replace `calendar.readonly` with `https://www.googleapis.com/auth/calendar.events`.
  - Microsoft: replace `Calendars.Read` with `Calendars.ReadWrite`.
  - Accounts without the write scope get the existing `needsReconnect` / "Reconectar" flow. The notice text must say it covers rules and adding meetings, and reading the calendar must keep working with the old scope.
- S5: UI in neutral Spanish; code and docs in English.

## Tasks

- T1 [S1-S5] Delegated writer (context backstop).

## Log

- L1 (2026-11-26): the user's request quoted in S1-S3. The user also asked which model triages mail; the parent answered `claude-opus-5-5` at effort low (src/main/adapters/claude.ts).
- L2: The writer finished T1. The parent added the two pure renderer helpers to tsconfig.node.json include (typecheck had failed with TS6307). Parent recheck: 291/291 tests, typecheck clean, build OK; electron-builder --dir produced Narsil.exe with the icon. The parent reviewed the form, notification face and tray captures. Risk: items 2/3 (OAuth scope sets changed, Microsoft token scopes for mail/calendar reads, new port method); verifier launched.
- L3: The verifier found a blocker: Outlook rules asked for Calendars.ReadWrite, which broke rules for accounts already consented to rules; also a should-fix (the meeting form hid real errors when only the rules needed a reconnect) and a nit. The parent fixed it inline with per-feature scope sets (RULES_SCOPES, MEETING_WRITE_SCOPES) and the verifier probe as tests/microsoftProvider.scopes.test.ts (RED→GREEN), plus the form error fix. The ISO-date nit is left (the renderer always sends ISO). 293/293 tests, typecheck and build pass.
- L4: Native review declined by the user for this change ("Skip this time").
