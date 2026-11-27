import { z } from 'zod'
import {
  TASK_STATUSES,
  type SharedList,
  type SharedPerson,
  type SharedSnapshot,
  type SharedState,
  type SharedTask
} from '@shared/types'
import type { SharedSession, SharedTable } from './sharedAuth'

/** How often Narsil reads the shared lists (decision D5: polling, not Supabase Realtime). */
export const SHARED_POLL_MS = 10_000

/** The local copy that lets the lists show while offline. */
export interface SharedCacheRepository {
  load(): SharedSnapshot | null
  save(snapshot: SharedSnapshot): void
  clear(): void
}

export interface SharedSource {
  /** Null when nobody is signed in; throws when the session cannot be read right now. */
  session(): Promise<SharedSession | null>
}

/** A task that someone else assigned to the user since the previous sync. */
export interface SharedAssignment {
  task: SharedTask
  list: SharedList | undefined
  /** Undefined when that person's profile is not visible any more. */
  by: SharedPerson | undefined
}

/** A list someone invited the user to since the previous sync. */
export interface SharedInvitation {
  list: SharedList
  /** The owner who invited them; undefined when that profile is not visible. */
  by: SharedPerson | undefined
}

export interface SharedSyncDeps {
  source: SharedSource
  cache: SharedCacheRepository
  changed(state: SharedState): void
  assigned(items: SharedAssignment[]): void
  invited(items: SharedInvitation[]): void
  now?: () => Date
  intervalMs?: number
}

const Id = z.string().min(1)
const Stamp = z.string().min(1)

const ROWS = {
  profiles: z.object({ id: Id, email: z.string(), name: z.string() }),
  lists: z.object({ id: Id, name: z.string(), owner_id: Id, created_at: Stamp }),
  list_members: z.object({ list_id: Id, email: z.string(), added_at: Stamp, accepted_at: Stamp.nullable() }),
  shared_tasks: z.object({
    id: Id,
    list_id: Id,
    name: z.string(),
    description: z.string(),
    status: z.enum(TASK_STATUSES),
    assignee_email: z.string().nullable(),
    created_by: Id,
    created_at: Stamp,
    updated_by: Id.nullable(),
    updated_at: Stamp
  })
} satisfies Record<SharedTable, z.ZodType>

const COLUMNS: Record<SharedTable, string> = {
  profiles: 'id,email,name',
  lists: 'id,name,owner_id,created_at',
  list_members: 'list_id,email,added_at,accepted_at',
  shared_tasks: 'id,list_id,name,description,status,assignee_email,created_by,created_at,updated_by,updated_at'
}

/** The shape of a stored snapshot, for the cache to check what it reads back. */
export const SharedSnapshotSchema: z.ZodType<SharedSnapshot> = z.object({
  userId: Id,
  email: z.string(),
  people: z.array(z.object({ id: Id, email: z.string(), name: z.string() })),
  lists: z.array(z.object({ id: Id, name: z.string(), ownerId: Id, createdAt: Stamp, accepted: z.boolean() })),
  members: z.array(z.object({ listId: Id, email: z.string(), addedAt: Stamp, acceptedAt: Stamp.nullable() })),
  tasks: z.array(
    z.object({
      id: Id,
      listId: Id,
      name: z.string(),
      description: z.string(),
      status: z.enum(TASK_STATUSES),
      assigneeEmail: z.string().nullable(),
      createdBy: Id,
      createdAt: Stamp,
      updatedBy: Id.nullable(),
      updatedAt: Stamp
    })
  ),
  syncedAt: Stamp
})

class UnexpectedRows extends Error {
  constructor() {
    super('Supabase devolvió datos con una forma inesperada.')
  }
}

async function read<T extends SharedTable>(session: SharedSession, table: T): Promise<z.infer<(typeof ROWS)[T]>[]> {
  const { data, error } = await session.select(table, COLUMNS[table])
  if (error) throw new Error(error.message)
  const parsed = z.array(ROWS[table]).safeParse(data ?? [])
  if (!parsed.success) throw new UnexpectedRows()
  return parsed.data as z.infer<(typeof ROWS)[T]>[]
}

