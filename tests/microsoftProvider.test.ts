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
      scopes: ['Mail.ReadWrite', 'Mail.Send', 'MailboxSettings.ReadWrite', 'Calendars.Read', 'User.Read', 'offline_access']
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

  it('moves to a folder: marks read, then moves to that folder id', async () => {
    await connect().mail.moveToFolder('m1', 'folder/1')
    expect(calls().map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'PATCH', url: `${GRAPH}/me/messages/m1`, body: { isRead: true } },
      { method: 'POST', url: `${GRAPH}/me/messages/m1/move`, body: { destinationId: 'folder/1' } }
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
    expect(await connect().mail.listUnread({ includeCategories: true, windowDays: 2 })).toEqual(['new', 'old'])
    const url = new URL(calls()[0]?.url ?? '')
    expect(url.origin + url.pathname).toBe(`${GRAPH}/me/mailFolders/inbox/messages`)
    expect(url.searchParams.get('$filter')).toBe('isRead eq false and receivedDateTime ge 2026-11-23T12:00:00.000Z')
    expect(url.searchParams.get('$select')).toBe('id,receivedDateTime')
    expect(url.searchParams.get('$top')).toBe('20')
    expect(url.searchParams.has('$orderby')).toBe(false)
  })

  it.each([
    [false, 2, "isRead eq false and receivedDateTime ge 2026-11-23T12:00:00.000Z and inferenceClassification eq 'focused'"],
    [false, 7, "isRead eq false and receivedDateTime ge 2026-11-18T12:00:00.000Z and inferenceClassification eq 'focused'"],
    [false, 30, "isRead eq false and receivedDateTime ge 2026-10-26T12:00:00.000Z and inferenceClassification eq 'focused'"],
    [true, 2, 'isRead eq false and receivedDateTime ge 2026-11-23T12:00:00.000Z'],
    [true, 7, 'isRead eq false and receivedDateTime ge 2026-11-18T12:00:00.000Z'],
    [true, 30, 'isRead eq false and receivedDateTime ge 2026-10-26T12:00:00.000Z']
  ] as const)('filters unread mail with includeCategories=%s over %i days', async (includeCategories, windowDays, filter) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-25T12:00:00Z'))
    fetchMock.mockImplementation(async () => respond(200, { value: [] }))
    await connect().mail.listUnread({ includeCategories, windowDays })
    expect(new URL(calls()[0]?.url ?? '').searchParams.get('$filter')).toBe(filter)
  })

  it('builds the change token from the inbox counts and the newest message id', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('/messages')
        ? respond(200, { value: [{ id: 'newest' }] })
        : respond(200, { unreadItemCount: 3, totalItemCount: 120 })
    )
    expect(await connect().mail.changeToken()).toBe('3:120:newest')
    const urls = calls().map((c) => new URL(c.url))
    expect(calls().every((c) => c.method === 'GET')).toBe(true)
    const folder = urls.find((u) => u.pathname.endsWith('/me/mailFolders/inbox'))
    const messages = urls.find((u) => u.pathname.endsWith('/me/mailFolders/inbox/messages'))
    expect(urls).toHaveLength(2)
    expect(folder?.searchParams.get('$select')).toBe('unreadItemCount,totalItemCount')
    expect(messages?.searchParams.get('$top')).toBe('1')
    expect(messages?.searchParams.get('$select')).toBe('id')
    expect(messages?.searchParams.has('$orderby')).toBe(false)
  })

  it('ends the change token with an empty id when the inbox is empty', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('/messages') ? respond(200, { value: [] }) : respond(200, { unreadItemCount: 0, totalItemCount: 0 })
    )
    expect(await connect().mail.changeToken()).toBe('0:0:')
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

