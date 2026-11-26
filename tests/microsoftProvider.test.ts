import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SecureStore } from '../src/main/adapters/secureStore'
import type { ParsedEmail } from '../src/main/domain/email'

const msal = vi.hoisted(() => {
  const account = { homeAccountId: 'home-1', username: 'ana@outlook.com' }
  const cache = {
    getAccountByHomeId: vi.fn(async (id: string) => (id === account.homeAccountId ? account : null)),
    removeAccount: vi.fn(async () => {})
  }
  const acquireTokenSilent = vi.fn(async () => ({ accessToken: 'secret-token' }))
  const acquireTokenInteractive = vi.fn()
  const configs: unknown[] = []
  class PublicClientApplication {
    constructor(config: unknown) {
      configs.push(config)
    }
    getTokenCache = () => cache
    acquireTokenSilent = acquireTokenSilent
    acquireTokenInteractive = acquireTokenInteractive
  }
  class InteractionRequiredAuthError extends Error {}
  return { account, cache, acquireTokenSilent, acquireTokenInteractive, configs, PublicClientApplication, InteractionRequiredAuthError }
})

vi.mock('@azure/msal-node', () => ({
  PublicClientApplication: msal.PublicClientApplication,
  InteractionRequiredAuthError: msal.InteractionRequiredAuthError
}))
vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => {}) } }))

const { MicrosoftProvider } = await import('../src/main/adapters/microsoft/provider')

const CLIENT_ID = '11111111-2222-3333-4444-555555555555'
const GRAPH = 'https://graph.microsoft.com/v1.0'

function fakeStore(initial: Record<string, string> = {}): SecureStore {
  const data = new Map(Object.entries(initial))
  return {
    get: (name: string) => data.get(name) ?? null,
    getStrict: (name: string) => data.get(name) ?? null,
    set: (name: string, value: string) => void data.set(name, value),
    delete: (name: string) => void data.delete(name),
    has: (name: string) => data.has(name),
    list: (prefix: string) => [...data.keys()].filter((name) => name.startsWith(prefix))
  } as unknown as SecureStore
}

function connectedStore(): SecureStore {
  return fakeStore({ 'microsoft-client': CLIENT_ID, 'microsoft-account.acc-1': 'home-1' })
}

const fetchMock = vi.fn<typeof fetch>()

