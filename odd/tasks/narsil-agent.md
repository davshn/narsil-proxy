# Narsil desktop agent

Objective: a standalone Windows desktop agent that triages Gmail and reminds about Google Calendar meetings.
Branch: feat/narsil-agent. Delivery: ask-on-risk. Test runner: `npm test` (Vitest), `npm run typecheck`.

## Specs

- S1: "Quiero crear un Agente en una app de windows que sea Narsil, que se vea en mi pantalla" (a standalone app, unrelated to the Claude mods).
- S2: "revise mi correo entrante y me de opciones de respuesta" (Gmail).
- S3: "opcion de eliminar, archivar o guardar dependiendo del correo".
- S4: "que revise y calendario y me avisa 15 minutos y luego 5 minutos antes de cada reunion" (Google Calendar).
- S5: Stack is Electron + React + TypeScript; reply suggestions and triage use the Claude API.

## Tasks

- T1 [S1, S5] Scaffold Electron + Vite + React + TS. Inline. Done.
- T2 [S4] Reminder scheduler and Calendar adapter. Inline, RED then GREEN (tests/reminders.test.ts). Done.
- T3 [S2, S3] Gmail adapter, MIME reply builder, OAuth loopback + PKCE, encrypted store. Inline, RED then GREEN (tests/email.test.ts). Done.
- T4 [S2, S3] Claude triage with structured output. Inline (tests/triage.test.ts, written with the code). Done.
- T5 [S1-S4] Floating overlay UI, tray, notifications. Inline, checked with offscreen captures using mock data. Done.
- T6 README and setup guide. Done.

## Log

- L1 (2026-11-25): "Quiero crear un Agente en una app de windows que sea Narsil, que se vea en mi pantalla, revise mi correo entrante y me de opciones de respuesta, opcion de eliminar, archivar o guardar dependiendo del correo tambien que revise y calendario y me avisa 15 minutos y luego 5 minutos antes de cada reunion"
- L2 (2026-11-25): "todo es sobre una app nueva para windows completamente aparte de los mods de claude". Answers given: Gmail + Google Calendar; Electron + React + TS; Claude API.
- L3: Unit tests 28/28 green; typecheck and build pass. Not verified: a live Google sign-in and Claude call, because they need the user's OAuth client file and API key.
- L4: Engram mirror pending. `mem_current_project` returned no project for this folder.