describe('Outlook folders through Microsoft Graph', () => {
  const WELL_KNOWN: Record<string, string> = {
    inbox: 'id-inbox',
    drafts: 'id-drafts',
    sentitems: 'id-sent',
    deleteditems: 'id-deleted',
    junkemail: 'id-junk',
    outbox: 'id-outbox',
    conversationhistory: 'id-history'
  }

  /** Answers like Graph: well-known names resolve to ids; children only for the folders asked. */
  function folderServer(missing: string[] = []): void {
    fetchMock.mockImplementation(async (input) => {
      const path = decodeURIComponent(new URL(String(input)).pathname.replace('/v1.0', ''))
      const wellKnown = /^\/me\/mailFolders\/([a-z]+)$/.exec(path)?.[1]
      if (wellKnown && missing.includes(wellKnown)) return respond(404, { error: { message: 'not found' } })
      if (wellKnown && WELL_KNOWN[wellKnown]) return respond(200, { id: WELL_KNOWN[wellKnown] })
      if (path === '/me/mailFolders') {
        return respond(200, {
          value: [
            { id: 'id-inbox', displayName: 'Bandeja de entrada', childFolderCount: 1 },
            { id: 'id-drafts', displayName: 'Borradores', childFolderCount: 0 },
            { id: 'id-sent', displayName: 'Elementos enviados', childFolderCount: 0 },
            { id: 'id-deleted', displayName: 'Elementos eliminados', childFolderCount: 2 },
            { id: 'id-junk', displayName: 'Correo no deseado', childFolderCount: 0 },
            { id: 'id-outbox', displayName: 'Bandeja de salida', childFolderCount: 0 },
            { id: 'id-history', displayName: 'Historial de conversaciones', childFolderCount: 0 },
            { id: 'id-archive', displayName: 'Archivo', childFolderCount: 0 },
            { id: 'id-work', displayName: 'Trabajo', childFolderCount: 2 }
          ]
        })
      }
      if (path === '/me/mailFolders/id-work/childFolders') {
        return respond(200, {
          value: [
            { id: 'id-clients', displayName: 'Clientes', childFolderCount: 0 },
            { id: 'id-bills', displayName: 'Facturas', childFolderCount: 0 }
          ]
        })
      }
      if (path === '/me/mailFolders/id-inbox/childFolders') {
        return respond(200, { value: [{ id: 'id-news', displayName: 'Boletines', childFolderCount: 0 }] })
      }
      return respond(404, { error: { message: `unexpected ${path}` } })
    })
  }

  it('lists folders without the well-known ones, with one level of children as Parent/Child, sorted', async () => {
    folderServer()

    const folders = await connect().mail.listFolders()

    expect(folders).toEqual([
      { id: 'id-archive', name: 'Archivo' },
      { id: 'id-news', name: 'Bandeja de entrada/Boletines' },
      { id: 'id-work', name: 'Trabajo' },
      { id: 'id-clients', name: 'Trabajo/Clientes' },
      { id: 'id-bills', name: 'Trabajo/Facturas' }
    ])
    const top = calls()
      .map((c) => new URL(c.url))
      .find((u) => u.pathname === '/v1.0/me/mailFolders')
    expect(top?.searchParams.get('$top')).toBe('100')
    expect(calls().some((c) => c.url.includes('id-deleted/childFolders'))).toBe(false)
    expect(calls().every((c) => c.method === 'GET')).toBe(true)
  })

  it('still lists folders when a well-known folder does not exist in the mailbox', async () => {
    folderServer(['conversationhistory'])

    const ids = (await connect().mail.listFolders()).map((f) => f.id)

    expect(ids).toContain('id-history')
    expect(ids).not.toContain('id-inbox')
  })

  it('creates a top-level folder', async () => {
    fetchMock.mockImplementation(async () => respond(201, { id: 'id-new', displayName: 'Facturas' }))
    expect(await connect().mail.createFolder('Facturas')).toEqual({ id: 'id-new', name: 'Facturas' })
    expect(calls().map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'POST', url: `${GRAPH}/me/mailFolders`, body: { displayName: 'Facturas' } }
    ])
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

describe('Microsoft scopes', () => {
  it('keeps mail on the mail scopes, so an account without the rule permission still polls', async () => {
    fetchMock.mockImplementation(async () => respond(200, { value: [] }))
    msal.acquireTokenSilent.mockClear()

    await connect().mail.listUnread({ includeCategories: false, windowDays: 2 })

    expect(msal.acquireTokenSilent).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ['Mail.ReadWrite', 'Mail.Send', 'Calendars.Read', 'User.Read', 'offline_access'] })
    )
  })
})

