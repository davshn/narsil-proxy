import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SharedSnapshot, SharedState } from '@shared/types'
import type { SharedSession, SharedTable } from '../src/main/app/sharedAuth'
import { SHARED_POLL_MS, SharedSync, type SharedAssignment, type SharedCacheRepository, type SharedInvitation } from '../src/main/app/sharedSync'

const ANA = { id: 'u-ana', email: 'ana@gmail.com', name: 'Ana Pérez' }
const LUIS = { id: 'u-luis', email: 'luis@gmail.com', name: 'Luis Gómez' }

type Rows = Record<SharedTable, Record<string, unknown>[]>

/** What the database lets Ana read, in the shape PostgREST answers with. */
function anaRows(): Rows {
  return {
    profiles: [ANA, LUIS],
    lists: [
      { id: 'l-casa', name: 'Casa', owner_id: LUIS.id, created_at: '2026-11-27T10:00:00+00:00' },
      { id: 'l-club', name: 'Club', owner_id: 'u-marta', created_at: '2026-11-27T10:05:00+00:00' }
    ],
    list_members: [
      { list_id: 'l-casa', email: LUIS.email, added_at: '2026-11-27T10:00:00+00:00', accepted_at: '2026-11-27T10:00:00+00:00' },
      { list_id: 'l-casa', email: ANA.email, added_at: '2026-11-27T10:01:00+00:00', accepted_at: '2026-11-27T10:02:00+00:00' },
      // Ana's own invitation to a list she has not accepted yet.
      { list_id: 'l-club', email: ANA.email, added_at: '2026-11-27T10:06:00+00:00', accepted_at: null }
    ],
    shared_tasks: [task('t-1', { name: 'Comprar pan', assignee_email: LUIS.email, created_by: LUIS.id, updated_by: LUIS.id })]
  }
}

function task(id: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    list_id: 'l-casa',
    name: 'Tarea',
    description: '',
    status: 'todo',
    assignee_email: null,
    created_by: LUIS.id,
    created_at: '2026-11-27T11:00:00+00:00',
    updated_by: LUIS.id,
    updated_at: '2026-11-27T11:00:00+00:00',
    ...fields
  }
}

class MemoryCache implements SharedCacheRepository {
  saves = 0
  constructor(public snapshot: SharedSnapshot | null = null) {}
  load(): SharedSnapshot | null {
    return this.snapshot && structuredClone(this.snapshot)
  }
  save(snapshot: SharedSnapshot): void {
    this.saves += 1
    this.snapshot = structuredClone(snapshot)
  }
  clear(): void {
    this.snapshot = null
  }
}

interface Fake {
  rows: Rows
  /** null: signed out. */
  user: { id: string; email: string } | null
  /** Set to make every query fail, as when the network is down. */
  failure: string | null
  /** Set to make reading the session fail, as when a token refresh cannot reach Supabase. */
  sessionFailure: string | null
  sessions: number
}

