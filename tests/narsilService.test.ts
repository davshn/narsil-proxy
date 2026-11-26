import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarsilService, type NarsilEvents } from '../src/main/app/narsilService'
import { AccountRegistry, type SecretStore } from '../src/main/app/accounts'
import { parseMessage, type ParsedEmail } from '../src/main/domain/email'
import type { AccountConnection, AddedAccount, ProviderAuth } from '../src/main/app/ports'
import type { SecretName } from '../src/main/adapters/secureStore'
import type { Account, AccountSettings, MailFolder, Meeting, ProviderKind, Rule, Triage } from '@shared/types'

const fake = vi.hoisted(() => ({ triage: vi.fn<() => Promise<Triage>>() }))

vi.mock('../src/main/adapters/claude', () => ({
  ClaudeTriage: class {
    triage = () => fake.triage()
  },
  describeClaudeError: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))

/**
 * A distinct real instant: strictly after every earlier clock read and strictly before every
 * later one, so an email "arrives" unambiguously before or after the service's first load.
 */
function arrivalTime(): number {
  const before = Date.now()
  while (Date.now() === before) {
    /* wait for the clock to move */
  }
  const at = Date.now()
  while (Date.now() === at) {
    /* wait for the clock to move */
  }
  return at
}

/** One fake mailbox and calendar behind a connected account. */
function makeMailbox() {
  let ids: string[] = []
  const box = {
    /** The unread ids listUnread() returns. Assigning stamps each id not seen before as arriving now. */
    get ids(): string[] {
      return ids
    },
    set ids(next: string[]) {
      for (const id of next) box.received[id] ??= arrivalTime()
      ids = next
    },
    /** When each email arrived (epoch ms); set it before assigning `ids` to backdate an email. */
    received: {} as Record<string, number>,
    bodies: {} as Record<string, string>,
    senders: {} as Record<string, string>,
    meetings: [] as Meeting[],
    listError: null as Error | null,
    /** Ids whose getMessage() fails. */
    badIds: new Set<string>(),
    /** What changeToken() returns; a test changes it when new mail "arrives". */
    token: 't0',
    tokenError: null as Error | null,
    /** When set, listUnread() and changeToken() wait on these before answering. */
    listGate: null as Promise<void> | null,
    tokenGate: null as Promise<void> | null,
    /** How many times listUnread() and changeToken() ran. */
    listed: 0,
    tokenCalls: 0,
    archive: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    trash: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    moveToFolder: vi.fn<(id: string, folderId: string) => Promise<void>>(async () => undefined),
    folders: [{ id: 'Label_1', name: 'Facturas' }] as MailFolder[],
    createFolder: vi.fn<(name: string) => Promise<MailFolder>>(async (name) => ({ id: `new-${name}`, name })),
    /** The settings each listUnread() call received. */
    settingsSeen: [] as AccountSettings[],
    reply: vi.fn<(email: ParsedEmail, body: string) => Promise<void>>(async () => undefined)
  }
  return box
}
type Mailbox = ReturnType<typeof makeMailbox>

class FakeProvider implements ProviderAuth {
  readonly boxes = new Map<string, Mailbox>()
  configured = true
  nextAccount: AddedAccount = { accountId: 'new', email: 'new@example.com' }
  readonly addAccount = vi.fn(async () => this.nextAccount)
  readonly removeAccount = vi.fn(async (_id: string) => undefined)
  readonly saveClientConfig = vi.fn<(json: string) => void>()
  readonly saveClientId = vi.fn<(id: string) => void>()

  constructor(readonly kind: ProviderKind) {}

  isConfigured(): boolean {
    return this.configured
  }

  box(accountId: string): Mailbox {
    let box = this.boxes.get(accountId)
    if (!box) {
      box = makeMailbox()
      this.boxes.set(accountId, box)
    }
    return box
  }

  /** Accounts whose stored credentials are unreadable: connect() throws for them. */
  readonly corrupt = new Set<string>()

  connect(accountId: string): AccountConnection | null {
    if (this.corrupt.has(accountId)) throw new SyntaxError('Unexpected token in JSON')
    const box = this.boxes.get(accountId)
    if (!box) return null
    return {
      mail: {
        listUnread: async (settings) => {
          box.listed++
          box.settingsSeen.push(settings)
          const snapshot = [...box.ids]
          if (box.listGate) await box.listGate
          if (box.listError) throw box.listError
          return snapshot
        },
        changeToken: async () => {
          box.tokenCalls++
          const token = box.token
          if (box.tokenGate) await box.tokenGate
          if (box.tokenError) throw box.tokenError
          return token
        },
        getMessage: async (id) => {
          if (box.badIds.has(id)) throw new Error('unreadable')
          return parseMessage(
            {
              id,
              threadId: `t-${id}`,
              snippet: '',
              internalDate: String(box.received[id] ?? Date.now()),
              payload: {
                mimeType: 'text/html',
                headers: [
                  { name: 'From', value: box.senders[id] ?? 'x@example.com' },
                  { name: 'Subject', value: `Asunto ${id}` }
                ],
                body: { data: Buffer.from(box.bodies[id] ?? '<p>hi</p>').toString('base64url') }
              }
            },
            accountId
          )
        },
        archive: (id) => box.archive(id),
        trash: (id) => box.trash(id),
        moveToFolder: (id, folderId) => box.moveToFolder(id, folderId),
        listFolders: async () => box.folders,
        createFolder: (name) => box.createFolder(name),
        reply: (email, body) => box.reply(email, body)
      },
      calendar: { upcoming: async () => box.meetings }
    }
  }
}

const TRIAGE: Triage = { summary: 's', recommendedAction: 'archive', reason: 'r', replies: [] }
const DEFAULTS: AccountSettings = { includeCategories: false, windowDays: 2 }
const ANA: Account = { id: 'g1', provider: 'google', email: 'ana@gmail.com', settings: DEFAULTS }
const BETO: Account = { id: 'g2', provider: 'google', email: 'beto@gmail.com', settings: DEFAULTS }

function memoryStore(initial: Record<string, string> = {}): SecretStore {
  const data = new Map<string, string>([['anthropic-key', 'test-key'], ...Object.entries(initial)])
  return {
    get: (name) => data.get(name) ?? null,
    getStrict: (name) => data.get(name) ?? null,
    set: (name, value) => void data.set(name, value),
    delete: (name) => void data.delete(name),
    has: (name) => data.has(name),
    list: (prefix) => [...data.keys()].filter((name) => name.startsWith(prefix)) as SecretName[]
  }
}

function makeRepo(rules: Rule[] = []) {
  return { load: vi.fn(() => rules), save: vi.fn<(rules: Rule[]) => void>() }
}

interface Setup {
  service: NarsilService
  google: FakeProvider
  microsoft: FakeProvider
  registry: AccountRegistry
  events: { [K in keyof NarsilEvents]: ReturnType<typeof vi.fn> }
}

interface ServiceOptions {
  accounts?: Account[]
  repo?: ReturnType<typeof makeRepo>
  migrate?: () => Promise<void>
  secrets?: Record<string, string>
  /** Runs before init(), e.g. to break a provider. */
  prepare?: (setup: Omit<Setup, 'service'>) => void
  /** Leaves init() to the test. */
  skipInit?: boolean
}

async function makeService(options: ServiceOptions = {}): Promise<Setup> {
  const store = memoryStore(options.secrets)
  const registry = new AccountRegistry(store)
  const google = new FakeProvider('google')
  const microsoft = new FakeProvider('microsoft')
  for (const account of options.accounts ?? [ANA]) {
    registry.add(account)
    ;(account.provider === 'google' ? google : microsoft).box(account.id)
  }
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
    rules: options.repo ?? makeRepo(),
    accounts: registry,
    providers: { google, microsoft },
    ...(options.migrate ? { migrate: options.migrate } : {})
  })
  options.prepare?.({ google, microsoft, registry, events })
  // start() would also arm timers; connecting is all these tests need.
  if (!options.skipInit) await service.init()
  return { service, google, microsoft, registry, events }
}

