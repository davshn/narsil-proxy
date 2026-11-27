import { describe, expect, it } from 'vitest'
import type { SharedAction, SharedActionResult, SharedSnapshot, SharedState, SharedTask } from '@shared/types'
import { createSharedMcpHandlers, type SharedMcpDeps } from '../src/main/app/mcpSharedTools'
import { MCP_TOOLS } from '../src/mcp/protocol'

const ANA = { id: 'u-ana', email: 'ana@gmail.com', name: 'Ana Pérez' }
const LUIS = { id: 'u-luis', email: 'luis@gmail.com', name: 'Luis Gómez' }
const LUISA = { id: 'u-luisa', email: 'luisa@gmail.com', name: 'Luisa Díaz' }
const LUIS2 = { id: 'u-luis2', email: 'luis.m@gmail.com', name: 'Luis Martín' }
const CASA = '11111111-1111-4111-8111-111111111111'
const CLUB = '33333333-3333-4333-8333-333333333333'
const T1 = '22222222-2222-4222-8222-222222222222'

function task(fields: Partial<SharedTask> = {}): SharedTask {
  return {
    id: T1,
    listId: CASA,
    name: 'Comprar pan',
    description: 'Integral',
    status: 'todo',
    assigneeEmail: LUIS.email,
    createdBy: ANA.id,
    createdAt: '2026-11-27T09:00:00Z',
    updatedBy: LUIS.id,
    updatedAt: '2026-11-27T10:00:00Z',
    ...fields
  }
}

function snapshot(tasks: SharedTask[] = [task()]): SharedSnapshot {
  const accepted = (email: string) => ({ listId: CASA, email, addedAt: '2026-11-27T08:00:00Z', acceptedAt: '2026-11-27T08:00:00Z' })
  return {
    userId: ANA.id,
    email: ANA.email,
    people: [ANA, LUIS, LUISA, LUIS2],
    lists: [
      { id: CASA, name: 'Casa', ownerId: ANA.id, createdAt: '2026-11-27T08:00:00Z', accepted: true },
      { id: CLUB, name: 'Club', ownerId: LUIS.id, createdAt: '2026-11-27T08:10:00Z', accepted: false }
    ],
    members: [
      accepted(ANA.email),
      accepted(LUIS.email),
      accepted(LUISA.email),
      accepted(LUIS2.email),
      { listId: CASA, email: 'nuevo@gmail.com', addedAt: '2026-11-27T08:20:00Z', acceptedAt: null },
      { listId: CLUB, email: ANA.email, addedAt: '2026-11-27T08:10:00Z', acceptedAt: null }
    ],
    tasks,
    syncedAt: '2026-11-27T12:00:00Z'
  }
}

function setup(options: { state?: SharedState; refused?: string; after?: SharedSnapshot } = {}) {
  let state: SharedState = options.state ?? { signedIn: true, snapshot: snapshot() }
  const actions: SharedAction[] = []
  let refreshes = 0
  const deps: SharedMcpDeps = {
    apply: async (action): Promise<SharedActionResult> => {
      actions.push(action)
      if (options.after) state = { signedIn: true, snapshot: options.after }
      return options.refused ? { ok: false, error: options.refused, state } : { ok: true, state }
    },
    refresh: async () => {
      refreshes += 1
      return state
    },
    state: () => state
  }
  return { handlers: createSharedMcpHandlers(deps), actions, refreshes: () => refreshes }
}

