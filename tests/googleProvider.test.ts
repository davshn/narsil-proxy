import { describe, expect, it, vi } from 'vitest'
import { OAuth2Client } from 'google-auth-library'
import { AccountRegistry, LEGACY_GOOGLE_ACCOUNT_ID, migrateLegacyGoogleTokens, type SecretStore } from '../src/main/app/accounts'
import type { SecretName } from '../src/main/adapters/secureStore'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

const { GoogleProvider } = await import('../src/main/adapters/google/provider')

const CLIENT = JSON.stringify({ clientId: 'cid', clientSecret: 'secret' })

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

/** Plays the browser: a forged redirect first, then Google's real redirect to the loopback server. */
async function followRedirect(url: string): Promise<void> {
  const auth = new URL(url)
  const redirect = new URL(auth.searchParams.get('redirect_uri') ?? '')
  const forged = await fetch(`${redirect.origin}/?state=wrong&code=forged`)
  expect(forged.status).toBe(404)
  await fetch(`${redirect.origin}/?state=${auth.searchParams.get('state')}&code=good`)
}

/** A provider whose OAuth clients are real but whose network calls are stubbed. */
function makeProvider(store: SecretStore, overrides: { openExternal?: (url: string) => Promise<void> } = {}) {
  const clients: OAuth2Client[] = []
  const provider = new GoogleProvider(store, {
    createClient: ({ clientId, clientSecret }) => {
      const client = new OAuth2Client({ clientId, clientSecret })
      vi.spyOn(client, 'getToken').mockImplementation(async () => ({
        tokens: { access_token: 'a-new', refresh_token: 'r-new' },
        res: null
      }))
      vi.spyOn(client, 'revokeToken').mockImplementation(async () => ({}) as never)
      clients.push(client)
      return client
    },
    fetchProfileEmail: async () => 'ana@gmail.com',
    newId: () => 'n1',
    openExternal: overrides.openExternal ?? followRedirect
  })
  return { provider, clients }
}

