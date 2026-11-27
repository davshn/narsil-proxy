# narsil-proxy

Workflow rules (plan, git, pull requests, reviews) live in the owner's working agreement: E:\Proyectos\narsil-boss\CLAUDE.md, section "The owner's working agreement".

## Never launch Narsil

An agent never launches Narsil: not `npm start`, not `npm run dev`, not the installer that `npm run dist` builds, and not the built or installed app.

Narsil runs on the owner's real data in `%APPDATA%\narsil-proxy`: their connected accounts, their DPAPI-encrypted secrets (OAuth tokens, the Anthropic key, the shared-lists session) and their real mail. A launched copy polls those accounts, triages mail with Claude and can act on it. If a check needs the running app, ask the owner to launch it.

## Stack

Electron with electron-vite, React and TypeScript. Tests use Vitest. Shared lists use Supabase (`supabase/migrations/`, `supabase/tests/`).

## Checks

Run these before every push. None of them launches the app:

```powershell
npm test
```

```powershell
npm run typecheck
```

```powershell
npm run build
```

The Supabase policy tests (`npx supabase db start`, then `npx supabase test db`) need Docker and run against a local database, never the owner's project.
