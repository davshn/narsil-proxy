# Near-instant new-mail detection and notifications

Objective: detect new mail within about 15 seconds through cheap change checks, triage it right away, and show a Windows notification that opens the email.
Branch: feat/narsil-agent. Delivery: ask-on-risk. Test runner: `npm test` (Vitest), `npm run typecheck`, `npm run build`.

## Specs

- S1: "que cuando llegue un correo notifique y lo revise de una vez"
- S2 (agreed option): every ~15 s, each account runs a cheap change check: Gmail `users.getProfile` `historyId`; Graph inbox `unreadItemCount` plus the newest message id. Only when the token changed does the full unread list run. The full list still runs every 60 s as a safety net.
- S3 (agreed flow): new email → Narsil detects it → Claude analyzes it immediately → Windows notification with sender, summary and suggested action → clicking it opens the panel on that email.
- S4: emails handled by a user rule do not notify. The emails already unread when an account first loads (app start or account added) do not notify. When several new emails arrive in one check, show one grouped notification ("N correos nuevos") instead of one each.
- S5: UI and notification text in neutral Spanish; code and docs in English.

## Tasks

- T1 [S1-S5] Change token on `MailProvider` (Gmail and Outlook), fast tick, new-email notifications, focus-on-click. Route: delegated writer (context backstop).
- T2 Seam check. Route: parent.

## Log

- L1 (2026-11-26): "no se puede que cuando llegue un correo notifique y lo revise de una vez?" The parent proposed fast incremental polling over real push, because push needs a public HTTPS endpoint or Pub/Sub setup. User: "sí, impleméntala así".
- L2: The writer finished T1. Parent recheck: 146/146 tests, typecheck and build pass. The notification text and click-to-focus were not exercised in the running app. Risk: item 4 (the 15 s tick shares per-account busy and token state with the 60 s poll and add/remove); independent verifier launched.
- L3: The concurrency verifier found a blocker: emails re-entering the unread window, or unread at start-up, were announced again or for the first time. Also: piled-up change checks, the token saved after a partial poll, a stale busy flag after re-add, a ghost email after removal, and announcements with triage:null. One correction batch fixed all of them with RED→GREEN tests. Parent recheck: 154/154, typecheck and build pass. Known limitation: "new" compares the provider receivedAt with the local clock, so a PC clock running ahead could miss mail arriving in the first seconds after an account loads.