describe('GoogleProvider', () => {
  it('is configured only once a client file is saved, and rejects other JSON files', () => {
    const store = memoryStore()
    const { provider } = makeProvider(store)
    expect(provider.isConfigured()).toBe(false)

    expect(() => provider.saveClientConfig('{"web":{}}')).toThrow('App de escritorio')
    provider.saveClientConfig(JSON.stringify({ installed: { client_id: 'cid', client_secret: 'secret' } }))

    expect(provider.isConfigured()).toBe(true)
    expect(JSON.parse(store.data.get('google-client') ?? '{}')).toEqual({ clientId: 'cid', clientSecret: 'secret' })
  })

  it('adds an account through the loopback sign-in and stores its tokens under its own id', async () => {
    const store = memoryStore({ 'google-client': CLIENT })
    const { provider, clients } = makeProvider(store)

    const added = await provider.addAccount()

    expect(added).toEqual({ accountId: 'n1', email: 'ana@gmail.com' })
    expect(clients[0]?.getToken).toHaveBeenCalledWith(expect.objectContaining({ code: 'good' }))
    expect(JSON.parse(store.data.get('google-tokens.n1') ?? '{}')).toEqual({ access_token: 'a-new', refresh_token: 'r-new' })
  })

  it('joins a sign-in already in progress instead of opening the browser twice', async () => {
    const store = memoryStore({ 'google-client': CLIENT })
    let opened = 0
    const { provider } = makeProvider(store, {
      openExternal: async (url) => {
        opened++
        await followRedirect(url)
      }
    })

    const [first, second] = await Promise.all([provider.addAccount(), provider.addAccount()])

    expect(first).toEqual(second)
    expect(opened).toBe(1)
  })

  it('fails with a clear message when the browser cannot open', async () => {
    const store = memoryStore({ 'google-client': CLIENT })
    const { provider } = makeProvider(store, {
      openExternal: async () => {
        throw new Error('no browser')
      }
    })

    await expect(provider.addAccount()).rejects.toThrow('No se pudo abrir tu navegador: no browser')
    expect(store.data.has('google-tokens.n1')).toBe(false)
  })

  it('refuses to sign in before the client file is loaded', async () => {
    const { provider } = makeProvider(memoryStore())
    await expect(provider.addAccount()).rejects.toThrow('Primero carga tu archivo de cliente OAuth de Google.')
  })

  it('persists refreshed tokens into the secret of the account that refreshed', () => {
    const store = memoryStore({
      'google-client': CLIENT,
      'google-tokens.a1': JSON.stringify({ refresh_token: 'r1', access_token: 'old1' }),
      'google-tokens.a2': JSON.stringify({ refresh_token: 'r2', access_token: 'old2' })
    })
    const { provider, clients } = makeProvider(store)

    expect(provider.connect('a1')).not.toBeNull()
    expect(provider.connect('a2')).not.toBeNull()
    clients[0]?.emit('tokens', { access_token: 'new1' })

    expect(JSON.parse(store.data.get('google-tokens.a1') ?? '{}')).toEqual({ refresh_token: 'r1', access_token: 'new1' })
    expect(JSON.parse(store.data.get('google-tokens.a2') ?? '{}')).toEqual({ refresh_token: 'r2', access_token: 'old2' })
  })

  it('reads the Gmail change token from the profile historyId', async () => {
    const store = memoryStore({
      'google-client': CLIENT,
      'google-tokens.a1': JSON.stringify({ refresh_token: 'r1', access_token: 'a1', expiry_date: Date.now() + 3_600_000 })
    })
    const { provider, clients } = makeProvider(store)
    const connection = provider.connect('a1')
    const request = vi
      .spyOn(clients[0] as OAuth2Client, 'request')
      .mockResolvedValue({ data: { emailAddress: 'ana@gmail.com', historyId: '98765' } } as never)

    expect(await connection?.mail.changeToken()).toBe('98765')
    expect(request).toHaveBeenCalledTimes(1)
    const options = request.mock.calls[0]?.[0] as { url?: string; method?: string }
    expect(options.method).toBe('GET')
    expect(String(options.url)).toMatch(/\/gmail\/v1\/users\/me\/profile$/)
  })

  it('returns no connection for an account without stored tokens', () => {
    const { provider } = makeProvider(memoryStore({ 'google-client': CLIENT }))
    expect(provider.connect('missing')).toBeNull()
  })

  it('revokes and forgets a removed account, and a late refresh cannot write its tokens back', async () => {
    const store = memoryStore({
      'google-client': CLIENT,
      'google-tokens.a1': JSON.stringify({ refresh_token: 'r1', access_token: 'old1' })
    })
    const { provider, clients } = makeProvider(store)
    provider.connect('a1')
    const connected = clients[0]

    await provider.removeAccount('a1')
    connected?.emit('tokens', { access_token: 'late' })

    expect(clients.some((c) => vi.mocked(c.revokeToken).mock.calls.some(([token]) => token === 'r1'))).toBe(true)
    expect(store.data.has('google-tokens.a1')).toBe(false)
    await expect(provider.removeAccount('unknown')).resolves.toBeUndefined()
  })

  it('does not bring back a removed migrated account whose migration crashed before deleting the legacy tokens', async () => {
    const legacy = JSON.stringify({ refresh_token: 'r-old', access_token: 'a-old' })
    const store = memoryStore({ 'google-client': CLIENT, 'google-tokens': legacy })
    const accounts = new AccountRegistry(store)
    const { provider } = makeProvider(store)
    const realDelete = store.delete
    store.delete = (name) => {
      if (name === 'google-tokens') throw new Error('crash')
      realDelete(name)
    }
    const fetchEmail = async () => 'ana@gmail.com'
    await expect(migrateLegacyGoogleTokens({ store, accounts, fetchEmail })).rejects.toThrow('crash')
    store.delete = realDelete

    // The user removes the migrated account in the same session, as the core does.
    provider.connect(LEGACY_GOOGLE_ACCOUNT_ID)
    await provider.removeAccount(LEGACY_GOOGLE_ACCOUNT_ID)
    accounts.remove(LEGACY_GOOGLE_ACCOUNT_ID)

    expect(store.data.has('google-tokens')).toBe(false)
    expect(await migrateLegacyGoogleTokens({ store, accounts, fetchEmail })).toBeNull()
    expect(accounts.list()).toEqual([])
  })

  it('discards a just-added account that was never connected without revoking the shared grant', async () => {
    const store = memoryStore({ 'google-client': CLIENT })
    const { provider, clients } = makeProvider(store)
    const added = await provider.addAccount()

    await provider.removeAccount(added.accountId)

    expect(store.data.has('google-tokens.n1')).toBe(false)
    expect(clients.every((c) => vi.mocked(c.revokeToken).mock.calls.length === 0)).toBe(true)
  })
})