describe('Outlook inbox rules through Microsoft Graph', () => {
  const RULES = `${GRAPH}/me/mailFolders/inbox/messageRules`
  const when = { from: 'shop.example', subject: '', body: '' }

  /** Graph with an Archive folder, existing rules and one named folder. */
  function ruleServer(rules: unknown[] = [{ id: 'r1', sequence: 3 }, { id: 'r2', sequence: 1 }]): void {
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      const path = decodeURIComponent(url.pathname.replace('/v1.0', ''))
      const method = init?.method ?? 'GET'
      if (path === '/me/mailFolders/archive') return respond(200, { id: 'id-archive' })
      if (path === '/me/mailFolders/id-work') return respond(200, { id: 'id-work', displayName: 'Trabajo' })
      if (path === '/me/mailFolders/inbox/messageRules' && method === 'GET') return respond(200, { value: rules })
      if (path === '/me/mailFolders/inbox/messageRules' && method === 'POST') return respond(201, { id: 'r-new' })
      if (path.startsWith('/me/mailFolders/inbox/messageRules/') && method === 'DELETE') return respond(204)
      return respond(404, { error: { code: 'ErrorItemNotFound', message: `unexpected ${method} ${path}` } })
    })
  }

  const posted = (): unknown => calls().find((c) => c.method === 'POST')?.body

  it('creates an archive rule that moves to the Archive folder looked up by its well-known name', async () => {
    ruleServer()

    const created = await connect().rules.create({ name: 'Tienda', conditions: when, action: 'archive' })

    expect(calls().some((c) => c.url === `${GRAPH}/me/mailFolders/archive?$select=id`)).toBe(true)
    expect(posted()).toEqual({
      displayName: 'Tienda',
      sequence: 4,
      isEnabled: true,
      conditions: { senderContains: ['shop.example'] },
      actions: { moveToFolder: 'id-archive', stopProcessingRules: false }
    })
    expect(created).toEqual({
      id: 'r-new',
      accountId: 'acc-1',
      name: 'Tienda',
      conditions: when,
      action: 'archive',
      managedByNarsil: true
    })
  })

  it('creates move and delete rules with every filled condition', async () => {
    ruleServer([])
    const conditions = { from: 'a.example', subject: 'factura', body: 'pago' }

    await connect().rules.create({ name: 'Mover', conditions, action: 'move', folderId: 'id-work', folderName: 'Trabajo' })
    expect(posted()).toEqual({
      displayName: 'Mover',
      sequence: 1,
      isEnabled: true,
      conditions: { senderContains: ['a.example'], subjectContains: ['factura'], bodyContains: ['pago'] },
      actions: { moveToFolder: 'id-work', stopProcessingRules: false }
    })
    expect(calls().some((c) => c.url.includes('/mailFolders/archive'))).toBe(false)

    fetchMock.mockClear()
    await connect().rules.create({ name: 'Borrar', conditions: { from: '', subject: 'promo', body: '' }, action: 'delete' })
    expect(posted()).toMatchObject({ conditions: { subjectContains: ['promo'] }, actions: { delete: true, stopProcessingRules: false } })
    expect(Object.keys(posted() as object)).not.toContain('stopProcessingRules')
  })

  it('removes a rule by id', async () => {
    ruleServer()
    await connect().rules.remove('r/1')
    expect(calls().map(({ method, url }) => ({ method, url }))).toEqual([{ method: 'DELETE', url: `${RULES}/r%2F1` }])
  })

  it('lists rules, telling archive from move and naming the move folder', async () => {
    ruleServer([
      { id: 'r1', displayName: 'Archivar tienda', conditions: { senderContains: ['shop.example'] }, actions: { moveToFolder: 'id-archive' } },
      {
        id: 'r2',
        displayName: 'Trabajo',
        conditions: { subjectContains: ['informe'] },
        actions: { moveToFolder: 'id-work', stopProcessingRules: false }
      },
      { id: 'r3', displayName: 'Promos', conditions: { bodyContains: ['baja'] }, actions: { delete: true } }
    ])

    expect(await connect().rules.list()).toEqual([
      { id: 'r1', accountId: 'acc-1', name: 'Archivar tienda', conditions: when, action: 'archive', managedByNarsil: true },
      {
        id: 'r2',
        accountId: 'acc-1',
        name: 'Trabajo',
        conditions: { from: '', subject: 'informe', body: '' },
        action: 'move',
        folderId: 'id-work',
        folderName: 'Trabajo',
        managedByNarsil: true
      },
      {
        id: 'r3',
        accountId: 'acc-1',
        name: 'Promos',
        conditions: { from: '', subject: '', body: 'baja' },
        action: 'delete',
        managedByNarsil: true
      }
    ])
  })

  it('reads a rule turned off in Outlook as disabled and writes a disabled rule back turned off', async () => {
    ruleServer([
      { id: 'r1', displayName: 'Apagada', isEnabled: false, conditions: { senderContains: ['shop.example'] }, actions: { delete: true } },
      { id: 'r2', displayName: 'Encendida', isEnabled: true, conditions: { senderContains: ['shop.example'] }, actions: { delete: true } }
    ])

    const listed = await connect().rules.list()

    expect(listed[0]).toMatchObject({ id: 'r1', enabled: false, managedByNarsil: true })
    expect(listed[1]).not.toHaveProperty('enabled')

    fetchMock.mockClear()
    const created = await connect().rules.create({ name: 'Apagada', conditions: when, action: 'delete', enabled: false })
    expect(posted()).toMatchObject({ isEnabled: false })
    expect(created).toMatchObject({ enabled: false })
  })

  it('shows rules Narsil cannot map as read-only', async () => {
    ruleServer([
      {
        id: 'u1',
        displayName: 'De jefe',
        conditions: { fromAddresses: [{ emailAddress: { address: 'jefe@example.com' } }] },
        actions: { moveToFolder: 'id-work' }
      },
      { id: 'u2', displayName: 'Leer', conditions: { senderContains: ['a.example'] }, actions: { markAsRead: true } },
      { id: 'u3', displayName: 'Dos remitentes', conditions: { senderContains: ['a.example', 'b.example'] }, actions: { delete: true } },
      {
        id: 'u4',
        displayName: 'Con excepción',
        conditions: { senderContains: ['a.example'] },
        exceptions: { subjectContains: ['x'] },
        actions: { delete: true }
      }
    ])

    const listed = await connect().rules.list()

    expect(listed.map((r) => [r.id, r.managedByNarsil])).toEqual([
      ['u1', false],
      ['u2', false],
      ['u3', false],
      ['u4', false]
    ])
    expect(listed[0]).toMatchObject({ name: 'De jefe', action: 'move', folderName: 'Trabajo' })
  })

  it('turns a 403 ErrorAccessDenied on the rules into ReconnectRequiredError', async () => {
    const { ReconnectRequiredError } = await import('../src/main/app/ports')
    fetchMock.mockImplementation(async () => respond(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }))
    await expect(connect().rules.list()).rejects.toBeInstanceOf(ReconnectRequiredError)
  })

  it('asks for the rule scope silently and needs a reconnect when Microsoft wants consent', async () => {
    const { ReconnectRequiredError } = await import('../src/main/app/ports')
    msal.acquireTokenSilent.mockImplementationOnce(async () => {
      throw new msal.InteractionRequiredAuthError('consent_required')
    })

    await expect(connect().rules.list()).rejects.toBeInstanceOf(ReconnectRequiredError)
    expect(msal.acquireTokenSilent).toHaveBeenLastCalledWith(
      expect.objectContaining({ scopes: expect.arrayContaining(['MailboxSettings.ReadWrite']) })
    )
  })
})