beforeEach(() => {
  fake.triage.mockReset()
})

describe('NarsilService inbox polling', () => {
  it('keeps processing the inbox when one email cannot be parsed', async () => {
    const { service, google } = await makeService()
    const box = google.box('g1')
    box.ids = ['good', 'bad', 'older']
    box.bodies.bad = '<p>Win &#99999999; &#x110000;</p>'
    fake.triage.mockResolvedValue(TRIAGE)

    await service.refresh()

    expect(service.status().lastError).toBeUndefined()
    expect(service.inboxItems().map((i) => i.email.id).sort()).toEqual(['bad', 'good', 'older'])
    expect(service.inboxItems().every((i) => i.triage !== null)).toBe(true)
  })

  it('retries a failed triage on the next poll', async () => {
    const { service, google } = await makeService()
    google.box('g1').ids = ['a']
    fake.triage.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValue(TRIAGE)

    await service.refresh()
    expect(service.inboxItems()[0]?.triageError).toBe('rate limited')

    await service.refresh()
    expect(service.inboxItems()[0]?.triage).toEqual(TRIAGE)
  })

  it('stops retrying a triage after three failed attempts', async () => {
    const { service, google } = await makeService()
    google.box('g1').ids = ['a']
    fake.triage.mockRejectedValue(new Error('down'))

    for (let i = 0; i < 5; i++) await service.refresh()

    expect(fake.triage).toHaveBeenCalledTimes(3)
    expect(service.inboxItems()[0]?.triageError).toBe('down')
  })
})

