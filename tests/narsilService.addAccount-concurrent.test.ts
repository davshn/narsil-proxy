import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OAuth2Client } from 'google-auth-library'
import { AccountRegistry, type SecretStore } from '../src/main/app/accounts'
import type { SecretName, SecureStore } from '../src/main/adapters/secureStore'

const msal = vi.hoisted(() => {
  const account = { homeAccountId: 'home-1', username: 'ana@outlook.com' }
  const cache = {
    getAccountByHomeId: vi.fn(async (id: string) => (id === account.homeAccountId ? account : null)),
    removeAccount: vi.fn(async () => {})
  }
  const acquireTokenInteractive = vi.fn()
  class PublicClientApplication {
    getTokenCache = () => cache
    acquireTokenSilent = vi.fn(async () => ({ accessToken: 'secret-token' }))
    acquireTokenInteractive = acquireTokenInteractive
  }
  class InteractionRequiredAuthError extends Error {}
  return { account, cache, acquireTokenInteractive, PublicClientApplication, InteractionRequiredAuthError }
})

vi.mock('@azure/msal-node', () => ({
  PublicClientApplication: msal.PublicClientApplication,
  InteractionRequiredAuthError: msal.InteractionRequiredAuthError
}))
vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => {}) } }))
vi.mock('../src/main/adapters/claude', () => ({
  ClaudeTriage: class {
    triage = async () => ({ summary: '', recommendedAction: 'archive', reason: '', replies: [] })
  },
  describeClaudeError: String
}))
vi.mock('../src/main/adapters/gmail', () => ({
  fetchProfileEmail: async () => 'ana@gmail.com',
  GmailService: class {
    listUnread = async () => []
    changeToken = async () => '0'
  }
}))
vi.mock('../src/main/adapters/calendar', () => ({
  CalendarService: class {
    upcoming = async () => []
  }
}))

const { GoogleProvider } = await import('../src/main/adapters/google/provider')
const { MicrosoftProvider } = await import('../src/main/adapters/microsoft/provider')
const { NarsilService } = await import('../src/main/app/narsilService')

function memoryStore(initial: Record<string, string>): SecretStore & { data: Map<string, string> } {
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

function makeService(store: SecretStore, google: unknown, microsoft: unknown) {
  const accounts = new AccountRegistry(store)
  const events = {
    inboxChanged: vi.fn(),
    meetingsChanged: vi.fn(),
    reminder: vi.fn(),
    statusChanged: vi.fn(),
    rulesChanged: vi.fn(),
    activityChanged: vi.fn(),
    newEmails: vi.fn()
  }
  const service = new NarsilService({
    store,
    events,
    rules: { load: () => [], save: vi.fn() } as never,
    accounts,
    providers: { google, microsoft } as never
  })
  return { service, accounts }
}

const unconfigured = {
  kind: 'microsoft' as const,
  isConfigured: () => false,
  addAccount: vi.fn(),
  removeAccount: vi.fn(),
  connect: () => null,
  saveClientId: vi.fn(),
  saveClientConfig: vi.fn()
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mail: 'ana@outlook.com', value: [] }), { status: 200 })))
  msal.acquireTokenInteractive.mockReset()
  msal.cache.removeAccount.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NarsilService.addAccount joined by a second click', () => {
  it('keeps the Google account the first click added: both calls fulfil and nothing is revoked', async () => {
    vi.unstubAllGlobals() // the Google sign-in uses the real fetch to reach its loopback server
    const store = memoryStore({ 'google-client': JSON.stringify({ clientId: 'cid', clientSecret: 's' }) })
    const revoked: string[] = []
    let finish!: () => void
    const browserDone = new Promise<void>((resolve) => (finish = resolve))
    const google = new GoogleProvider(store, {
      createClient: ({ clientId, clientSecret }) => {
        const client = new OAuth2Client({ clientId, clientSecret })
        vi.spyOn(client, 'getToken').mockImplementation(async () => ({ tokens: { access_token: 'a', refresh_token: 'r' }, res: null }))
        vi.spyOn(client, 'revokeToken').mockImplementation(async (token: string) => {
          revoked.push(token)
          return {} as never
        })
        return client
      },
      fetchProfileEmail: async () => 'ana@gmail.com',
      newId: () => 'n1',
      openExternal: async (url) => {
        await browserDone
        const auth = new URL(url)
        const redirect = new URL(auth.searchParams.get('redirect_uri') ?? '')
        await fetch(`${redirect.origin}/?state=${auth.searchParams.get('state')}&code=good`)
      }
    })
    const { service, accounts } = makeService(store, google, unconfigured)
    await service.init()

    const first = service.addAccount('google')
    const second = service.addAccount('google') // e.g. the setup screen remounted and re-enabled its button
    finish()
    const results = await Promise.allSettled([first, second])

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(accounts.list()).toEqual([{ id: 'n1', provider: 'google', email: 'ana@gmail.com', settings: { includeCategories: false, windowDays: 2 } }])
    expect(store.data.has('google-tokens.n1')).toBe(true)
    expect(revoked).toEqual([])
  })

  it('keeps the Microsoft account the first click added: the MSAL cache account is never removed', async () => {
    let finish: (value: unknown) => void = () => {}
    msal.acquireTokenInteractive.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const store = memoryStore({ 'microsoft-client': '11111111-2222-3333-4444-555555555555' })
    const microsoft = new MicrosoftProvider(store as unknown as SecureStore)
    const google = { ...unconfigured, kind: 'google' as const }
    const { service, accounts } = makeService(store, google, microsoft)
    await service.init()

    const first = service.addAccount('microsoft')
    const second = service.addAccount('microsoft')
    await vi.waitFor(() => expect(msal.acquireTokenInteractive).toHaveBeenCalledTimes(1))
    finish({ accessToken: 'secret-token', account: msal.account })
    const results = await Promise.allSettled([first, second])

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
    const listed = accounts.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ provider: 'microsoft', email: 'ana@outlook.com' })
    expect(store.data.get(`microsoft-account.${listed[0]?.id}`)).toBe('home-1')
    expect(msal.cache.removeAccount).not.toHaveBeenCalled()
  })
})