function respond(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function calls(): Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> {
  return fetchMock.mock.calls.map(([url, init]) => ({
    method: init?.method ?? 'GET',
    url: String(url),
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    headers: (init?.headers ?? {}) as Record<string, string>
  }))
}

function connect() {
  const connection = new MicrosoftProvider(connectedStore()).connect('acc-1')
  if (!connection) throw new Error('expected a connection')
  return connection
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => respond(200, {}))
  vi.stubGlobal('fetch', fetchMock)
  msal.acquireTokenInteractive.mockReset()
  msal.cache.removeAccount.mockClear()
  msal.configs.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('MicrosoftProvider configuration', () => {
  it('rejects a client id that is not a GUID with the exact Spanish message', () => {
    const provider = new MicrosoftProvider(fakeStore())
    expect(() => provider.saveClientId('not-a-guid')).toThrow(
      new Error('El Application (client) ID de Microsoft debe ser un GUID.')
    )
    expect(provider.isConfigured()).toBe(false)
  })

  it('stores a trimmed GUID and reports it configured', () => {
    const store = fakeStore()
    const provider = new MicrosoftProvider(store)
    provider.saveClientId(`  ${CLIENT_ID}\n`)
    expect(store.get('microsoft-client')).toBe(CLIENT_ID)
    expect(provider.isConfigured()).toBe(true)
    expect(provider.kind).toBe('microsoft')
  })

  it('uses the common authority', () => {
    new MicrosoftProvider(connectedStore()).connect('acc-1')
    expect(msal.configs[0]).toMatchObject({
      auth: { clientId: CLIENT_ID, authority: 'https://login.microsoftonline.com/common' }
    })
  })

  it('returns no connection for an unknown account', () => {
    expect(new MicrosoftProvider(connectedStore()).connect('missing')).toBeNull()
  })
})

describe('MicrosoftProvider accounts', () => {
  it('joins a sign-in already in progress and maps the new account', async () => {
    let finish: (value: unknown) => void = () => {}
    msal.acquireTokenInteractive.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    fetchMock.mockImplementation(async () => respond(200, { mail: 'ana@contoso.com' }))
    const store = fakeStore({ 'microsoft-client': CLIENT_ID })
    const provider = new MicrosoftProvider(store)

    const first = provider.addAccount()
    const second = provider.addAccount()
    await vi.waitFor(() => expect(msal.acquireTokenInteractive).toHaveBeenCalledTimes(1))
    finish({ accessToken: 'secret-token', account: msal.account })

    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(a.email).toBe('ana@contoso.com')
    expect(store.get(`microsoft-account.${a.accountId}`)).toBe('home-1')
    expect(msal.acquireTokenInteractive).toHaveBeenCalledTimes(1)
    expect(msal.acquireTokenInteractive.mock.calls[0]?.[0]).toMatchObject({
      scopes: ['Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'User.Read', 'offline_access']
    })
  })

  it('removes the account from the MSAL cache and deletes its mapping', async () => {
    const store = connectedStore()
    await new MicrosoftProvider(store).removeAccount('acc-1')
    expect(msal.cache.removeAccount).toHaveBeenCalledWith(msal.account)
    expect(store.has('microsoft-account.acc-1')).toBe(false)
  })

  it('discards a just-added duplicate without removing its MSAL cache account', async () => {
    // A different MSAL account with the same address: the core rejects it by email.
    const other = { homeAccountId: 'home-2', username: 'ana@contoso.com' }
    msal.acquireTokenInteractive.mockResolvedValue({ accessToken: 'secret-token', account: other })
    fetchMock.mockImplementation(async () => respond(200, { mail: 'ana@contoso.com' }))
    const store = connectedStore()
    const provider = new MicrosoftProvider(store)

    // The core rejects this sign-in as a duplicate of acc-1 and discards it before connecting.
    const added = await provider.addAccount()
    await provider.removeAccount(added.accountId)

    expect(msal.cache.removeAccount).not.toHaveBeenCalled()
    expect(store.has(`microsoft-account.${added.accountId}`)).toBe(false)
    expect(provider.connect('acc-1')).not.toBeNull()
  })

  it('returns the existing account id when the same Microsoft account signs in again', async () => {
    msal.acquireTokenInteractive.mockResolvedValue({ accessToken: 'secret-token', account: msal.account })
    // The first /me answers with the work address, the second fails: the emails differ.
    fetchMock
      .mockResolvedValueOnce(respond(200, { mail: 'ana.perez@contoso.com' }))
      .mockResolvedValueOnce(respond(503, {}))
    const store = fakeStore({ 'microsoft-client': CLIENT_ID })
    const provider = new MicrosoftProvider(store)

    const a = await provider.addAccount()
    provider.connect(a.accountId)
    const b = await provider.addAccount()

    expect(b).toEqual({ accountId: a.accountId, email: 'ana@outlook.com' })
    expect(store.list('microsoft-account.')).toEqual([`microsoft-account.${a.accountId}`])
    expect(msal.cache.removeAccount).not.toHaveBeenCalled()
  })

  it('keeps the MSAL cache account while another mapping still uses it', async () => {
    const store = fakeStore({
      'microsoft-client': CLIENT_ID,
      'microsoft-account.acc-1': 'home-1',
      'microsoft-account.acc-2': 'home-1'
    })
    const provider = new MicrosoftProvider(store)

    await provider.removeAccount('acc-1')

    expect(msal.cache.removeAccount).not.toHaveBeenCalled()
    expect(store.has('microsoft-account.acc-1')).toBe(false)
    expect(provider.connect('acc-2')).not.toBeNull()
  })

  it('removes a sign-in that finishes after the timeout from the MSAL cache', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let finish: (value: unknown) => void = () => {}
    msal.acquireTokenInteractive.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const store = fakeStore({ 'microsoft-client': CLIENT_ID })
    const provider = new MicrosoftProvider(store)

    const failure = expect(provider.addAccount()).rejects.toThrow(
      'Falló el inicio de sesión en Microsoft: Se agotó el tiempo para iniciar sesión en Microsoft.'
    )
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await failure

    const late = { homeAccountId: 'home-late', username: 'tarde@outlook.com' }
    finish({ accessToken: 'late-token', account: late })
    await vi.waitFor(() => expect(msal.cache.removeAccount).toHaveBeenCalledWith(late))
    expect(store.list('microsoft-account.')).toEqual([])
  })

  it('keeps a late sign-in in the MSAL cache when a Narsil account already maps to it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let finish: (value: unknown) => void = () => {}
    msal.acquireTokenInteractive.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const provider = new MicrosoftProvider(connectedStore())

    const failure = expect(provider.addAccount()).rejects.toThrow('Se agotó el tiempo')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await failure

    finish({ accessToken: 'late-token', account: msal.account })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(msal.cache.removeAccount).not.toHaveBeenCalled()
  })

  it('never throws for an unknown account', async () => {
    await expect(new MicrosoftProvider(connectedStore()).removeAccount('missing')).resolves.toBeUndefined()
    expect(msal.cache.removeAccount).not.toHaveBeenCalled()
  })
})

