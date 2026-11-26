import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NarsilService } from '../src/main/app/narsilService'
import type { Rule, Triage } from '@shared/types'

const fake = vi.hoisted(() => ({
  ids: [] as string[],
  bodies: {} as Record<string, string>,
  senders: {} as Record<string, string>,
  triage: vi.fn<() => Promise<Triage>>(),
  archive: vi.fn<(id: string) => Promise<void>>(),
  trash: vi.fn<(id: string) => Promise<void>>(),
  save: vi.fn<(id: string) => Promise<void>>()
}))

vi.mock('../src/main/adapters/googleAuth', () => ({
  GoogleAuth: class {
    hasClientConfig = () => true
    isConnected = () => true
    getAuthorizedClient = () => ({})
  }
}))
vi.mock('../src/main/adapters/gmail', async () => {
  const { parseMessage } = await import('../src/main/domain/email')
  return {
    GmailService: class {
      listUnread = async () => fake.ids
      archive = (id: string) => fake.archive(id)
      trash = (id: string) => fake.trash(id)
      save = (id: string) => fake.save(id)
      getMessage = async (id: string) =>
        parseMessage({
          id,
          threadId: `t-${id}`,
          snippet: '',
          internalDate: '1',
          payload: {
            mimeType: 'text/html',
            headers: [{ name: 'From', value: fake.senders[id] ?? 'x@example.com' }, { name: 'Subject', value: `Asunto ${id}` }],
            body: { data: Buffer.from(fake.bodies[id] ?? '<p>hi</p>').toString('base64url') }
          }
        })
    }
  }
})
vi.mock('../src/main/adapters/calendar', () => ({ CalendarService: class { upcoming = async () => [] } }))
vi.mock('../src/main/adapters/claude', () => ({
  ClaudeTriage: class {
    triage = () => fake.triage()
  },
  describeClaudeError: (e: unknown) => (e instanceof Error ? e.message : String(e))
}))

const TRIAGE: Triage = { summary: 's', recommendedAction: 'archive', reason: 'r', replies: [] }

function makeRepo(rules: Rule[] = []) {
  return { load: vi.fn(() => rules), save: vi.fn<(rules: Rule[]) => void>() }
}

function makeService(repo = makeRepo()): NarsilService {
  const store = { get: (name: string) => (name === 'anthropic-key' ? 'test-key' : null), set: vi.fn(), delete: vi.fn(), has: () => true }
  const events = {
    inboxChanged: vi.fn(),
    meetingsChanged: vi.fn(),
    reminder: vi.fn(),
    statusChanged: vi.fn(),
    rulesChanged: vi.fn(),
    activityChanged: vi.fn()
  }
  // start() would also arm timers; connecting is all these tests need.
  const service = new NarsilService(store as never, events, repo)
  ;(service as unknown as { connectServices(): void }).connectServices()
  return service
}

beforeEach(() => {
  fake.ids = []
  fake.bodies = {}
  fake.senders = {}
  fake.triage.mockReset()
  for (const action of [fake.archive, fake.trash, fake.save]) action.mockReset().mockResolvedValue(undefined)
})

describe('NarsilService inbox polling', () => {
  it('keeps processing the inbox when one email cannot be parsed', async () => {
    fake.ids = ['good', 'bad', 'older']
    fake.bodies.bad = '<p>Win &#99999999; &#x110000;</p>'
    fake.triage.mockResolvedValue(TRIAGE)
    const service = makeService()

    await service.refresh()

    expect(service.status().lastError).toBeUndefined()
    expect(service.inboxItems().map((i) => i.email.id).sort()).toEqual(['bad', 'good', 'older'])
    expect(service.inboxItems().every((i) => i.triage !== null)).toBe(true)
  })

  it('retries a failed triage on the next poll', async () => {
    fake.ids = ['a']
    fake.triage.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValue(TRIAGE)
    const service = makeService()

    await service.refresh()
    expect(service.inboxItems()[0]?.triageError).toBe('rate limited')

    await service.refresh()
    expect(service.inboxItems()[0]?.triage).toEqual(TRIAGE)
  })

  it('stops retrying a triage after three failed attempts', async () => {
    fake.ids = ['a']
    fake.triage.mockRejectedValue(new Error('down'))
    const service = makeService()

    for (let i = 0; i < 5; i++) await service.refresh()

    expect(fake.triage).toHaveBeenCalledTimes(3)
    expect(service.inboxItems()[0]?.triageError).toBe('down')
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
    fake.ids = ['promo', 'ana']
    fake.senders.promo = 'Ofertas <promo@shop.example>'
    fake.triage.mockResolvedValue(TRIAGE)
    const service = makeService(makeRepo([promoRule]))

    await service.refresh()

    expect(fake.trash).toHaveBeenCalledWith('promo')
    expect(service.inboxItems().map((i) => i.email.id)).toEqual(['ana'])
    expect(fake.triage).toHaveBeenCalledTimes(1)
    expect(service.ruleActivity()).toMatchObject([
      { ruleName: 'Promos', action: 'delete', from: 'Ofertas <promo@shop.example>', subject: 'Asunto promo' }
    ])
    expect(service.ruleActivity()[0]?.error).toBeUndefined()
  })

  it('applies a newly saved rule to emails already in the list and persists it', async () => {
    fake.ids = ['promo']
    fake.senders.promo = 'promo@shop.example'
    fake.triage.mockResolvedValue(TRIAGE)
    const repo = makeRepo()
    const service = makeService(repo)
    await service.refresh()
    expect(service.inboxItems()).toHaveLength(1)

    await service.saveRule({ name: 'Promos', enabled: true, action: 'archive', conditions: { from: 'shop.example', subject: '', body: '' } })

    expect(fake.archive).toHaveBeenCalledWith('promo')
    expect(service.inboxItems()).toEqual([])
    expect(repo.save).toHaveBeenCalledTimes(1)
    expect(service.rules()).toHaveLength(1)
  })

  it('keeps the email in the list and records the error when the rule action fails', async () => {
    fake.ids = ['promo']
    fake.senders.promo = 'promo@shop.example'
    fake.trash.mockRejectedValue(new Error('quota'))
    fake.triage.mockResolvedValue(TRIAGE)
    const service = makeService(makeRepo([promoRule]))

    await service.refresh()

    expect(service.inboxItems().map((i) => i.email.id)).toEqual(['promo'])
    expect(service.ruleActivity()[0]).toMatchObject({ ruleName: 'Promos', error: 'quota' })
  })

  it('refuses to save a rule without conditions', async () => {
    const repo = makeRepo()
    const service = makeService(repo)

    await expect(
      service.saveRule({ name: 'Todo', enabled: true, action: 'delete', conditions: { from: '', subject: '', body: '' } })
    ).rejects.toThrow('Agrega al menos una condición.')
    expect(repo.save).not.toHaveBeenCalled()
  })

  it('updates an existing rule by id and deletes rules', async () => {
    const repo = makeRepo([promoRule])
    const service = makeService(repo)

    await service.saveRule({ ...promoRule, enabled: false })
    expect(service.rules()).toEqual([{ ...promoRule, enabled: false }])

    service.deleteRule('r1')
    expect(service.rules()).toEqual([])
    expect(repo.save).toHaveBeenCalledTimes(2)
  })
})
