import { describe, expect, it, vi } from 'vitest'
import {
  AccountRegistry,
  LEGACY_GOOGLE_ACCOUNT_ID,
  migrateLegacyGoogleTokens,
  type SecretStore
} from '../src/main/app/accounts'
import type { SecretName } from '../src/main/adapters/secureStore'

function memoryStore(initial: Record<string, string> = {}): SecretStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    get: (name) => data.get(name) ?? null,
    getStrict: (name) => data.get(name) ?? null,
    set: (name, value) => void data.set(name, value),
    delete: (name) => void data.delete(name),
    has: (name) => data.has(name),
    list: (prefix) => [...data.keys()].filter((name) => name.startsWith(prefix)) as SecretName[]
  }
}

const LEGACY = JSON.stringify({ refresh_token: 'r-1', access_token: 'a-1' })
const ID = LEGACY_GOOGLE_ACCOUNT_ID
const offline = async (): Promise<string> => {
  throw new Error('offline')
}

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

  it('reports an accounts secret that cannot be decrypted as damaged instead of an empty list', () => {
    const store = memoryStore({ accounts: '[]' })
    store.get = () => null // the lenient read hides the failure
    store.getStrict = (name) => {
      throw new Error(`No se pudo descifrar el secreto ${name}.`)
    }
    const registry = new AccountRegistry(store)

    expect(() => registry.list()).toThrow(new Error('La lista de cuentas está dañada.'))
    expect(() => registry.add({ id: 'g1', provider: 'google', email: 'ana@gmail.com' })).toThrow('dañada')
    expect(store.data.get('accounts')).toBe('[]')
  })
})