describe('get_shared_lists', () => {
  it('syncs first, then shows each list with its members and tasks by name, and the invitations', async () => {
    const { handlers, refreshes } = setup()
    const result = await handlers.get_shared_lists({})
    expect(refreshes()).toBe(1)
    expect(result).toEqual({
      me: ANA.email,
      invitations: [{ listId: CLUB, name: 'Club', owner: { email: LUIS.email, name: LUIS.name } }],
      lists: [
        {
          id: CASA,
          name: 'Casa',
          owner: { email: ANA.email, name: ANA.name },
          youOwnIt: true,
          members: [
            { email: ANA.email, name: ANA.name, accepted: true },
            { email: LUIS.email, name: LUIS.name, accepted: true },
            { email: LUISA.email, name: LUISA.name, accepted: true },
            { email: LUIS2.email, name: LUIS2.name, accepted: true },
            { email: 'nuevo@gmail.com', name: '', accepted: false }
          ],
          tasks: [
            {
              id: T1,
              name: 'Comprar pan',
              description: 'Integral',
              status: 'todo',
              assignee: { email: LUIS.email, name: LUIS.name },
              createdBy: { email: ANA.email, name: ANA.name },
              lastChange: { by: { email: LUIS.email, name: LUIS.name }, at: '2026-11-27T10:00:00Z' }
            }
          ]
        }
      ]
    })
  })

  it('says how to sign in when nobody is signed in', async () => {
    const { handlers } = setup({ state: { signedIn: false, snapshot: null } })
    expect(await handlers.get_shared_lists({})).toEqual({
      signedIn: false,
      message: 'Shared lists are not signed in. Ask the user to sign in under Ajustes, Listas compartidas.'
    })
  })

  it('says when the lists are the last stored copy because the sync failed', async () => {
    const { handlers } = setup({ state: { signedIn: true, snapshot: snapshot(), error: 'No se pudo sincronizar: fetch failed' } })
    const result = (await handlers.get_shared_lists({})) as { syncError?: string }
    expect(result.syncError).toBe('No se pudo sincronizar: fetch failed. This is the last stored copy.')
  })
})

describe('list and member tools', () => {
  it('runs each one as the matching action', async () => {
    const { handlers, actions } = setup()
    await handlers.create_shared_list({ name: 'Oficina' })
    await handlers.rename_shared_list({ listId: CASA, name: 'Hogar' })
    await handlers.invite_to_shared_list({ listId: CASA, email: 'marta@gmail.com' })
    await handlers.remove_shared_member({ listId: CASA, email: LUIS.email })
    await handlers.answer_shared_invitation({ listId: CLUB, accept: true })
    await handlers.answer_shared_invitation({ listId: CLUB, accept: false })
    await handlers.leave_shared_list({ listId: CASA })
    await handlers.delete_shared_list({ listId: CASA })
    expect(actions).toEqual([
      { type: 'createList', name: 'Oficina' },
      { type: 'renameList', listId: CASA, name: 'Hogar' },
      { type: 'invite', listId: CASA, email: 'marta@gmail.com' },
      { type: 'removeMember', listId: CASA, email: LUIS.email },
      { type: 'acceptInvitation', listId: CLUB },
      { type: 'leave', listId: CLUB },
      { type: 'leave', listId: CASA },
      { type: 'deleteList', listId: CASA }
    ])
  })

  it('answers with the list after the change', async () => {
    const { handlers } = setup()
    const result = (await handlers.rename_shared_list({ listId: CASA, name: 'Hogar' })) as { id: string; name: string }
    expect(result).toMatchObject({ id: CASA, name: 'Casa' })
  })

  it('fails with the reason when the change is refused', async () => {
    const { handlers } = setup({ refused: 'No tienes permiso para hacer eso en esta lista.' })
    await expect(handlers.delete_shared_list({ listId: CASA })).rejects.toThrow('No tienes permiso para hacer eso en esta lista.')
  })

  it('checks the arguments against the tool’s schema', async () => {
    const { handlers, actions } = setup()
    await expect(handlers.create_shared_list({ name: 'Casa', owner: 'u-luis' })).rejects.toThrow()
    await expect(handlers.answer_shared_invitation({ listId: CLUB })).rejects.toThrow()
    expect(actions).toEqual([])
  })
})

