import { z } from 'zod'
import type { Account } from '@shared/types'
import type { SecureStore } from '../adapters/secureStore'

/** The part of SecureStore the core uses; tests pass an in-memory implementation. */
export type SecretStore = Pick<SecureStore, 'get' | 'getStrict' | 'set' | 'delete' | 'has' | 'list'>

const AccountsSchema = z.array(
  z.object({ id: z.string().min(1), provider: z.enum(['google', 'microsoft']), email: z.string() })
)

const DAMAGED = 'La lista de cuentas está dañada.'

/** The connected accounts, stored as JSON in the encrypted `accounts` secret. */
export class AccountRegistry {
  constructor(private readonly store: SecretStore) {}

  list(): Account[] {
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

  add(account: Account): void {
    this.write([...this.list().filter((a) => a.id !== account.id), account])
  }

  remove(id: string): void {
    const accounts = this.list()
    const kept = accounts.filter((a) => a.id !== id)
    if (kept.length !== accounts.length) this.write(kept)
  }

  private write(accounts: Account[]): void {
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
  const account: Account = { id, provider: 'google', email }
  accounts.add(account)
  store.delete('google-tokens')
  return account
}