function setup(options: { cache?: MemoryCache; rows?: Rows } = {}) {
  const fake: Fake = { rows: options.rows ?? anaRows(), user: { id: ANA.id, email: ANA.email }, failure: null, sessionFailure: null, sessions: 0 }
  const cache = options.cache ?? new MemoryCache()
  const states: SharedState[] = []
  const assigned: SharedAssignment[][] = []
  const invited: SharedInvitation[][] = []
  const sync = new SharedSync({
    source: {
      session: async (): Promise<SharedSession | null> => {
        fake.sessions += 1
        if (fake.sessionFailure) throw new Error(fake.sessionFailure)
        if (!fake.user) return null
        return {
          ...fake.user,
          select: async (table) =>
            fake.failure ? { data: null, error: { message: fake.failure } } : { data: structuredClone(fake.rows[table]), error: null },
          write: async () => ({ error: null, count: 1 })
        }
      }
    },
    cache,
    changed: (state) => states.push(state),
    assigned: (items) => assigned.push(items),
    invited: (items) => invited.push(items),
    now: () => new Date('2026-11-27T12:00:00Z')
  })
  return { fake, cache, states, assigned, invited, sync }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SharedSync.refresh', () => {
  it('reads what the user can see into one snapshot, stores it and reports it', async () => {
    const { cache, states, sync } = setup()
    const state = await sync.refresh()
    const expected: SharedSnapshot = {
      userId: ANA.id,
      email: ANA.email,
      people: [ANA, LUIS],
      lists: [
        { id: 'l-casa', name: 'Casa', ownerId: LUIS.id, createdAt: '2026-11-27T10:00:00+00:00', accepted: true },
        { id: 'l-club', name: 'Club', ownerId: 'u-marta', createdAt: '2026-11-27T10:05:00+00:00', accepted: false }
      ],
      members: [
        { listId: 'l-casa', email: LUIS.email, addedAt: '2026-11-27T10:00:00+00:00', acceptedAt: '2026-11-27T10:00:00+00:00' },
        { listId: 'l-casa', email: ANA.email, addedAt: '2026-11-27T10:01:00+00:00', acceptedAt: '2026-11-27T10:02:00+00:00' },
        { listId: 'l-club', email: ANA.email, addedAt: '2026-11-27T10:06:00+00:00', acceptedAt: null }
      ],
      tasks: [
        {
          id: 't-1',
          listId: 'l-casa',
          name: 'Comprar pan',
          description: '',
          status: 'todo',
          assigneeEmail: LUIS.email,
          createdBy: LUIS.id,
          createdAt: '2026-11-27T11:00:00+00:00',
          updatedBy: LUIS.id,
          updatedAt: '2026-11-27T11:00:00+00:00'
        }
      ],
      syncedAt: '2026-11-27T12:00:00.000Z'
    }
    expect(state).toEqual({ signedIn: true, snapshot: expected })
    expect(cache.snapshot).toEqual(expected)
    expect(states).toEqual([state])
  })

  it('counts a list the user owns as accepted, also before their membership row is visible', async () => {
    const rows = anaRows()
    rows.lists.push({ id: 'l-mia', name: 'Mía', owner_id: ANA.id, created_at: '2026-11-27T10:10:00+00:00' })
    const { sync } = setup({ rows })
    const state = await sync.refresh()
    expect(state.snapshot?.lists.find((l) => l.id === 'l-mia')?.accepted).toBe(true)
  })

  it('keeps the stored copy and reports the error when Supabase cannot be reached', async () => {
    const { fake, cache, sync } = setup()
    const first = await sync.refresh()
    fake.failure = 'TypeError: fetch failed'
    const state = await sync.refresh()
    expect(state).toEqual({ signedIn: true, snapshot: first.snapshot, error: 'No se pudo sincronizar: TypeError: fetch failed' })
    expect(cache.snapshot).toEqual(first.snapshot)
    expect(cache.saves).toBe(1)
  })

  it('keeps the stored copy when the session cannot be refreshed offline', async () => {
    const cache = new MemoryCache()
    const first = await setup({ cache }).sync.refresh()
    const { fake, sync } = setup({ cache })
    fake.sessionFailure = 'TypeError: fetch failed'
    const state = await sync.refresh()
    expect(state).toEqual({ signedIn: true, snapshot: first.snapshot, error: 'No se pudo sincronizar: TypeError: fetch failed' })
    expect(cache.snapshot).toEqual(first.snapshot)
  })

  it('refuses rows that do not have the expected shape, and keeps the stored copy', async () => {
    const { fake, cache, sync } = setup()
    const first = await sync.refresh()
    fake.rows.shared_tasks = [task('t-2', { status: 'archived' })]
    const state = await sync.refresh()
    expect(state.error).toBe('No se pudo sincronizar: Supabase devolvió datos con una forma inesperada.')
    expect(state.snapshot).toEqual(first.snapshot)
    expect(cache.snapshot).toEqual(first.snapshot)
  })

  it('forgets the stored copy when the user is signed out', async () => {
    const { fake, cache, sync } = setup()
    await sync.refresh()
    fake.user = null
    const state = await sync.refresh()
    expect(state).toEqual({ signedIn: false, snapshot: null })
    expect(cache.snapshot).toBeNull()
  })

  it('runs one sync at a time and one more when asked during it', async () => {
    const { fake, sync } = setup()
    await Promise.all([sync.refresh(), sync.refresh(), sync.refresh()])
    expect(fake.sessions).toBe(2)
  })
})

describe('SharedSync.state', () => {
  it('starts from the stored copy, so the lists show while offline', () => {
    const cache = new MemoryCache()
    return setup({ cache })
      .sync.refresh()
      .then((first) => {
        expect(setup({ cache }).sync.state()).toEqual({ signedIn: true, snapshot: first.snapshot })
      })
  })

  it('is signed out with nothing stored', () => {
    expect(setup().sync.state()).toEqual({ signedIn: false, snapshot: null })
  })
})