describe('NarsilService with several accounts', () => {
  it('merges the inboxes of two Google accounts with distinct keys', async () => {
    const { service, google } = await makeService({ accounts: [ANA, BETO] })
    google.box('g1').ids = ['m1']
    google.box('g2').ids = ['m1']
    fake.triage.mockResolvedValue(TRIAGE)

    await service.refresh()

    const items = service.inboxItems()
    expect(items.map((i) => i.key).sort()).toEqual(['g1:m1', 'g2:m1'])
    expect(items.map((i) => i.email.accountId).sort()).toEqual(['g1', 'g2'])
    expect(fake.triage).toHaveBeenCalledTimes(2)
  })

  it('routes an action to the provider of the account that holds the email', async () => {
    const { service, google } = await makeService({ accounts: [ANA, BETO] })
    google.box('g1').ids = ['m1']
    google.box('g2').ids = ['m1']
    fake.triage.mockResolvedValue(TRIAGE)
    await service.refresh()

    await service.applyAction('g2:m1', 'archive')

    expect(google.box('g2').archive).toHaveBeenCalledWith('m1')
    expect(google.box('g1').archive).not.toHaveBeenCalled()
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g1:m1'])
  })

  it('sends a reply through the account that received the email', async () => {
    const { service, google } = await makeService({ accounts: [ANA, BETO] })
    google.box('g1').ids = ['m1']
    google.box('g2').ids = ['m1']
    fake.triage.mockResolvedValue(TRIAGE)
    await service.refresh()

    await service.sendReply('g2:m1', 'Hola')

    expect(google.box('g2').reply).toHaveBeenCalledTimes(1)
    expect(google.box('g2').reply.mock.calls[0]?.[0].summary).toMatchObject({ id: 'm1', accountId: 'g2' })
    expect(google.box('g2').reply.mock.calls[0]?.[1]).toBe('Hola')
    expect(google.box('g1').reply).not.toHaveBeenCalled()
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g1:m1'])
  })

  it('rejects an action on an email that is no longer listed', async () => {
    const { service } = await makeService()
    await expect(service.applyAction('g1:gone', 'save')).rejects.toThrow('Este correo ya no está en la lista.')
  })

  it('keeps listing the other accounts when one fails, prefixing the error with its email', async () => {
    const { service, google } = await makeService({ accounts: [ANA, BETO] })
    google.box('g1').listError = new Error('quota exceeded')
    google.box('g2').ids = ['m2']
    fake.triage.mockResolvedValue(TRIAGE)

    await service.refresh()

    expect(service.inboxItems().map((i) => i.key)).toEqual(['g2:m2'])
    expect(service.status().lastError).toContain('ana@gmail.com: quota exceeded')
    expect(service.status().lastError).not.toContain('beto@gmail.com')
  })

  it('merges meetings from every account by start and fires reminders for composite ids', async () => {
    const { service, google, events } = await makeService({ accounts: [ANA, BETO] })
    const at = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString()
    const meeting = (accountId: string, id: string, minutes: number): Meeting => ({
      id: `${accountId}:${id}`,
      accountId,
      title: id,
      start: at(minutes),
      end: at(minutes + 30)
    })
    google.box('g1').meetings = [meeting('g1', 'e1', 120)]
    google.box('g2').meetings = [meeting('g2', 'e1', 10)]

    await service.refresh()

    expect(service.upcomingMeetings().map((m) => m.id)).toEqual(['g2:e1', 'g1:e1'])
    expect(events.reminder).toHaveBeenCalledTimes(1)
    expect(events.reminder.mock.calls[0]?.[0]).toMatchObject({ meeting: { id: 'g2:e1' }, thresholdMinutes: 15 })
  })

  it('removes an account together with its emails and meetings', async () => {
    const { service, google, registry } = await makeService({ accounts: [ANA, BETO] })
    google.box('g1').ids = ['m1']
    google.box('g2').ids = ['m2']
    const start = new Date(Date.now() + 3 * 60 * 60_000).toISOString()
    google.box('g1').meetings = [{ id: 'g1:e', accountId: 'g1', title: 'A', start, end: start }]
    google.box('g2').meetings = [{ id: 'g2:e', accountId: 'g2', title: 'B', start, end: start }]
    fake.triage.mockResolvedValue(TRIAGE)
    await service.refresh()

    await service.removeAccount('g1')

    expect(google.removeAccount).toHaveBeenCalledWith('g1')
    expect(registry.list()).toEqual([BETO])
    expect(service.status().accounts).toEqual([BETO])
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g2:m2'])
    expect(service.upcomingMeetings().map((m) => m.id)).toEqual(['g2:e'])
  })

  it('adds an account, lists its mail and reports it in the status', async () => {
    const { service, microsoft, registry } = await makeService()
    microsoft.nextAccount = { accountId: 'm1', email: 'ana@outlook.com' }
    microsoft.box('m1').ids = ['x']
    fake.triage.mockResolvedValue(TRIAGE)

    await service.addAccount('microsoft')

    expect(registry.list()).toEqual([ANA, { id: 'm1', provider: 'microsoft', email: 'ana@outlook.com', settings: DEFAULTS }])
    expect(service.inboxItems().map((i) => i.key)).toEqual(['m1:x'])
  })

  it('rejects adding an account whose email is already connected for that provider', async () => {
    const { service, google, registry } = await makeService()
    google.nextAccount = { accountId: 'dup', email: 'Ana@Gmail.com' }

    await expect(service.addAccount('google')).rejects.toThrow('La cuenta Ana@Gmail.com ya está conectada.')

    expect(google.removeAccount).toHaveBeenCalledWith('dup')
    expect(registry.list()).toEqual([ANA])
  })

  it('returns without removing anything when the sign-in hands back an account already registered', async () => {
    const { service, google, registry } = await makeService()
    google.nextAccount = { accountId: 'g1', email: 'ana@gmail.com' }

    await expect(service.addAccount('google')).resolves.toBeUndefined()

    expect(google.removeAccount).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([ANA])
  })

  it('runs one sign-in per provider and gives callers that join it the same outcome', async () => {
    const { service, google, registry } = await makeService({ accounts: [] })
    let finish!: (added: AddedAccount) => void
    google.addAccount.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    google.box('g9')

    const first = service.addAccount('google')
    const second = service.addAccount('google')
    await vi.waitFor(() => expect(google.addAccount).toHaveBeenCalledTimes(1))
    finish({ accountId: 'g9', email: 'nueva@gmail.com' })

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(google.addAccount).toHaveBeenCalledTimes(1)
    expect(google.removeAccount).not.toHaveBeenCalled()
    expect(registry.list()).toEqual([{ id: 'g9', provider: 'google', email: 'nueva@gmail.com', settings: DEFAULTS }])
  })

  it('waits for the startup migration to finish before signing in a new account', async () => {
    let release!: () => void
    const { service, google } = await makeService({
      skipInit: true,
      migrate: () => new Promise<void>((resolve) => (release = resolve))
    })
    const init = service.init()

    const adding = service.addAccount('google')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(google.addAccount).not.toHaveBeenCalled()

    release()
    await init
    await adding
    expect(google.addAccount).toHaveBeenCalledTimes(1)
  })

  it('rejects adding an account for a provider that is not configured', async () => {
    const { service, microsoft } = await makeService()
    microsoft.configured = false

    await expect(service.addAccount('microsoft')).rejects.toThrow(
      'Primero guarda el ID de aplicación (cliente) de Microsoft.'
    )
    expect(microsoft.addAccount).not.toHaveBeenCalled()
  })

  it('reports both provider configurations in the status and delegates the Microsoft client id', async () => {
    const { service, microsoft } = await makeService()
    microsoft.configured = false
    expect(service.status()).toMatchObject({ accounts: [ANA], hasGoogleClient: true, hasMicrosoftClient: false, hasAnthropicKey: true })

    service.setMicrosoftClientId('11111111-2222-3333-4444-555555555555')

    expect(microsoft.saveClientId).toHaveBeenCalledWith('11111111-2222-3333-4444-555555555555')
  })

  it('runs the startup migration before connecting and shows its failure without blocking', async () => {
    const order: string[] = []
    const { service, google } = await makeService({
      migrate: async () => {
        order.push('migrate')
        throw new Error('offline')
      }
    })
    google.box('g1').ids = ['m1']
    fake.triage.mockResolvedValue(TRIAGE)

    await service.refresh()

    expect(order).toEqual(['migrate'])
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g1:m1'])
    expect(service.status().lastError).toContain('offline')
  })
})

