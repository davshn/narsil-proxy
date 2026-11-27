import { describe, expect, it } from 'vitest'
import type { SharedState } from '@shared/types'
import type { SharedSession, SharedWrite } from '../src/main/app/sharedAuth'
import { SharedActionSchema, SharedLists } from '../src/main/app/sharedLists'

const LIST = '11111111-1111-4111-8111-111111111111'
const TASK = '22222222-2222-4222-8222-222222222222'

const STATE: SharedState = { signedIn: true, snapshot: null }

interface Answer {
  error?: { message: string; code?: string } | null
  count?: number | null
}

function setup(options: { signedIn?: boolean; answer?: Answer } = {}) {
  const writes: SharedWrite[] = []
  let refreshes = 0
  const session: SharedSession = {
    id: 'u-ana',
    email: 'ana@gmail.com',
    select: async () => ({ data: [], error: null }),
    write: async (write) => {
      writes.push(write)
      const answer = options.answer ?? {}
      return { error: answer.error ?? null, count: answer.count === undefined ? 1 : answer.count }
    }
  }
  const lists = new SharedLists({
    source: { session: async () => (options.signedIn === false ? null : session) },
    sync: {
      refresh: async () => {
        refreshes += 1
        return STATE
      },
      state: () => STATE
    },
    now: () => new Date('2026-11-27T12:00:00Z')
  })
  return { lists, writes, refreshes: () => refreshes }
}

describe('SharedLists writes', () => {
  it('creates a list owned by the user, trimmed, and syncs', async () => {
    const { lists, writes, refreshes } = setup()
    expect(await lists.createList('  Casa ')).toEqual({ ok: true, state: STATE })
    expect(writes).toEqual([{ kind: 'insert', table: 'lists', values: { name: 'Casa', owner_id: 'u-ana' } }])
    expect(refreshes()).toBe(1)
  })

  it('renames and deletes a list by id', async () => {
    const { lists, writes } = setup()
    await lists.renameList(LIST, ' Casa nueva ')
    await lists.deleteList(LIST)
    expect(writes).toEqual([
      { kind: 'update', table: 'lists', values: { name: 'Casa nueva' }, match: { id: LIST } },
      { kind: 'delete', table: 'lists', match: { id: LIST } }
    ])
  })

  it('invites by email, lowercased and trimmed', async () => {
    const { lists, writes } = setup()
    await lists.invite(LIST, ' Luis@Gmail.com ')
    expect(writes).toEqual([{ kind: 'insert', table: 'list_members', values: { list_id: LIST, email: 'luis@gmail.com' } }])
  })

  it('accepts the user’s own invitation, and declining or leaving removes their own row', async () => {
    const { lists, writes } = setup()
    await lists.acceptInvitation(LIST)
    await lists.leave(LIST)
    expect(writes).toEqual([
      {
        kind: 'update',
        table: 'list_members',
        values: { accepted_at: '2026-11-27T12:00:00.000Z' },
        match: { list_id: LIST, email: 'ana@gmail.com' }
      },
      { kind: 'delete', table: 'list_members', match: { list_id: LIST, email: 'ana@gmail.com' } }
    ])
  })

  it('removes a member by email', async () => {
    const { lists, writes } = setup()
    await lists.removeMember(LIST, 'Luis@gmail.com')
    expect(writes).toEqual([{ kind: 'delete', table: 'list_members', match: { list_id: LIST, email: 'luis@gmail.com' } }])
  })

  it('adds a task created by the user, assigned or not', async () => {
    const { lists, writes } = setup()
    await lists.saveTask({ listId: LIST, name: ' Comprar pan ', description: ' Integral \n', assigneeEmail: 'Luis@gmail.com' })
    await lists.saveTask({ listId: LIST, name: 'Barrer', description: '', assigneeEmail: null })
    expect(writes).toEqual([
      {
        kind: 'insert',
        table: 'shared_tasks',
        values: { list_id: LIST, name: 'Comprar pan', description: 'Integral', assignee_email: 'luis@gmail.com', created_by: 'u-ana' }
      },
      {
        kind: 'insert',
        table: 'shared_tasks',
        values: { list_id: LIST, name: 'Barrer', description: '', assignee_email: null, created_by: 'u-ana' }
      }
    ])
  })

  it('edits a task without moving it to another list', async () => {
    const { lists, writes } = setup()
    await lists.saveTask({ id: TASK, listId: LIST, name: 'Pan', description: '', assigneeEmail: null })
    expect(writes).toEqual([
      { kind: 'update', table: 'shared_tasks', values: { name: 'Pan', description: '', assignee_email: null }, match: { id: TASK } }
    ])
  })

  it('changes a task’s status and deletes a task', async () => {
    const { lists, writes } = setup()
    await lists.setTaskStatus(TASK, 'in-progress')
    await lists.deleteTask(TASK)
    expect(writes).toEqual([
      { kind: 'update', table: 'shared_tasks', values: { status: 'in-progress' }, match: { id: TASK } },
      { kind: 'delete', table: 'shared_tasks', match: { id: TASK } }
    ])
  })
})