describe('SharedSync assignments', () => {
  it('reports a task someone else assigned to the user since the last sync', async () => {
    const { fake, sync, assigned } = setup()
    await sync.refresh()
    fake.rows.shared_tasks.push(task('t-2', { name: 'Pagar la luz', assignee_email: ANA.email }))
    await sync.refresh()
    expect(assigned).toHaveLength(1)
    expect(assigned[0]).toEqual([
      {
        task: expect.objectContaining({ id: 't-2', name: 'Pagar la luz' }),
        list: expect.objectContaining({ id: 'l-casa', name: 'Casa' }),
        by: LUIS
      }
    ])
  })

  it('reports a task reassigned to the user', async () => {
    const { fake, sync, assigned } = setup()
    await sync.refresh()
    fake.rows.shared_tasks = [task('t-1', { name: 'Comprar pan', assignee_email: ANA.email })]
    await sync.refresh()
    expect(assigned.flat().map((a) => a.task.id)).toEqual(['t-1'])
  })

  it('reports nothing on the first sync, when there is nothing to compare with', async () => {
    const { sync, assigned } = setup({ rows: { ...anaRows(), shared_tasks: [task('t-2', { assignee_email: ANA.email })] } })
    await sync.refresh()
    expect(assigned).toEqual([])
  })

  it('reports what arrived while Narsil was closed, comparing with the stored copy', async () => {
    const cache = new MemoryCache()
    await setup({ cache }).sync.refresh()
    const { fake, sync, assigned } = setup({ cache })
    fake.rows.shared_tasks.push(task('t-2', { assignee_email: ANA.email }))
    await sync.refresh()
    expect(assigned.flat().map((a) => a.task.id)).toEqual(['t-2'])
  })

  it('does not report tasks the user assigned to themselves, others’ tasks, or edits of a task already theirs', async () => {
    const { fake, sync, assigned } = setup({ rows: { ...anaRows(), shared_tasks: [task('t-3', { assignee_email: ANA.email })] } })
    await sync.refresh()
    fake.rows.shared_tasks = [
      task('t-3', { assignee_email: ANA.email, name: 'Renombrada', updated_at: '2026-11-27T11:30:00+00:00' }),
      task('t-4', { assignee_email: ANA.email, created_by: ANA.id, updated_by: ANA.id }),
      task('t-5', { assignee_email: LUIS.email })
    ]
    await sync.refresh()
    expect(assigned).toEqual([])
  })

  it('does not compare with a stored copy of another user', async () => {
    const cache = new MemoryCache()
    await setup({ cache }).sync.refresh()
    const { fake, sync, assigned } = setup({ cache })
    fake.user = { id: LUIS.id, email: LUIS.email }
    fake.rows.shared_tasks.push(task('t-2', { assignee_email: LUIS.email, created_by: ANA.id, updated_by: ANA.id }))
    await sync.refresh()
    expect(assigned).toEqual([])
  })
})

describe('SharedSync invitations', () => {
  const MARTA = { id: 'u-marta', email: 'marta@gmail.com', name: 'Marta Ruiz' }

  /** Ana's rows before Marta invited her to "Club". */
  function withoutClub(): Rows {
    const rows = anaRows()
    rows.lists = rows.lists.filter((l) => l.id !== 'l-club')
    rows.list_members = rows.list_members.filter((m) => m.list_id !== 'l-club')
    return rows
  }

  it('reports an invitation that arrived since the last sync, with who sent it', async () => {
    const { fake, sync, invited } = setup({ rows: withoutClub() })
    await sync.refresh()
    fake.rows = anaRows()
    fake.rows.profiles.push(MARTA)
    await sync.refresh()
    expect(invited).toEqual([[{ list: expect.objectContaining({ id: 'l-club', name: 'Club', accepted: false }), by: MARTA }]])
  })

  it('reports nothing on the first sync, for an invitation already reported, or once it is accepted', async () => {
    const { fake, sync, invited } = setup()
    await sync.refresh()
    await sync.refresh()
    fake.rows.list_members = fake.rows.list_members.map((m) =>
      m.list_id === 'l-club' ? { ...m, accepted_at: '2026-11-27T11:00:00+00:00' } : m
    )
    await sync.refresh()
    expect(invited).toEqual([])
  })

  it('does not compare with a stored copy of another user', async () => {
    const cache = new MemoryCache()
    await setup({ cache, rows: withoutClub() }).sync.refresh()
    const { fake, sync, invited } = setup({ cache })
    fake.user = { id: LUIS.id, email: LUIS.email }
    await sync.refresh()
    expect(invited).toEqual([])
  })
})

describe('SharedSync.start', () => {
  it(`syncs at once and then every ${SHARED_POLL_MS / 1000} seconds until stopped`, async () => {
    vi.useFakeTimers()
    const { fake, sync } = setup()
    sync.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sessions).toBe(1)
    await vi.advanceTimersByTimeAsync(SHARED_POLL_MS)
    expect(fake.sessions).toBe(2)
    await vi.advanceTimersByTimeAsync(SHARED_POLL_MS)
    expect(fake.sessions).toBe(3)
    sync.stop()
    await vi.advanceTimersByTimeAsync(SHARED_POLL_MS * 3)
    expect(fake.sessions).toBe(3)
  })
})