describe('NarsilService startup errors', () => {
  it('clears the migration error once a later start migrates successfully', async () => {
    let fail = true
    const { service } = await makeService({
      migrate: async () => {
        if (fail) throw new Error('offline')
      }
    })
    expect(service.status().lastError).toBe(
      'No se pudo migrar tu cuenta de Google anterior (se reintentará al reiniciar): offline'
    )

    fail = false
    await service.init()

    expect(service.status().lastError).toBeUndefined()
  })

  it('labels a damaged account list as damaged, not as a failed migration', async () => {
    const { service } = await makeService({
      accounts: [],
      secrets: { accounts: 'not json' },
      migrate: async () => {
        throw new Error('La lista de cuentas está dañada.')
      }
    })

    expect(service.status().lastError).toBe('La lista de cuentas está dañada.')
  })

  it('keeps connecting the other accounts when one account has unreadable credentials', async () => {
    const { service, google } = await makeService({
      accounts: [ANA, BETO],
      prepare: ({ google }) => google.corrupt.add('g1')
    })
    google.box('g2').ids = ['m2']
    fake.triage.mockResolvedValue(TRIAGE)

    await service.refresh()

    expect(service.inboxItems().map((i) => i.key)).toEqual(['g2:m2'])
    expect(service.status().lastError).toBe(
      'ana@gmail.com: no se pudieron leer sus credenciales (Unexpected token in JSON). Quita la cuenta y vuelve a agregarla.'
    )
  })
})

const promoRule: Rule = {
  id: 'r1',
  name: 'Promos',
  enabled: true,
  action: 'delete',
  conditions: { from: 'shop.example', subject: '', body: '' }
}