describe('SharedLists refusals', () => {
  it('needs a session, and writes nothing without one', async () => {
    const { lists, writes } = setup({ signedIn: false })
    expect(await lists.createList('Casa')).toEqual({ ok: false, error: 'Inicia sesión en Listas compartidas, en Ajustes.', state: STATE })
    expect(writes).toEqual([])
  })

  it('checks names, emails and ids before writing', async () => {
    const { lists, writes } = setup()
    expect((await lists.createList('   ')).error).toBe('Escribe un nombre.')
    expect((await lists.createList('x'.repeat(101))).error).toBe('El nombre de la lista admite hasta 100 caracteres.')
    expect((await lists.invite(LIST, 'luis')).error).toBe('Escribe un email válido.')
    expect((await lists.saveTask({ listId: LIST, name: 'x'.repeat(201), description: '', assigneeEmail: null })).error).toBe(
      'El nombre de la tarea admite hasta 200 caracteres.'
    )
    expect((await lists.saveTask({ listId: LIST, name: 'Pan', description: 'x'.repeat(5001), assigneeEmail: null })).error).toBe(
      'La descripción admite hasta 5000 caracteres.'
    )
    expect((await lists.deleteTask('not-an-id')).error).toBe('Esa tarea no existe.')
    expect(writes).toEqual([])
  })

  it('reports a change the database rules refused, which touches no row', async () => {
    const { lists, refreshes } = setup({ answer: { count: 0 } })
    expect(await lists.deleteTask(TASK)).toEqual({
      ok: false,
      error: 'No se hizo el cambio: no tienes permiso o ya no existe.',
      state: STATE
    })
    expect(refreshes()).toBe(1)
  })

  it('explains the database errors a person can run into', async () => {
    const cases: [Answer['error'], string][] = [
      [{ message: 'new row violates row-level security policy', code: '42501' }, 'No tienes permiso para hacer eso en esta lista.'],
      [{ message: 'duplicate key value', code: '23505' }, 'Esa persona ya está invitada a la lista.'],
      [
        { message: 'insert or update violates foreign key constraint', code: '23503' },
        'Solo puedes asignar tareas a miembros que aceptaron la invitación.'
      ],
      [{ message: 'El dueño no puede salir de su propia lista.', code: 'P0001' }, 'El dueño no puede salir de su propia lista.'],
      [{ message: 'TypeError: fetch failed' }, 'No se pudo guardar el cambio: TypeError: fetch failed']
    ]
    for (const [error, message] of cases) {
      const { lists } = setup({ answer: { error } })
      expect((await lists.createList('Casa')).error).toBe(message)
    }
  })
})

describe('SharedLists.apply', () => {
  it('runs an action from the screens or Claude by its type', async () => {
    const { lists, writes } = setup()
    await lists.apply({ type: 'setTaskStatus', taskId: TASK, status: 'done' })
    await lists.apply({ type: 'invite', listId: LIST, email: 'luis@gmail.com' })
    expect(writes.map((w) => [w.kind, w.table])).toEqual([
      ['update', 'shared_tasks'],
      ['insert', 'list_members']
    ])
  })

  it('accepts only known actions with their fields', () => {
    expect(SharedActionSchema.safeParse({ type: 'deleteTask', taskId: TASK }).success).toBe(true)
    expect(SharedActionSchema.safeParse({ type: 'dropTable', table: 'lists' }).success).toBe(false)
    expect(SharedActionSchema.safeParse({ type: 'setTaskStatus', taskId: TASK, status: 'archived' }).success).toBe(false)
    expect(SharedActionSchema.safeParse({ type: 'saveTask', task: { listId: LIST, name: 'Pan' } }).success).toBe(false)
  })
})
