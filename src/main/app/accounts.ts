import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Account } from '@shared/types'
import type { SecureStore } from '../adapters/secureStore'

/** The part of SecureStore the core uses; tests pass an in-memory implementation. */
export type SecretStore = Pick<SecureStore, 'get' | 'set' | 'delete' | 'has'>

const AccountsSchema = z.array(
  z.object({ id: z.string().min(1), provider: z.enum(['google', 'microsoft']), email: z.string() })
)

/** The connected accounts, stored as JSON in the encrypted `accounts` secret. */
export class AccountRegistry {
  constructor(private readonly store: SecretStore) {}

  list(): Account[] {
    const raw = this.store.get('accounts')
    if (!raw) return []
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      json = null
    }
    const parsed = AccountsSchema.safeParse(json)
    if (!parsed.success) throw new Error('La lista de cuentas está dañada.')
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

export interface LegacyGoogleMigration {
  store: SecretStore
  accounts: AccountRegistry
  /** Returns the mailbox address for the given token JSON (Gmail `users.getProfile`). */
  fetchEmail(tokens: string): Promise<string>
  newId?: () => string
}

/**
 * Moves the single-account `google-tokens` secret to per-account storage, so an existing
 * user keeps their Google account without signing in again.
 *
 * Runs only while there is no Google account yet. The legacy secret is deleted last, after
 * the account is saved; when the profile lookup fails it stays untouched and the migration
 * is retried on the next start. Returns the migrated account, or null when nothing to do.
 */
export async function migrateLegacyGoogleTokens(migration: LegacyGoogleMigration): Promise<Account | null> {
  const { store, accounts } = migration
  const tokens = store.get('google-tokens')
  if (!tokens || accounts.list().some((a) => a.provider === 'google')) return null

  const id = (migration.newId ?? randomUUID)()
  store.set(`google-tokens.${id}`, tokens)
  let email: string
  try {
    email = await migration.fetchEmail(tokens)
  } catch (error) {
    store.delete(`google-tokens.${id}`)
    throw error
  }
  const account: Account = { id, provider: 'google', email }
  accounts.add(account)
  store.delete('google-tokens')
  return account
}
