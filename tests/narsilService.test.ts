import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NarsilService, type NarsilEvents } from '../src/main/app/narsilService'
import { AccountRegistry, type SecretStore } from '../src/main/app/accounts'
import { parseMessage, type ParsedEmail } from '../src/main/domain/email'
import type { AccountConnection, AddedAccount, ProviderAuth } from '../src/main/app/ports'
import type { SecretName } from '../src/main/adapters/secureStore'
import type { Account, Meeting, ProviderKind, Rule, Triage } from '@shared/types'

const fake = vi.hoisted(() => ({ triage: vi.fn<() => Promise<Triage>>() }))

vi.mock('../src/main/adapters/claude', () => ({
  ClaudeTriage: class {
    triage = () => fake.triage()
  },
  describeClaudeError: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))

/** One fake mailbox and calendar behind a connected account. */
function makeMailbox() {
  return {
    ids: [] as string[],
    bodies: {} as Record<string, string>,
    senders: {} as Record<string, string>,
    meetings: [] as Meeting[],
    listError: null as Error | null,
    /** What changeToken() returns; a test changes it when new mail "arrives". */
    token: 't0',
    tokenError: null as Error | null,
    /** How many times listUnread() ran. */
    listed: 0,
    archive: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    trash: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    save: vi.fn<(id: string) => Promise<void>>(async () => undefined),
    reply: vi.fn<(email: ParsedEmail, body: string) => Promise<void>>(async () => undefined)
  }
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
        listUnread: async () => {
          box.listed++
          if (box.listError) throw box.listError
          return box.ids
        },
        changeToken: async () => {
          if (box.tokenError) throw box.tokenError
          return box.token
        },
        getMessage: async (id) =>
          parseMessage(
            {
              id,
              threadId: `t-${id}`,
              snippet: '',
              internalDate: '1',
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
          ),
        archive: (id) => box.archive(id),
        trash: (id) => box.trash(id),
        save: (id) => box.save(id),
        reply: (email, body) => box.reply(email, body)
      },
      calendar: { upcoming: async () => box.meetings }
    }
  }
}

const TRIAGE: Triage = { summary: 's', recommendedAction: 'archive', reason: 'r', replies: [] }
const ANA: Account = { id: 'g1', provider: 'google', email: 'ana@gmail.com' }
const BETO: Account = { id: 'g2', provider: 'google', email: 'beto@gmail.com' }

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

    expect(registry.list()).toEqual([ANA, { id: 'm1', provider: 'microsoft', email: 'ana@outlook.com' }])
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
    expect(registry.list()).toEqual([{ id: 'g9', provider: 'google', email: 'nueva@gmail.com' }])
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
})
