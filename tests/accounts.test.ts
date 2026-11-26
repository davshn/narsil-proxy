import { describe, expect, it, vi } from 'vitest'
import { AccountRegistry, migrateLegacyGoogleTokens, type SecretStore } from '../src/main/app/accounts'

function memoryStore(initial: Record<string, string> = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: (name) => data.get(name) ?? null,
    set: (name, value) => void data.set(name, value),
    delete: (name) => void data.delete(name),
    has: (name) => data.has(name)
  }
}

const LEGACY = JSON.stringify({ refresh_token: 'r-1', access_token: 'a-1' })

describe('AccountRegistry', () => {
  it('starts empty and persists added accounts as JSON in the accounts secret', () => {
    const store = memoryStore()
    const registry = new AccountRegistry(store)
    expect(registry.list()).toEqual([])

    registry.add({ id: 'g1', provider: 'google', email: 'ana@gmail.com' })
    registry.add({ id: 'm1', provider: 'microsoft', email: 'ana@outlook.com' })

    expect(JSON.parse(store.data.get('accounts') ?? '[]')).toEqual([
      { id: 'g1', provider: 'google', email: 'ana@gmail.com' },
      { id: 'm1', provider: 'microsoft', email: 'ana@outlook.com' }
    ])
    expect(new AccountRegistry(store).list()).toHaveLength(2)
  })

  it('removes an account by id and ignores unknown ids', () => {
    const store = memoryStore()
    const registry = new AccountRegistry(store)
    registry.add({ id: 'g1', provider: 'google', email: 'ana@gmail.com' })

    registry.remove('nope')
    registry.remove('g1')

    expect(registry.list()).toEqual([])
    expect(new AccountRegistry(store).list()).toEqual([])
  })

  it('refuses to read a damaged accounts list', () => {
    const store = memoryStore({ accounts: '{"not":"a list"}' })
    expect(() => new AccountRegistry(store).list()).toThrow('La lista de cuentas está dañada.')
  })
})

describe('migrateLegacyGoogleTokens', () => {
  it('moves the legacy Google tokens to a new account without signing in again', async () => {
    const store = memoryStore({ 'google-tokens': LEGACY })
    const accounts = new AccountRegistry(store)
    const fetchEmail = vi.fn(async () => 'ana@gmail.com')

    const migrated = await migrateLegacyGoogleTokens({ store, accounts, fetchEmail, newId: () => 'g-new' })

    expect(migrated).toEqual({ id: 'g-new', provider: 'google', email: 'ana@gmail.com' })
    expect(fetchEmail).toHaveBeenCalledWith(LEGACY)
    expect(store.data.get('google-tokens.g-new')).toBe(LEGACY)
    expect(store.data.has('google-tokens')).toBe(false)
    expect(accounts.list()).toEqual([{ id: 'g-new', provider: 'google', email: 'ana@gmail.com' }])
  })

  it('keeps the legacy tokens untouched and adds no account when the profile lookup fails', async () => {
    const store = memoryStore({ 'google-tokens': LEGACY })
    const accounts = new AccountRegistry(store)

    await expect(
      migrateLegacyGoogleTokens({
        store,
        accounts,
        fetchEmail: async () => {
          throw new Error('offline')
        },
        newId: () => 'g-new'
      })
    ).rejects.toThrow('offline')

    expect(store.data.get('google-tokens')).toBe(LEGACY)
    expect(store.data.has('google-tokens.g-new')).toBe(false)
    expect(accounts.list()).toEqual([])
  })

  it('does nothing without legacy tokens or when a Google account already exists', async () => {
    const fetchEmail = vi.fn(async () => 'x@gmail.com')
    const empty = memoryStore()
    expect(await migrateLegacyGoogleTokens({ store: empty, accounts: new AccountRegistry(empty), fetchEmail })).toBeNull()

    const store = memoryStore({ 'google-tokens': LEGACY })
    const accounts = new AccountRegistry(store)
    accounts.add({ id: 'g1', provider: 'google', email: 'ana@gmail.com' })
    expect(await migrateLegacyGoogleTokens({ store, accounts, fetchEmail })).toBeNull()

    expect(fetchEmail).not.toHaveBeenCalled()
    expect(store.data.get('google-tokens')).toBe(LEGACY)
  })
})