describe('migrateLegacyGoogleTokens', () => {
  it('moves the legacy Google tokens to a new account without signing in again', async () => {
    const store = memoryStore({ 'google-tokens': LEGACY })
    const accounts = new AccountRegistry(store)
    const fetchEmail = vi.fn(async () => 'ana@gmail.com')

    const migrated = await migrateLegacyGoogleTokens({ store, accounts, fetchEmail })

    expect(migrated).toEqual({ id: ID, provider: 'google', email: 'ana@gmail.com' })
    expect(fetchEmail).toHaveBeenCalledWith(LEGACY)
    expect(store.data.get(`google-tokens.${ID}`)).toBe(LEGACY)
    expect(store.data.has('google-tokens')).toBe(false)
    expect(accounts.list()).toEqual([{ id: ID, provider: 'google', email: 'ana@gmail.com' }])
  })

  it('keeps the legacy tokens untouched and adds no account when the profile lookup fails', async () => {
    const store = memoryStore({ 'google-tokens': LEGACY })
    const accounts = new AccountRegistry(store)

    await expect(migrateLegacyGoogleTokens({ store, accounts, fetchEmail: offline })).rejects.toThrow('offline')

    expect(store.data.get('google-tokens')).toBe(LEGACY)
    expect(store.data.has(`google-tokens.${ID}`)).toBe(false)
    expect(accounts.list()).toEqual([])
  })

  it('does nothing without legacy tokens', async () => {
    const fetchEmail = vi.fn(async () => 'x@gmail.com')
    const store = memoryStore()
    expect(await migrateLegacyGoogleTokens({ store, accounts: new AccountRegistry(store), fetchEmail })).toBeNull()
    expect(fetchEmail).not.toHaveBeenCalled()
  })

  it('migrates on a later start after another Google account was added while offline', async () => {
    const store = memoryStore({ 'google-tokens': LEGACY })
    const accounts = new AccountRegistry(store)
    await expect(migrateLegacyGoogleTokens({ store, accounts, fetchEmail: offline })).rejects.toThrow('offline')
    accounts.add({ id: 'g2', provider: 'google', email: 'work@gmail.com' })

    const migrated = await migrateLegacyGoogleTokens({ store, accounts, fetchEmail: async () => 'ana@gmail.com' })

    expect(migrated).toEqual({ id: ID, provider: 'google', email: 'ana@gmail.com' })
    expect(store.data.has('google-tokens')).toBe(false)
    expect(accounts.list().map((a) => a.email)).toEqual(['work@gmail.com', 'ana@gmail.com'])
  })

  it('drops the legacy tokens without adding a duplicate when that email is already connected', async () => {
    const store = memoryStore({ 'google-tokens': LEGACY })
    const accounts = new AccountRegistry(store)
    let release!: (email: string) => void
    const pending = migrateLegacyGoogleTokens({
      store,
      accounts,
      fetchEmail: () => new Promise((resolve) => (release = resolve))
    })
    // The same mailbox is signed in while the profile lookup is still running.
    store.set('google-tokens.g-ui', '{"refresh_token":"r-ui"}')
    accounts.add({ id: 'g-ui', provider: 'google', email: 'Ana@Gmail.com' })
    release('ana@gmail.com')

    expect(await pending).toBeNull()

    expect(accounts.list()).toEqual([{ id: 'g-ui', provider: 'google', email: 'Ana@Gmail.com' }])
    expect(store.data.has('google-tokens')).toBe(false)
    expect(store.data.has(`google-tokens.${ID}`)).toBe(false)
    expect(store.data.get('google-tokens.g-ui')).toBe('{"refresh_token":"r-ui"}')
  })

  it('finishes a migration interrupted after registering the account, without registering it twice', async () => {
    const store = memoryStore({ 'google-tokens': LEGACY })
    const accounts = new AccountRegistry(store)
    const realDelete = store.delete
    store.delete = (name) => {
      if (name === 'google-tokens') throw new Error('crash')
      realDelete(name)
    }
    await expect(
      migrateLegacyGoogleTokens({ store, accounts, fetchEmail: async () => 'ana@gmail.com' })
    ).rejects.toThrow('crash')
    store.delete = realDelete
    const fetchEmail = vi.fn(async () => 'ana@gmail.com')

    expect(await migrateLegacyGoogleTokens({ store, accounts, fetchEmail })).toBeNull()

    expect(fetchEmail).not.toHaveBeenCalled()
    expect(store.data.has('google-tokens')).toBe(false)
    expect(store.data.get(`google-tokens.${ID}`)).toBe(LEGACY)
    expect(accounts.list()).toEqual([{ id: ID, provider: 'google', email: 'ana@gmail.com' }])
  })

  it('leaves no orphan token copy after a crash between copying and registering', async () => {
    const store = memoryStore({ 'google-tokens': LEGACY })
    const accounts = new AccountRegistry(store)
    const realSet = store.set
    store.set = (name, value) => {
      if (name === 'accounts') throw new Error('crash')
      realSet(name, value)
    }
    await expect(
      migrateLegacyGoogleTokens({ store, accounts, fetchEmail: async () => 'a@gmail.com' })
    ).rejects.toThrow('crash')
    store.set = realSet

    // The next start is offline: the copy must not stay behind as an unregistered secret.
    await expect(migrateLegacyGoogleTokens({ store, accounts, fetchEmail: offline })).rejects.toThrow('offline')

    expect([...store.data.keys()].filter((name) => name.startsWith('google-tokens.'))).toEqual([])
    expect(store.data.get('google-tokens')).toBe(LEGACY)
    expect(accounts.list()).toEqual([])
  })

  it('sweeps Google token secrets whose account is not registered, keeping registered ones', async () => {
    const store = memoryStore({
      'google-tokens.g1': '{"refresh_token":"r1"}',
      'google-tokens.orphan': '{"refresh_token":"r0"}'
    })
    const accounts = new AccountRegistry(store)
    accounts.add({ id: 'g1', provider: 'google', email: 'ana@gmail.com' })

    expect(await migrateLegacyGoogleTokens({ store, accounts, fetchEmail: offline })).toBeNull()

    expect(store.data.has('google-tokens.orphan')).toBe(false)
    expect(store.data.get('google-tokens.g1')).toBe('{"refresh_token":"r1"}')
  })
})
