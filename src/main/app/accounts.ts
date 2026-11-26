import { z } from 'zod'
import { DEFAULT_ACCOUNT_SETTINGS, type Account, type AccountSettings } from '@shared/types'
import type { SecureStore } from '../adapters/secureStore'

/** The part of SecureStore the core uses; tests pass an in-memory implementation. */
export type SecretStore = Pick<SecureStore, 'get' | 'getStrict' | 'set' | 'delete' | 'has' | 'list'>

export const AccountSettingsSchema = z.object({
  includeCategories: z.boolean(),
  windowDays: z.union([z.literal(2), z.literal(7), z.literal(30)])
})

const AccountsSchema = z.array(
  z.object({
    id: z.string().min(1),
    provider: z.enum(['google', 'microsoft']),
    email: z.string(),
    // Entries saved before settings existed have none; unreadable settings must not damage the list.
    settings: z.unknown().optional()
  })
)

/** An account as it is added; without settings it uses the defaults. */
export type NewAccount = Omit<Account, 'settings'> & { settings?: AccountSettings }

const DAMAGED = 'La lista de cuentas está dañada.'
const UNKNOWN_ACCOUNT = 'Esta cuenta ya no está conectada.'

function readSettings(raw: unknown): AccountSettings {
  const parsed = AccountSettingsSchema.safeParse(raw)
  return parsed.success ? parsed.data : { ...DEFAULT_ACCOUNT_SETTINGS }
}

/** The connected accounts, stored as JSON in the encrypted `accounts` secret. */
export class AccountRegistry {
  constructor(private readonly store: SecretStore) {}

  /** Every account, with its settings or the defaults when it has none. */
  list(): Account[] {
    return this.read().map((entry) => ({ ...entry, settings: readSettings(entry.settings) }))
  }

  add(account: NewAccount): void {
    this.write([...this.read().filter((a) => a.id !== account.id), account])
  }

  /** Saves one account's settings and returns the updated account. */
  setSettings(id: string, settings: AccountSettings): Account {
    const valid = AccountSettingsSchema.parse(settings)
    const entries = this.read()
    const entry = entries.find((a) => a.id === id)
    if (!entry) throw new Error(UNKNOWN_ACCOUNT)
    this.write(entries.map((a) => (a.id === id ? { ...a, settings: valid } : a)))
    return { id: entry.id, provider: entry.provider, email: entry.email, settings: valid }
  }

  remove(id: string): void {
    const accounts = this.read()
    const kept = accounts.filter((a) => a.id !== id)
    if (kept.length !== accounts.length) this.write(kept)
  }

  /** The stored entries as they are, so a rewrite keeps an entry without settings unchanged. */
  private read(): Array<z.infer<typeof AccountsSchema>[number]> {
    let raw: string | null
    try {
      // A strict read: an undecryptable list must not look like an empty one.
      raw = this.store.getStrict('accounts')
    } catch {
      throw new Error(DAMAGED)
    }
    if (!raw) return []
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      json = null
    }
    const parsed = AccountsSchema.safeParse(json)
    if (!parsed.success) throw new Error(DAMAGED)
    return parsed.data
  }

  private write(accounts: unknown[]): void {
    this.store.set('accounts', JSON.stringify(accounts))
  }
}

/**
 * The id of the account migrated from the legacy `google-tokens` secret. Fixed, so an
 * interrupted migration is recognized on the next start instead of leaving a second copy.
 */
export const LEGACY_GOOGLE_ACCOUNT_ID = 'legacy-google'

const GOOGLE_TOKENS_PREFIX = 'google-tokens.'

export interface LegacyGoogleMigration {
  store: SecretStore
  accounts: AccountRegistry
  /** Returns the mailbox address for the given token JSON (Gmail `users.getProfile`). */
  fetchEmail(tokens: string): Promise<string>
}

/** Deletes `google-tokens.<id>` secrets whose account is not registered, e.g. left by a crash. */
function sweepOrphanGoogleTokens(store: SecretStore, registered: Account[]): void {
  const ids = new Set(registered.map((a) => a.id))
  for (const name of store.list(GOOGLE_TOKENS_PREFIX)) {
    const id = name.slice(GOOGLE_TOKENS_PREFIX.length)
    if (id && !ids.has(id)) store.delete(name)
  }
}

/**
 * Runs at startup, before any account connects or signs in. Sweeps orphaned Google token
 * secrets, then moves the single-account `google-tokens` secret to per-account storage, so an
 * existing user keeps their Google account without signing in again.
 *
 * The legacy secret is deleted last, after the account is saved; when the profile lookup fails
 * it stays untouched and the migration is retried on the next start. When that mailbox is
 * already connected the legacy tokens are dropped locally (never revoked: they share Google's
 * grant with the connected account). Returns the migrated account, or null when nothing to do.
 */
export async function migrateLegacyGoogleTokens(migration: LegacyGoogleMigration): Promise<Account | null> {
  const { store, accounts } = migration
  const id = LEGACY_GOOGLE_ACCOUNT_ID
  const copy = `google-tokens.${id}` as const
  sweepOrphanGoogleTokens(store, accounts.list())

  const tokens = store.get('google-tokens')
  if (!tokens) return null
  if (accounts.list().some((a) => a.id === id)) {
    // A previous start registered the account but stopped before deleting the legacy secret.
    store.delete('google-tokens')
    return null
  }

  store.set(copy, tokens)
  let email: string
  try {
    email = (await migration.fetchEmail(tokens)).trim()
  } catch (error) {
    store.delete(copy)
    throw error
  }
  // Read again: an account may have been added while the profile lookup ran.
  const sameMailbox = accounts
    .list()
    .some((a) => a.provider === 'google' && a.email.toLowerCase() === email.toLowerCase())
  if (sameMailbox) {
    store.delete(copy)
    store.delete('google-tokens')
    return null
  }
  const account: Account = { id, provider: 'google', email, settings: { ...DEFAULT_ACCOUNT_SETTINGS } }
  accounts.add(account)
  store.delete('google-tokens')
  return account
}
