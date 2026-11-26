# Multiple Google accounts and Microsoft accounts

Objective: Narsil connects any number of Google and Microsoft accounts behind one provider port, with a unified inbox and calendar.
Branch: feat/narsil-agent. Delivery: ask-on-risk. Test runner: `npm test` (Vitest), `npm run typecheck`, `npm run build`.

## Specs

- S1: "quiero poder agregar mas de una cuenta de google"
- S2: "y la opcion de agregar cuentas de microsoft"
- S3 (default chosen by the parent, stated to the user): one unified inbox and one meetings list across all accounts. Each email and meeting shows which account it belongs to. Replies always go out from the account that received the email.
- S4 (default): Microsoft accounts use Microsoft Graph with the `common` authority, so both personal (Outlook.com, Hotmail) and work or school (Microsoft 365) accounts work. Delegated scopes: `Mail.ReadWrite`, `Mail.Send`, `Calendars.Read`, `User.Read`, `offline_access`. The user registers an Entra app once and pastes its Application (client) ID into Narsil.
  - Outlook "Guardar" = flag and mark read.
  - "Archivar" = move to the Archive folder and mark read.
  - "Eliminar" = move to Deleted Items.
  - Reply = Graph reply in the same conversation.
- S5 (default): existing user rules apply to every account, with unchanged rule behavior.
- S6 (default): the existing single Google account (legacy secret `google-tokens`) migrates automatically to the new per-account storage on first start, without signing in again.
- S7: The interface stays in neutral Spanish. Code, comments and docs stay in English.

## Contract (owned by the parent, do not change)

- `src/main/app/ports.ts`: `MailProvider`, `CalendarProvider`, `AccountConnection`, `AddedAccount`, `ProviderAuth`.
- `src/shared/types.ts`: `ProviderKind`, `Account`, `EmailSummary.accountId`, `InboxItem.key` (`${accountId}:${email.id}`), `Meeting.accountId` and composite `Meeting.id`, `AppStatus.accounts` / `hasMicrosoftClient`, and the new `NarsilApi` / IPC names.
- `src/main/adapters/secureStore.ts`: secret names `accounts`, `google-tokens.<accountId>`, `microsoft-client`, `microsoft-cache`, `microsoft-account.<accountId>`.
- Microsoft entry point: `export class MicrosoftProvider implements ProviderAuth` in `src/main/adapters/microsoft/provider.ts`, with `constructor(store: SecureStore)`, `readonly kind = 'microsoft'`, and `saveClientId(clientId: string): void`. `saveClientId` throws a Spanish message for a value that is not a GUID.

## Tasks

- T1 [S1, S3, S5, S6, S7] Multi-account core, Google provider, migration, IPC, UI, README. Route: delegated writer (parallel units; context backstop).
- T2 [S2, S4] Microsoft provider: MSAL Node auth, Graph mail and calendar, pure mappers with tests. Route: delegated writer (parallel units; context backstop).
- T3 Seam check (full suite, typecheck, build, UI capture). Route: parent.

## Log

- L1 (2026-11-25): "vamos a hacer cambios quiero poder agregar mas de una cuenta de google y la opcion de agregar cuentas de microsoft"
- L2: The parent defined the contract above and installed `@azure/msal-node@^7.2.3`. Both writers run in parallel on disjoint edit surfaces. Risk: item 1 (persisted format change, migrating the legacy Google token secret) and item 2 (auth, credentials).
- L3: Both writers finished. The seam check found that discarding a duplicate Microsoft sign-in removed the shared MSAL cache account; fixed in the provider (unconnected set) with a RED-then-GREEN test. 107/107 tests pass, typecheck and build pass, UI checked with captures. README Microsoft registration section filled in.
- L4: The independent verifier found blocker B1 (a second click joining a pending sign-in wiped the just-added account) plus migration edge cases, damaged-registry detection, Microsoft duplicate detection by homeAccountId, cleanup of abandoned MSAL sign-ins, and HTML escaping in Outlook replies. One correction batch fixed all of them with RED→GREEN regression tests. Parent recheck: 133/133 tests, typecheck and build pass; the B1 regression tests pass for Google and Microsoft. Not verified against real Google/Microsoft mailboxes.