describe('NarsilService rules', () => {
  it('applies a matching rule to a new email instead of listing or triaging it', async () => {
    const { service, google } = await makeService({ repo: makeRepo([promoRule]) })
    const box = google.box('g1')
    box.ids = ['promo', 'ana']
    box.senders.promo = 'Ofertas <promo@shop.example>'
    fake.triage.mockResolvedValue(TRIAGE)

    await service.refresh()

    expect(box.trash).toHaveBeenCalledWith('promo')
    expect(service.inboxItems().map((i) => i.email.id)).toEqual(['ana'])
    expect(fake.triage).toHaveBeenCalledTimes(1)
    expect(service.ruleActivity()).toMatchObject([
      { ruleName: 'Promos', action: 'delete', from: 'Ofertas <promo@shop.example>', subject: 'Asunto promo' }
    ])
    expect(service.ruleActivity()[0]?.error).toBeUndefined()
  })

  it('applies rules to every account through its own provider', async () => {
    const { service, google } = await makeService({ accounts: [ANA, BETO], repo: makeRepo([promoRule]) })
    google.box('g1').ids = ['p1']
    google.box('g1').senders.p1 = 'promo@shop.example'
    google.box('g2').ids = ['p2']
    google.box('g2').senders.p2 = 'promo@shop.example'

    await service.refresh()

    expect(google.box('g1').trash).toHaveBeenCalledWith('p1')
    expect(google.box('g2').trash).toHaveBeenCalledWith('p2')
    expect(service.inboxItems()).toEqual([])
  })

  it('applies a newly saved rule to emails already in the list and persists it', async () => {
    const repo = makeRepo()
    const { service, google } = await makeService({ repo })
    const box = google.box('g1')
    box.ids = ['promo']
    box.senders.promo = 'promo@shop.example'
    fake.triage.mockResolvedValue(TRIAGE)
    await service.refresh()
    expect(service.inboxItems()).toHaveLength(1)

    await service.saveRule({ name: 'Promos', enabled: true, action: 'archive', conditions: { from: 'shop.example', subject: '', body: '' } })

    expect(box.archive).toHaveBeenCalledWith('promo')
    expect(service.inboxItems()).toEqual([])
    expect(repo.save).toHaveBeenCalledTimes(1)
    expect(service.rules()).toHaveLength(1)
  })

  it('keeps the email in the list and records the error when the rule action fails', async () => {
    const { service, google } = await makeService({ repo: makeRepo([promoRule]) })
    const box = google.box('g1')
    box.ids = ['promo']
    box.senders.promo = 'promo@shop.example'
    box.trash.mockRejectedValue(new Error('quota'))
    fake.triage.mockResolvedValue(TRIAGE)

    await service.refresh()

    expect(service.inboxItems().map((i) => i.email.id)).toEqual(['promo'])
    expect(service.ruleActivity()[0]).toMatchObject({ ruleName: 'Promos', error: 'quota' })
  })

  it('refuses to save a rule without conditions', async () => {
    const repo = makeRepo()
    const { service } = await makeService({ repo })

    await expect(
      service.saveRule({ name: 'Todo', enabled: true, action: 'delete', conditions: { from: '', subject: '', body: '' } })
    ).rejects.toThrow('Agrega al menos una condición.')
    expect(repo.save).not.toHaveBeenCalled()
  })

  it('updates an existing rule by id and deletes rules', async () => {
    const repo = makeRepo([promoRule])
    const { service } = await makeService({ repo })

    await service.saveRule({ ...promoRule, enabled: false })
    expect(service.rules()).toEqual([{ ...promoRule, enabled: false }])

    service.deleteRule('r1')
    expect(service.rules()).toEqual([])
    expect(repo.save).toHaveBeenCalledTimes(2)
  })
})

/** Lets every already-resolved fake call finish; the fakes never wait on real I/O. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The keys of every newEmails event, one array per event. */
const announcedKeys = (events: Setup['events']): string[][] =>
  events.newEmails.mock.calls.map((call) => (call[0] as Array<{ key: string }>).map((i) => i.key))