describe('MicrosoftProvider reconnect', () => {
  it('signs in again as the same account with the rule scope, keeping the account id', async () => {
    msal.acquireTokenInteractive.mockResolvedValue({ accessToken: 'secret-token', account: msal.account })
    fetchMock.mockImplementation(async () => respond(200, { mail: 'ana@outlook.com' }))
    const store = connectedStore()

    await new MicrosoftProvider(store).reconnect('acc-1', 'Ana@outlook.com')

    expect(msal.acquireTokenInteractive).toHaveBeenCalledTimes(1)
    expect(msal.acquireTokenInteractive.mock.calls[0]?.[0]).toMatchObject({
      account: msal.account,
      scopes: expect.arrayContaining(['MailboxSettings.ReadWrite', 'Mail.ReadWrite'])
    })
    expect(store.list('microsoft-account.')).toEqual(['microsoft-account.acc-1'])
    expect(store.get('microsoft-account.acc-1')).toBe('home-1')
    expect(msal.cache.removeAccount).not.toHaveBeenCalled()
  })

  it('rejects another mailbox in Spanish, keeps the old mapping and drops the new cache account', async () => {
    const other = { homeAccountId: 'home-2', username: 'otro@outlook.com' }
    msal.acquireTokenInteractive.mockResolvedValue({ accessToken: 'secret-token', account: other })
    fetchMock.mockImplementation(async () => respond(200, { mail: 'otro@outlook.com' }))
    const store = connectedStore()

    await expect(new MicrosoftProvider(store).reconnect('acc-1', 'ana@outlook.com')).rejects.toThrow(
      'Iniciaste sesión con otro@outlook.com, pero esta cuenta es ana@outlook.com. Vuelve a intentarlo con ana@outlook.com.'
    )
    expect(store.get('microsoft-account.acc-1')).toBe('home-1')
    expect(store.list('microsoft-account.')).toEqual(['microsoft-account.acc-1'])
    expect(msal.cache.removeAccount).toHaveBeenCalledWith(other)
  })

  it('never maps back or keeps in the cache an account removed while its sign-in ran', async () => {
    let finish!: (value: unknown) => void
    msal.acquireTokenInteractive.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    fetchMock.mockImplementation(async () => respond(200, { mail: 'ana@outlook.com' }))
    const store = connectedStore()
    const provider = new MicrosoftProvider(store)
    const pending = provider.reconnect('acc-1', 'ana@outlook.com')
    await vi.waitFor(() => expect(msal.acquireTokenInteractive).toHaveBeenCalled())
    await provider.removeAccount('acc-1')
    msal.cache.removeAccount.mockClear()

    // MSAL writes the signed-in account back to its cache before the sign-in resolves.
    finish({ accessToken: 'secret-token', account: msal.account })

    await expect(pending).rejects.toThrow('Esta cuenta ya no está conectada.')
    expect(store.list('microsoft-account.')).toEqual([])
    expect(msal.cache.removeAccount).toHaveBeenCalledWith(msal.account)
    expect(provider.connect('acc-1')).toBeNull()
  })

  it('refuses to reconnect an unknown account', async () => {
    await expect(new MicrosoftProvider(connectedStore()).reconnect('missing', 'a@b.c')).rejects.toThrow(
      'Esta cuenta ya no está conectada.'
    )
    expect(msal.acquireTokenInteractive).not.toHaveBeenCalled()
  })
})