async function snapshotOf(session: SharedSession, now: Date): Promise<SharedSnapshot> {
  // Four reads, not one transaction: a change landing between them shows up on the next poll.
  const [profiles, lists, members, tasks] = await Promise.all([
    read(session, 'profiles'),
    read(session, 'lists'),
    read(session, 'list_members'),
    read(session, 'shared_tasks')
  ])
  const acceptedLists = new Set(members.filter((m) => m.email === session.email && m.accepted_at !== null).map((m) => m.list_id))
  return {
    userId: session.id,
    email: session.email,
    people: profiles.map(({ id, email, name }) => ({ id, email, name })),
    lists: lists.map((l) => ({
      id: l.id,
      name: l.name,
      ownerId: l.owner_id,
      createdAt: l.created_at,
      accepted: l.owner_id === session.id || acceptedLists.has(l.id)
    })),
    members: members.map((m) => ({ listId: m.list_id, email: m.email, addedAt: m.added_at, acceptedAt: m.accepted_at })),
    tasks: tasks.map((t) => ({
      id: t.id,
      listId: t.list_id,
      name: t.name,
      description: t.description,
      status: t.status,
      assigneeEmail: t.assignee_email,
      createdBy: t.created_by,
      createdAt: t.created_at,
      updatedBy: t.updated_by,
      updatedAt: t.updated_at
    })),
    syncedAt: now.toISOString()
  }
}

/** Tasks now assigned to the user that were not theirs before, and that someone else assigned. */
function newAssignments(previous: SharedSnapshot | null, next: SharedSnapshot): SharedAssignment[] {
  // Nothing to compare with on a first sync, or with a copy that belonged to another user.
  if (!previous || previous.userId !== next.userId) return []
  const before = new Map(previous.tasks.map((t) => [t.id, t.assigneeEmail]))
  return next.tasks
    .filter((t) => t.assigneeEmail === next.email && before.get(t.id) !== next.email)
    .filter((t) => (t.updatedBy ?? t.createdBy) !== next.userId)
    .map((task) => ({
      task,
      list: next.lists.find((l) => l.id === task.listId),
      by: next.people.find((p) => p.id === (task.updatedBy ?? task.createdBy))
    }))
}

/** Invitations waiting now that were not in the previous copy of the same user. */
function newInvitations(previous: SharedSnapshot | null, next: SharedSnapshot): SharedInvitation[] {
  if (!previous || previous.userId !== next.userId) return []
  const before = new Set(previous.lists.map((l) => l.id))
  return next.lists
    .filter((l) => !l.accepted && !before.has(l.id))
    .map((list) => ({ list, by: next.people.find((p) => p.id === list.ownerId) }))
}

/**
 * Keeps a local copy of the shared lists in step with Supabase by polling. Reads only: writes
 * go straight to Supabase and then call `refresh`.
 */
export class SharedSync {
  private current: SharedState
  private running: Promise<SharedState> | null = null
  private again: Promise<SharedState> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: SharedSyncDeps) {
    const stored = deps.cache.load()
    this.current = { signedIn: stored !== null, snapshot: stored }
  }

  state(): SharedState {
    return this.current
  }

  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.deps.intervalMs ?? SHARED_POLL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Syncs now. A call during a sync runs one more after it, because what it waits for (a write,
   * a sign-out) may have happened after the running sync read its rows.
   */
  refresh(): Promise<SharedState> {
    if (this.running) {
      this.again ??= this.running.then(() => {
        this.again = null
        return this.refresh()
      })
      return this.again
    }
    this.running = this.sync().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async sync(): Promise<SharedState> {
    let next: SharedState
    try {
      const session = await this.deps.source.session()
      if (!session) {
        this.deps.cache.clear()
        next = { signedIn: false, snapshot: null }
      } else {
        const snapshot = await snapshotOf(session, this.deps.now?.() ?? new Date())
        const assigned = newAssignments(this.current.snapshot, snapshot)
        const invited = newInvitations(this.current.snapshot, snapshot)
        this.deps.cache.save(snapshot)
        next = { signedIn: true, snapshot }
        if (assigned.length > 0) this.deps.assigned(assigned)
        if (invited.length > 0) this.deps.invited(invited)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      next = { signedIn: this.current.signedIn, snapshot: this.current.snapshot, error: `No se pudo sincronizar: ${message}` }
    }
    this.current = next
    this.deps.changed(next)
    return next
  }
}
