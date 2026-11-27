import { describe, expect, it } from 'vitest'
import type { SharedSnapshot, SharedTask } from '@shared/types'
import {
  assignedToMe,
  canChange,
  canDelete,
  changedLabel,
  invitations,
  memberLabel,
  membersOf,
  ownedByMe,
  personLabel,
  sortSharedTasks,
  workLists
} from '../src/renderer/src/components/sharedView'

const ANA = { id: 'u-ana', email: 'ana@gmail.com', name: 'Ana Pérez' }
const LUIS = { id: 'u-luis', email: 'luis@gmail.com', name: 'Luis Gómez' }
const SIN_NOMBRE = { id: 'u-eva', email: 'eva@gmail.com', name: '' }

function task(id: string, fields: Partial<SharedTask> = {}): SharedTask {
  return {
    id,
    listId: 'l-casa',
    name: id,
    description: '',
    status: 'todo',
    assigneeEmail: null,
    createdBy: LUIS.id,
    createdAt: '2026-11-27T09:00:00Z',
    updatedBy: LUIS.id,
    updatedAt: '2026-11-27T09:00:00Z',
    ...fields
  }
}

const SNAPSHOT: SharedSnapshot = {
  userId: ANA.id,
  email: ANA.email,
  people: [ANA, LUIS, SIN_NOMBRE],
  lists: [
    { id: 'l-casa', name: 'Casa', ownerId: LUIS.id, createdAt: '2026-11-27T08:00:00Z', accepted: true },
    { id: 'l-mia', name: 'Mía', ownerId: ANA.id, createdAt: '2026-11-27T08:30:00Z', accepted: true },
    { id: 'l-club', name: 'Club', ownerId: LUIS.id, createdAt: '2026-11-27T08:10:00Z', accepted: false }
  ],
  members: [
    { listId: 'l-casa', email: LUIS.email, addedAt: '2026-11-27T08:00:00Z', acceptedAt: '2026-11-27T08:00:00Z' },
    { listId: 'l-casa', email: ANA.email, addedAt: '2026-11-27T08:01:00Z', acceptedAt: '2026-11-27T08:02:00Z' },
    { listId: 'l-casa', email: 'nuevo@gmail.com', addedAt: '2026-11-27T08:03:00Z', acceptedAt: null },
    { listId: 'l-casa', email: SIN_NOMBRE.email, addedAt: '2026-11-27T08:04:00Z', acceptedAt: '2026-11-27T08:05:00Z' },
    { listId: 'l-club', email: ANA.email, addedAt: '2026-11-27T08:10:00Z', acceptedAt: null }
  ],
  tasks: [],
  syncedAt: '2026-11-27T12:00:00Z'
}

describe('names', () => {
  it('shows a person by name, by email when they have none, and as "tú" for the user', () => {
    expect(personLabel(SNAPSHOT, LUIS.id)).toBe('Luis Gómez')
    expect(personLabel(SNAPSHOT, SIN_NOMBRE.id)).toBe('eva@gmail.com')
    expect(personLabel(SNAPSHOT, ANA.id)).toBe('tú')
    expect(personLabel(SNAPSHOT, 'u-gone')).toBe('alguien que ya no está')
    expect(personLabel(SNAPSHOT, null)).toBe('alguien que ya no está')
  })

  it('shows a member by name or email', () => {
    expect(memberLabel(SNAPSHOT, LUIS.email)).toBe('Luis Gómez')
    expect(memberLabel(SNAPSHOT, 'nuevo@gmail.com')).toBe('nuevo@gmail.com')
    expect(memberLabel(SNAPSHOT, ANA.email)).toBe('Ana Pérez (tú)')
  })
})

describe('lists', () => {
  it('separates the lists the user works in from the invitations waiting for an answer', () => {
    expect(workLists(SNAPSHOT).map((l) => l.name)).toEqual(['Casa', 'Mía'])
    expect(invitations(SNAPSHOT).map((l) => l.name)).toEqual(['Club'])
    expect(ownedByMe(SNAPSHOT, SNAPSHOT.lists[1]!)).toBe(true)
    expect(ownedByMe(SNAPSHOT, SNAPSHOT.lists[0]!)).toBe(false)
  })

  it('lists members who accepted first, then pending invitations, each by when they were added', () => {
    expect(membersOf(SNAPSHOT, 'l-casa').map((m) => [m.email, m.acceptedAt !== null])).toEqual([
      [LUIS.email, true],
      [ANA.email, true],
      [SIN_NOMBRE.email, true],
      ['nuevo@gmail.com', false]
    ])
  })
})

describe('permissions', () => {
  it('lets the assignee and the creator change a task, as the database does', () => {
    expect(canChange(SNAPSHOT, task('a', { assigneeEmail: ANA.email }))).toBe(true)
    expect(canChange(SNAPSHOT, task('b', { createdBy: ANA.id }))).toBe(true)
    expect(canChange(SNAPSHOT, task('c', { assigneeEmail: LUIS.email }))).toBe(false)
  })

  it('lets the creator and the list owner delete a task', () => {
    expect(canDelete(SNAPSHOT, task('a', { createdBy: ANA.id }))).toBe(true)
    expect(canDelete(SNAPSHOT, task('b', { listId: 'l-mia' }))).toBe(true)
    expect(canDelete(SNAPSHOT, task('c', { assigneeEmail: ANA.email }))).toBe(false)
  })
})

describe('assignedToMe', () => {
  it('counts unfinished tasks assigned to the user in lists they accepted', () => {
    const snapshot: SharedSnapshot = {
      ...SNAPSHOT,
      tasks: [
        task('a', { assigneeEmail: ANA.email }),
        task('b', { assigneeEmail: ANA.email, status: 'in-progress' }),
        task('c', { assigneeEmail: ANA.email, status: 'done' }),
        task('d', { assigneeEmail: LUIS.email }),
        task('e', { assigneeEmail: ANA.email, listId: 'l-club' })
      ]
    }
    expect(assignedToMe(snapshot)).toBe(2)
    expect(assignedToMe(null)).toBe(0)
  })
})

describe('sortSharedTasks', () => {
  it('puts unfinished tasks first, then finished ones, each with the latest change first', () => {
    const tasks = [
      task('old', { updatedAt: '2026-11-27T08:00:00Z' }),
      task('done', { status: 'done', updatedAt: '2026-11-27T11:00:00Z' }),
      task('new', { updatedAt: '2026-11-27T10:00:00Z' }),
      task('done-old', { status: 'done', updatedAt: '2026-11-27T07:00:00Z' })
    ]
    expect(sortSharedTasks(tasks).map((t) => t.id)).toEqual(['new', 'old', 'done', 'done-old'])
  })
})

describe('changedLabel', () => {
  const now = new Date(2026, 10, 27, 15, 0)
  const at = (d: Date): string => d.toISOString()

  it('says who changed a task last and when, today, yesterday or on a date', () => {
    expect(changedLabel(SNAPSHOT, task('a', { updatedAt: at(new Date(2026, 10, 27, 10, 5)) }), now)).toBe(
      'Último cambio: Luis Gómez, hoy a las 10:05'
    )
    expect(changedLabel(SNAPSHOT, task('b', { updatedBy: ANA.id, updatedAt: at(new Date(2026, 10, 26, 9, 30)) }), now)).toBe(
      'Último cambio: tú, ayer a las 09:30'
    )
    expect(changedLabel(SNAPSHOT, task('c', { updatedAt: at(new Date(2026, 10, 20, 18, 0)) }), now)).toBe(
      'Último cambio: Luis Gómez, el 20 nov a las 18:00'
    )
  })
})