describe('save_shared_task', () => {
  it('adds a task assigned by email, and answers with the new task', async () => {
    const created = task({ id: '44444444-4444-4444-8444-444444444444', name: 'Barrer', description: '', assigneeEmail: LUISA.email, updatedBy: ANA.id })
    const { handlers, actions } = setup({ after: snapshot([task(), created]) })
    const result = await handlers.save_shared_task({ listId: CASA, name: 'Barrer', assignee: 'Luisa@gmail.com' })
    expect(actions).toEqual([
      { type: 'saveTask', task: { listId: CASA, name: 'Barrer', description: '', assigneeEmail: LUISA.email } }
    ])
    expect(result).toMatchObject({ id: created.id, name: 'Barrer', assignee: { email: LUISA.email } })
  })

  it('assigns by full name or first name, ignoring case and accents', async () => {
    const { handlers, actions } = setup()
    await handlers.save_shared_task({ listId: CASA, name: 'A', assignee: 'luisa diaz' })
    await handlers.save_shared_task({ listId: CASA, name: 'B', assignee: 'ANA' })
    expect(actions.map((a) => (a.type === 'saveTask' ? a.task.assigneeEmail : null))).toEqual([LUISA.email, ANA.email])
  })

  it('refuses an ambiguous name and lists who it could be, so Claude asks the user', async () => {
    const { handlers, actions } = setup()
    await expect(handlers.save_shared_task({ listId: CASA, name: 'Pan', assignee: 'Luis' })).rejects.toThrow(
      'More than one member matches "Luis": Luis Gómez (luis@gmail.com), Luis Martín (luis.m@gmail.com). Ask the user which one, then pass their email.'
    )
    expect(actions).toEqual([])
  })

  it('refuses a name nobody who accepted the list has', async () => {
    const { handlers } = setup()
    await expect(handlers.save_shared_task({ listId: CASA, name: 'Pan', assignee: 'nuevo@gmail.com' })).rejects.toThrow(
      'No member of "Casa" who accepted the invitation matches "nuevo@gmail.com". Members: Ana Pérez (ana@gmail.com), Luis Gómez (luis@gmail.com), Luisa Díaz (luisa@gmail.com), Luis Martín (luis.m@gmail.com).'
    )
  })

  it('edits only the fields sent, keeping the rest of the task, and null unassigns', async () => {
    const { handlers, actions } = setup()
    await handlers.save_shared_task({ id: T1, name: 'Comprar pan y leche' })
    await handlers.save_shared_task({ id: T1, assignee: null })
    expect(actions).toEqual([
      { type: 'saveTask', task: { id: T1, listId: CASA, name: 'Comprar pan y leche', description: 'Integral', assigneeEmail: LUIS.email } },
      { type: 'saveTask', task: { id: T1, listId: CASA, name: 'Comprar pan', description: 'Integral', assigneeEmail: null } }
    ])
  })

  it('needs a list and a name for a new task, and an existing id to edit', async () => {
    const { handlers, actions } = setup()
    await expect(handlers.save_shared_task({ name: 'Pan' })).rejects.toThrow('A new shared task needs listId and name.')
    await expect(handlers.save_shared_task({ id: '55555555-5555-4555-8555-555555555555', name: 'Pan' })).rejects.toThrow(
      'That shared task does not exist. Call get_shared_lists for the current ids.'
    )
    expect(actions).toEqual([])
  })
})

describe('task status and deletion', () => {
  it('changes the status and answers with the task, and deletes by id', async () => {
    const { handlers, actions } = setup()
    expect(await handlers.set_shared_task_status({ id: T1, status: 'done' })).toMatchObject({ id: T1 })
    expect(await handlers.delete_shared_task({ id: T1 })).toEqual({ deleted: T1 })
    expect(actions).toEqual([
      { type: 'setTaskStatus', taskId: T1, status: 'done' },
      { type: 'deleteTask', taskId: T1 }
    ])
  })
})

describe('shared tool specs', () => {
  it('marks every tool that deletes something as destructive and asks Claude to confirm', () => {
    for (const name of ['delete_shared_list', 'remove_shared_member', 'leave_shared_list', 'delete_shared_task'] as const) {
      expect(MCP_TOOLS[name].annotations.destructiveHint).toBe(true)
      expect(MCP_TOOLS[name].description).toContain('Confirm with the user first.')
    }
    expect(MCP_TOOLS.get_shared_lists.annotations.readOnlyHint).toBe(true)
  })
})