describe('NarsilService change check', () => {
  let running: NarsilService | null = null

  async function startWithTimers(options: ServiceOptions = {}): Promise<Setup> {
    const setup = await makeService(options)
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    setup.service.start()
    running = setup.service
    await settle()
    return setup
  }

  afterEach(() => {
    running?.stop()
    running = null
    vi.useRealTimers()
  })

  it('skips the full list while the change token is unchanged and lists as soon as it changes', async () => {
    const { google } = await startWithTimers()
    const box = google.box('g1')
    expect(box.listed).toBe(1)

    await vi.advanceTimersByTimeAsync(15_000)
    await settle()
    expect(box.listed).toBe(1)

    box.token = 't1'
    await vi.advanceTimersByTimeAsync(15_000)
    await settle()
    expect(box.listed).toBe(2)
  })

  it('still lists every 60 seconds when the token never changes', async () => {
    const { google } = await startWithTimers()
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()
    expect(google.box('g1').listed).toBe(2)
  })

  it('records a failed change check as the account error without throwing, and lists on the next full poll', async () => {
    const { service, google } = await startWithTimers()
    const box = google.box('g1')
    box.tokenError = new Error('token down')

    await vi.advanceTimersByTimeAsync(15_000)
    await settle()
    expect(service.status().lastError).toBe('ana@gmail.com: token down')
    expect(box.listed).toBe(1)

    await vi.advanceTimersByTimeAsync(45_000)
    await settle()
    expect(box.listed).toBe(2)
  })

  const tick = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms)
    await settle()
    await settle()
  }

  it('does not announce again an email that leaves the list window and comes back', async () => {
    const { google, events } = await startWithTimers()
    fake.triage.mockResolvedValue(TRIAGE)
    const box = google.box('g1')
    box.ids = ['b']
    box.token = 't1'
    await tick(15_000)
    box.ids = ['c'] // b pushed out of the listed window by c
    box.token = 't2'
    await tick(15_000)
    box.ids = ['b'] // c read elsewhere, b back in the window
    box.token = 't3'
    await tick(15_000)

    expect(announcedKeys(events)).toEqual([['g1:b'], ['g1:c']])
  })

  it('never announces an email unread at the first load that enters the list window later', async () => {
    const { service, google, events } = await startWithTimers({ prepare: ({ google }) => (google.box('g1').ids = ['new1']) })
    fake.triage.mockResolvedValue(TRIAGE)
    const box = google.box('g1')
    // 'old' was unread at the first load but outside the listed window; 'new1' was read elsewhere.
    box.received.old = Date.now() - 3_600_000
    box.ids = ['old']
    box.token = 't1'
    await tick(15_000)

    expect(service.inboxItems().map((i) => i.key)).toEqual(['g1:old'])
    expect(events.newEmails).not.toHaveBeenCalled()
  })

  it('does not announce a first-load email whose fetch failed when it loads later', async () => {
    const { service, google, events } = await startWithTimers({
      prepare: ({ google }) => {
        google.box('g1').ids = ['a']
        google.box('g1').badIds.add('a')
      }
    })
    fake.triage.mockResolvedValue(TRIAGE)
    expect(service.inboxItems()).toHaveLength(0)
    google.box('g1').badIds.clear()
    await tick(60_000)

    expect(service.inboxItems().map((i) => i.key)).toEqual(['g1:a'])
    expect(events.newEmails).not.toHaveBeenCalled()
  })

  it('keeps a single change check pending while one hangs', async () => {
    const { google } = await startWithTimers()
    const box = google.box('g1')
    const before = box.tokenCalls
    box.tokenGate = new Promise(() => undefined)
    await tick(15_000)
    await tick(15_000)
    await tick(15_000)

    expect(box.tokenCalls - before).toBe(1)
  })

  it('does not save the change token after a poll that could not read an email, so the next check lists again', async () => {
    const { service, google } = await startWithTimers()
    fake.triage.mockResolvedValue(TRIAGE)
    const box = google.box('g1')
    box.ids = ['b']
    box.badIds.add('b')
    box.token = 't1'
    await tick(15_000)
    expect(box.listed).toBe(2)
    expect(service.status().lastError).toBe(
      'ana@gmail.com: no se pudieron leer 1 correo(s); se reintentará en la próxima revisión.'
    )

    box.badIds.clear()
    await tick(15_000)
    expect(box.listed).toBe(3)
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g1:b'])
    expect(service.status().lastError).toBeUndefined()
  })

  it('loads a re-added account at once while the poll of its removed predecessor still hangs', async () => {
    const { service, google, events, registry } = await startWithTimers()
    fake.triage.mockResolvedValue(TRIAGE)
    const box = google.box('g1')
    const gate = deferred<void>()
    box.listGate = gate.promise
    box.ids = ['old']
    box.token = 't1'
    await tick(15_000) // the old connection's poll hangs on its list
    await service.removeAccount('g1')
    box.listGate = null
    box.ids = ['pre']
    google.nextAccount = { accountId: 'g1', email: 'ana@gmail.com' }

    await service.addAccount('google')
    expect(registry.list().map((a) => a.id)).toEqual(['g1'])
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g1:pre'])

    gate.resolve()
    await tick(15_000)
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g1:pre'])
    expect(events.newEmails).not.toHaveBeenCalled()
  })
})

