import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NarsilService } from '../src/main/app/narsilService'
import type { Triage } from '@shared/types'

const fake = vi.hoisted(() => ({
  ids: [] as string[],
  bodies: {} as Record<string, string>,
  triage: vi.fn<() => Promise<Triage>>()
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
      getMessage = async (id: string) =>
        parseMessage({
          id,
          threadId: `t-${id}`,
          snippet: '',
          internalDate: '1',
          payload: {
            mimeType: 'text/html',
            headers: [{ name: 'From', value: 'x@example.com' }],
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

function makeService(): NarsilService {
  const store = { get: (name: string) => (name === 'anthropic-key' ? 'test-key' : null), set: vi.fn(), delete: vi.fn(), has: () => true }
  const events = { inboxChanged: vi.fn(), meetingsChanged: vi.fn(), reminder: vi.fn(), statusChanged: vi.fn() }
  // start() would also arm timers; connecting is all these tests need.
  const service = new NarsilService(store as never, events)
  ;(service as unknown as { connectServices(): void }).connectServices()
  return service
}

beforeEach(() => {
  fake.ids = []
  fake.bodies = {}
  fake.triage.mockReset()
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