describe('Outlook mail through Microsoft Graph', () => {
  it('archives: marks read, then moves to the Archive folder', async () => {
    await connect().mail.archive('id/with+chars')
    expect(calls().map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'PATCH', url: `${GRAPH}/me/messages/id%2Fwith%2Bchars`, body: { isRead: true } },
      { method: 'POST', url: `${GRAPH}/me/messages/id%2Fwith%2Bchars/move`, body: { destinationId: 'archive' } }
    ])
    expect(calls()[0]?.headers.Authorization).toBe('Bearer secret-token')
  })

  it('trashes by moving to Deleted Items and never sends DELETE', async () => {
    await connect().mail.trash('m1')
    expect(calls().map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'POST', url: `${GRAPH}/me/messages/m1/move`, body: { destinationId: 'deleteditems' } }
    ])
    expect(calls().some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('saves by flagging and marking read', async () => {
    await connect().mail.save('m1')
    expect(calls().map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'PATCH', url: `${GRAPH}/me/messages/m1`, body: { isRead: true, flag: { flagStatus: 'flagged' } } }
    ])
  })

  it('replies in the same conversation, then marks the message read', async () => {
    fetchMock.mockImplementation(async (_url, init) => respond(init?.method === 'POST' ? 202 : 200))
    const email = { summary: { id: 'm1' } } as ParsedEmail
    await connect().mail.reply(email, 'Gracias, lo reviso.')
    expect(calls().map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'POST', url: `${GRAPH}/me/messages/m1/reply`, body: { comment: 'Gracias, lo reviso.' } },
      { method: 'PATCH', url: `${GRAPH}/me/messages/m1`, body: { isRead: true } }
    ])
  })

  it('sends the reply text as escaped HTML with line breaks, since Graph reads the comment as HTML', async () => {
    fetchMock.mockImplementation(async (_url, init) => respond(init?.method === 'POST' ? 202 : 200))
    const email = { summary: { id: 'm1' } } as ParsedEmail
    await connect().mail.reply(email, 'Si a < b & "c" > d,\nte aviso.\r\nSaludos')
    expect(calls()[0]?.body).toEqual({
      comment: 'Si a &lt; b &amp; &quot;c&quot; &gt; d,<br>te aviso.<br>Saludos'
    })
  })

  it('rejects a non-2xx response with the status and the Graph message, never the token', async () => {
    fetchMock.mockImplementation(async () => respond(404, { error: { code: 'ErrorItemNotFound', message: 'The item was not found.' } }))
    const failure = connect().mail.trash('m1')
    await expect(failure).rejects.toThrow(/404/)
    await expect(failure).rejects.toThrow(/The item was not found\./)
    await expect(failure).rejects.not.toThrow(/secret-token/)
  })

  it('lists unread inbox ids from the last two days, newest first, without $orderby', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'))
    fetchMock.mockImplementation(async () =>
      respond(200, {
        value: [
          { id: 'old', receivedDateTime: '2026-11-24T08:00:00Z' },
          { id: 'new', receivedDateTime: '2026-11-25T11:00:00Z' }
        ]
      })
    )
    expect(await connect().mail.listUnread()).toEqual(['new', 'old'])
    const url = new URL(calls()[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe(`${GRAPH}/me/mailFolders/inbox/messages`)
    expect(url.searchParams.get('$filter')).toBe('isRead eq false and receivedDateTime ge 2026-11-23T12:00:00.000Z')
    expect(url.searchParams.get('$select')).toBe('id,receivedDateTime')
    expect(url.searchParams.get('$top')).toBe('20')
    expect(url.searchParams.has('$orderby')).toBe(false)
  })

  it('gets a message as text and tags it with the account', async () => {
    fetchMock.mockImplementation(async () => respond(200, { id: 'm1', subject: 'Hola', body: { contentType: 'text', content: 'Cuerpo' } }))
    const email = await connect().mail.getMessage('m1')
    expect(email.summary.accountId).toBe('acc-1')
    expect(email.bodyText).toBe('Cuerpo')
    const [call] = calls()
    expect(call?.headers.Prefer).toBe('outlook.body-content-type="text"')
    expect(new URL(call?.url ?? '').searchParams.get('$select')).toBe(
      'id,conversationId,subject,from,replyTo,bodyPreview,body,receivedDateTime,internetMessageId'
    )
  })
})

describe('Outlook calendar through Microsoft Graph', () => {
  it('reads the next 24 hours in UTC and returns meetings sorted by start', async () => {
    fetchMock.mockImplementation(async () =>
      respond(200, {
        value: [
          { id: 'late', subject: 'B', start: { dateTime: '2026-11-25T18:00:00.0000000' }, end: { dateTime: '2026-11-25T19:00:00.0000000' } },
          { id: 'allday', subject: 'X', isAllDay: true, start: { dateTime: '2026-11-25T00:00:00.0000000' }, end: { dateTime: '2026-11-26T00:00:00.0000000' } },
          { id: 'early', subject: 'A', start: { dateTime: '2026-11-25T13:00:00.0000000' }, end: { dateTime: '2026-11-25T13:30:00.0000000' } }
        ]
      })
    )
    const meetings = await connect().calendar.upcoming(new Date('2026-11-25T12:00:00Z'))
    expect(meetings.map((m) => m.id)).toEqual(['acc-1:early', 'acc-1:late'])
    const [call] = calls()
    const url = new URL(call?.url ?? '')
    expect(url.origin + url.pathname).toBe(`${GRAPH}/me/calendarView`)
    expect(url.searchParams.get('startDateTime')).toBe('2026-11-25T12:00:00.000Z')
    expect(url.searchParams.get('endDateTime')).toBe('2026-11-26T12:00:00.000Z')
    expect(url.searchParams.get('$top')).toBe('50')
    expect(call?.headers.Prefer).toBe('outlook.timezone="UTC"')
  })
})