describe('NarsilService new-email notifications', () => {
  it('does not announce the emails already unread on the first load', async () => {
    const { service, google, events } = await makeService()
    google.box('g1').ids = ['a']
    fake.triage.mockResolvedValue(TRIAGE)

    await service.refresh()
    await service.refresh()

    expect(service.inboxItems()).toHaveLength(1)
    expect(events.newEmails).not.toHaveBeenCalled()
  })

  it('announces mail that arrives later once, with its triage', async () => {
    const { service, google, events } = await makeService()
    const box = google.box('g1')
    box.ids = ['a']
    fake.triage.mockResolvedValue(TRIAGE)
    await service.refresh()

    box.ids = ['b', 'a']
    await service.refresh()
    await service.refresh()

    expect(events.newEmails).toHaveBeenCalledTimes(1)
    expect(events.newEmails.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ key: 'g1:b', triage: TRIAGE, email: expect.objectContaining({ subject: 'Asunto b' }) })
    ])
  })

  it('announces new mail after a failed triage attempt too', async () => {
    const { service, google, events } = await makeService()
    const box = google.box('g1')
    await service.refresh()
    fake.triage.mockRejectedValue(new Error('rate limited'))

    box.ids = ['b']
    await service.refresh()

    expect(events.newEmails).toHaveBeenCalledTimes(1)
    expect(events.newEmails.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ key: 'g1:b', triage: null, triageError: 'rate limited' })
    ])
  })

  it('does not announce mail a rule handled', async () => {
    const { service, google, events } = await makeService({ repo: makeRepo([promoRule]) })
    const box = google.box('g1')
    await service.refresh()
    fake.triage.mockResolvedValue(TRIAGE)

    box.ids = ['promo', 'b']
    box.senders.promo = 'promo@shop.example'
    await service.refresh()

    expect(box.trash).toHaveBeenCalledWith('promo')
    expect(events.newEmails).toHaveBeenCalledTimes(1)
    expect(events.newEmails.mock.calls[0]?.[0].map((i: { key: string }) => i.key)).toEqual(['g1:b'])
  })

  it('never announces an empty list when every new email was handled by a rule', async () => {
    const { service, google, events } = await makeService({ repo: makeRepo([promoRule]) })
    const box = google.box('g1')
    await service.refresh()

    box.ids = ['promo']
    box.senders.promo = 'promo@shop.example'
    await service.refresh()

    expect(events.newEmails).not.toHaveBeenCalled()
  })

  it('announces several new emails of one poll in one event', async () => {
    const { service, google, events } = await makeService()
    const box = google.box('g1')
    await service.refresh()
    fake.triage.mockResolvedValue(TRIAGE)

    box.ids = ['b', 'c']
    await service.refresh()

    expect(events.newEmails).toHaveBeenCalledTimes(1)
    expect(events.newEmails.mock.calls[0]?.[0].map((i: { key: string }) => i.key).sort()).toEqual(['g1:b', 'g1:c'])
  })

  it('does not announce the unread mail an account already had when it was added', async () => {
    const { service, microsoft, events } = await makeService()
    await service.refresh()
    microsoft.nextAccount = { accountId: 'm1', email: 'ana@outlook.com' }
    microsoft.box('m1').ids = ['x']
    fake.triage.mockResolvedValue(TRIAGE)

    await service.addAccount('microsoft')
    expect(service.inboxItems().map((i) => i.key)).toEqual(['m1:x'])
    expect(events.newEmails).not.toHaveBeenCalled()

    microsoft.box('m1').ids = ['y', 'x']
    await service.refresh()
    expect(events.newEmails).toHaveBeenCalledTimes(1)
    expect(events.newEmails.mock.calls[0]?.[0].map((i: { key: string }) => i.key)).toEqual(['m1:y'])
  })

  it('drops an email whose account was removed while a rule ran on it', async () => {
    const { service, google, events } = await makeService({ repo: makeRepo([promoRule]) })
    const box = google.box('g1')
    await service.refresh()
    const action = deferred<void>()
    box.trash.mockImplementation(() => action.promise)
    box.ids = ['promo']
    box.senders.promo = 'promo@shop.example'

    const polling = service.refresh()
    await vi.waitFor(() => expect(box.trash).toHaveBeenCalledWith('promo'))
    await service.removeAccount('g1')
    action.reject(new Error('quota')) // the rule failed, so the email would normally stay listed
    await polling

    expect(service.inboxItems()).toEqual([])
    expect(events.newEmails).not.toHaveBeenCalled()
  })

  it('announces an email with the triage setAnthropicKey started for it', async () => {
    const { service, google, events } = await makeService()
    const box = google.box('g1')
    await service.refresh()
    const result = deferred<Triage>()
    fake.triage.mockReturnValue(result.promise)
    // The key arrives right after the poll listed 'b' and before it triages it.
    events.inboxChanged.mockImplementationOnce(() => service.setAnthropicKey('new-key'))
    box.ids = ['b']

    const polling = service.refresh()
    await settle()
    result.resolve(TRIAGE)
    await polling

    expect(fake.triage).toHaveBeenCalledTimes(1)
    expect(events.newEmails).toHaveBeenCalledTimes(1)
    expect(events.newEmails.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ key: 'g1:b', triage: TRIAGE })])
  })
})

describe('NarsilService folders', () => {
  it('moves an email to a folder through the account that holds it and drops it from the list', async () => {
    const { service, google } = await makeService({ accounts: [ANA, BETO] })
    google.box('g1').ids = ['m1']
    google.box('g2').ids = ['m1']
    fake.triage.mockResolvedValue(TRIAGE)
    await service.refresh()

    await service.applyAction('g2:m1', 'save', 'Label_7')

    expect(google.box('g2').moveToFolder).toHaveBeenCalledWith('m1', 'Label_7')
    expect(google.box('g1').moveToFolder).not.toHaveBeenCalled()
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g1:m1'])
  })

  it('rejects save without a folder and keeps the email listed', async () => {
    const { service, google } = await makeService()
    google.box('g1').ids = ['m1']
    fake.triage.mockResolvedValue(TRIAGE)
    await service.refresh()

    await expect(service.applyAction('g1:m1', 'save')).rejects.toThrow('Elige una carpeta para guardar este correo.')
    expect(google.box('g1').moveToFolder).not.toHaveBeenCalled()
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g1:m1'])
  })

  it('lists and creates folders on the chosen account, trimming the name', async () => {
    const { service, google } = await makeService({ accounts: [ANA, BETO] })
    google.box('g2').folders = [{ id: 'Label_2', name: 'Viajes' }]

    expect(await service.listFolders('g2')).toEqual([{ id: 'Label_2', name: 'Viajes' }])
    expect(await service.createFolder('g2', '  Viajes/2026 ')).toEqual({ id: 'new-Viajes/2026', name: 'Viajes/2026' })
    expect(google.box('g2').createFolder).toHaveBeenCalledWith('Viajes/2026')
    expect(google.box('g1').createFolder).not.toHaveBeenCalled()
  })

  it('rejects a folder name that is empty or longer than 100 characters', async () => {
    const { service, google } = await makeService()
    const error = 'El nombre de la carpeta debe tener entre 1 y 100 caracteres.'
    await expect(service.createFolder('g1', '   ')).rejects.toThrow(error)
    await expect(service.createFolder('g1', 'x'.repeat(101))).rejects.toThrow(error)
    expect(google.box('g1').createFolder).not.toHaveBeenCalled()
  })

  it('rejects folders of an account that is not connected', async () => {
    const { service } = await makeService()
    await expect(service.listFolders('nope')).rejects.toThrow('Esta cuenta ya no está conectada.')
  })
})

describe('NarsilService inbox settings', () => {
  it('lists each account with its own settings, the defaults when none were saved', async () => {
    const wide: Account = { ...BETO, settings: { includeCategories: true, windowDays: 7 } }
    const { service, google } = await makeService({ accounts: [ANA, wide] })

    await service.refresh()

    expect(google.box('g1').settingsSeen).toEqual([DEFAULTS])
    expect(google.box('g2').settingsSeen).toEqual([{ includeCategories: true, windowDays: 7 }])
  })

  it('persists new settings and repolls only that account with them', async () => {
    const { service, google, registry, events } = await makeService({ accounts: [ANA, BETO] })
    await service.refresh()
    google.box('g2').ids = ['promo']
    fake.triage.mockResolvedValue(TRIAGE)
    events.statusChanged.mockClear()
    const settings: AccountSettings = { includeCategories: true, windowDays: 30 }

    await service.setAccountSettings('g2', settings)

    expect(registry.list().find((a) => a.id === 'g2')?.settings).toEqual(settings)
    expect(registry.list().find((a) => a.id === 'g1')?.settings).toEqual(DEFAULTS)
    expect(google.box('g1').listed).toBe(1)
    expect(google.box('g2').listed).toBe(2)
    expect(google.box('g2').settingsSeen.at(-1)).toEqual(settings)
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g2:promo'])
    expect(service.status().accounts.find((a) => a.id === 'g2')?.settings).toEqual(settings)
    expect(events.statusChanged).toHaveBeenCalled()
  })

  it('repolls with the new settings after a poll of that account that was already running', async () => {
    const { service, google } = await makeService()
    const box = google.box('g1')
    const gate = deferred<void>()
    box.listGate = gate.promise
    const running = service.refresh()
    await settle()

    const changing = service.setAccountSettings('g1', { includeCategories: true, windowDays: 2 })
    box.listGate = null
    gate.resolve()
    await Promise.all([running, changing])

    expect(box.settingsSeen).toEqual([DEFAULTS, { includeCategories: true, windowDays: 2 }])
  })

  it('rejects settings for an unknown account', async () => {
    const { service } = await makeService()
    await expect(service.setAccountSettings('nope', DEFAULTS)).rejects.toThrow('Esta cuenta ya no está conectada.')
  })
})

describe('NarsilService save rules', () => {
  const conditions = { from: 'banco.example', subject: '', body: '' }

  it('archives with an old save rule that has no folder', async () => {
    const legacy: Rule = { id: 'r1', name: 'Banco', enabled: true, action: 'save', conditions }
    const { service, google } = await makeService({ repo: makeRepo([legacy]) })
    const box = google.box('g1')
    box.ids = ['b1']
    box.senders.b1 = 'avisos@banco.example'

    await service.refresh()

    expect(box.archive).toHaveBeenCalledWith('b1')
    expect(box.moveToFolder).not.toHaveBeenCalled()
    expect(service.inboxItems()).toEqual([])
    expect(service.ruleActivity()[0]).toMatchObject({ ruleName: 'Banco', action: 'archive' })
  })

  it('moves to the folder of a save rule on its own account and leaves other accounts alone', async () => {
    const rule: Rule = {
      id: 'r1',
      name: 'Banco',
      enabled: true,
      action: 'save',
      conditions,
      folder: { accountId: 'g1', id: 'Label_1', name: 'Bancos' }
    }
    const { service, google } = await makeService({ accounts: [ANA, BETO], repo: makeRepo([rule]) })
    google.box('g1').ids = ['b1']
    google.box('g1').senders.b1 = 'avisos@banco.example'
    google.box('g2').ids = ['b2']
    google.box('g2').senders.b2 = 'avisos@banco.example'
    fake.triage.mockResolvedValue(TRIAGE)

    await service.refresh()

    expect(google.box('g1').moveToFolder).toHaveBeenCalledWith('b1', 'Label_1')
    expect(google.box('g2').moveToFolder).not.toHaveBeenCalled()
    expect(service.inboxItems().map((i) => i.key)).toEqual(['g2:b2'])
    expect(service.ruleActivity()[0]).toMatchObject({ ruleName: 'Banco', action: 'save', folderName: 'Bancos' })
  })

  it('refuses to save a new save rule without a folder', async () => {
    const repo = makeRepo()
    const { service } = await makeService({ repo })
    await expect(service.saveRule({ name: 'Banco', enabled: true, action: 'save', conditions })).rejects.toThrow(
      'Elige la carpeta donde se guardan estos correos.'
    )
    expect(repo.save).not.toHaveBeenCalled()
  })

  it('still turns an old save rule without a folder on and off, keeping it as it was', async () => {
    const legacy: Rule = { id: 'r1', name: 'Banco', enabled: true, action: 'save', conditions }
    const { service } = await makeService({ repo: makeRepo([legacy]) })

    await service.saveRule({ ...legacy, enabled: false })

    expect(service.rules()).toEqual([{ ...legacy, enabled: false }])
  })
})
