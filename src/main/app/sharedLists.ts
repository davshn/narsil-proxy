import { z } from 'zod'
import {
  TASK_STATUSES,
  type SharedAction,
  type SharedActionResult,
  type SharedState,
  type SharedTaskInput,
  type TaskStatus
} from '@shared/types'
import type { SharedSession, SharedWrite } from './sharedAuth'
import type { SharedSource } from './sharedSync'

/** The database checks these too; checking first gives a clear message. */
export const MAX_LIST_NAME = 100
export const MAX_SHARED_TASK_NAME = 200
export const MAX_SHARED_TASK_DESCRIPTION = 5000
const MAX_EMAIL = 320

export interface SharedListsDeps {
  source: SharedSource
  sync: { refresh(): Promise<SharedState>; state(): SharedState }
  now?: () => Date
}

const Text = z.string().max(10_000)

/** Checks the shape of an action from the renderer or MCP; its values are checked by each change. */
export const SharedActionSchema: z.ZodType<SharedAction> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('createList'), name: Text }),
  z.object({ type: z.literal('renameList'), listId: Text, name: Text }),
  z.object({ type: z.literal('deleteList'), listId: Text }),
  z.object({ type: z.literal('invite'), listId: Text, email: Text }),
  z.object({ type: z.literal('acceptInvitation'), listId: Text }),
  z.object({ type: z.literal('leave'), listId: Text }),
  z.object({ type: z.literal('removeMember'), listId: Text, email: Text }),
  z.object({
    type: z.literal('saveTask'),
    task: z.object({ id: Text.optional(), listId: Text, name: Text, description: Text, assigneeEmail: Text.nullable() })
  }),
  z.object({ type: z.literal('setTaskStatus'), taskId: Text, status: z.enum(TASK_STATUSES) }),
  z.object({ type: z.literal('deleteTask'), taskId: Text })
])

/** A message for the person; thrown before anything is written. */
class Refused extends Error {}

const Uuid = z.string().uuid()

function id(value: string, what: string): string {
  if (!Uuid.safeParse(value).success) throw new Refused(`${what} no existe.`)
  return value
}

function name(value: string, max: number, what: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Refused('Escribe un nombre.')
  if (trimmed.length > max) throw new Refused(`El nombre de ${what} admite hasta ${max} caracteres.`)
  return trimmed
}

function email(value: string): string {
  const trimmed = value.trim().toLowerCase()
  if (trimmed.length > MAX_EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw new Refused('Escribe un email válido.')
  return trimmed
}

function description(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length > MAX_SHARED_TASK_DESCRIPTION) {
    throw new Refused(`La descripción admite hasta ${MAX_SHARED_TASK_DESCRIPTION} caracteres.`)
  }
  return trimmed
}

/** What a database error means for the person. Trigger messages are already written for them. */
function explain(error: { message: string; code?: string }): string {
  switch (error.code) {
    case '42501':
      return 'No tienes permiso para hacer eso en esta lista.'
    case '23505':
      return 'Esa persona ya está invitada a la lista.'
    case '23503':
      return 'Solo puedes asignar tareas a miembros que aceptaron la invitación.'
    case 'P0001':
      return error.message
    default:
      return `No se pudo guardar el cambio: ${error.message}`
  }
}

/**
 * Changes to the shared lists, written with the signed-in user's session. The database's row
 * level security decides what is allowed; each change is followed by a sync.
 */
export class SharedLists {
  constructor(private readonly deps: SharedListsDeps) {}

  /** Runs one action by its type. */
  apply(action: SharedAction): Promise<SharedActionResult> {
    switch (action.type) {
      case 'createList':
        return this.createList(action.name)
      case 'renameList':
        return this.renameList(action.listId, action.name)
      case 'deleteList':
        return this.deleteList(action.listId)
      case 'invite':
        return this.invite(action.listId, action.email)
      case 'acceptInvitation':
        return this.acceptInvitation(action.listId)
      case 'leave':
        return this.leave(action.listId)
      case 'removeMember':
        return this.removeMember(action.listId, action.email)
      case 'saveTask':
        return this.saveTask(action.task)
      case 'setTaskStatus':
        return this.setTaskStatus(action.taskId, action.status)
      case 'deleteTask':
        return this.deleteTask(action.taskId)
    }
  }

  createList(listName: string): Promise<SharedActionResult> {
    return this.run((me) => ({
      kind: 'insert',
      table: 'lists',
      values: { name: name(listName, MAX_LIST_NAME, 'la lista'), owner_id: me.id }
    }))
  }

  renameList(listId: string, listName: string): Promise<SharedActionResult> {
    return this.run(() => ({
      kind: 'update',
      table: 'lists',
      values: { name: name(listName, MAX_LIST_NAME, 'la lista') },
      match: { id: id(listId, 'Esa lista') }
    }))
  }

  deleteList(listId: string): Promise<SharedActionResult> {
    return this.run(() => ({ kind: 'delete', table: 'lists', match: { id: id(listId, 'Esa lista') } }))
  }

  invite(listId: string, address: string): Promise<SharedActionResult> {
    return this.run(() => ({
      kind: 'insert',
      table: 'list_members',
      values: { list_id: id(listId, 'Esa lista'), email: email(address) }
    }))
  }

  acceptInvitation(listId: string): Promise<SharedActionResult> {
    return this.run((me) => ({
      kind: 'update',
      table: 'list_members',
      values: { accepted_at: (this.deps.now?.() ?? new Date()).toISOString() },
      match: { list_id: id(listId, 'Esa lista'), email: me.email }
    }))
  }

  /** Declining an invitation is leaving too: both delete the user's own row. */
  leave(listId: string): Promise<SharedActionResult> {
    return this.run((me) => ({ kind: 'delete', table: 'list_members', match: { list_id: id(listId, 'Esa lista'), email: me.email } }))
  }

  removeMember(listId: string, address: string): Promise<SharedActionResult> {
    return this.run(() => ({
      kind: 'delete',
      table: 'list_members',
      match: { list_id: id(listId, 'Esa lista'), email: email(address) }
    }))
  }

  saveTask(input: SharedTaskInput): Promise<SharedActionResult> {
    return this.run((me) => {
      const values = {
        name: name(input.name, MAX_SHARED_TASK_NAME, 'la tarea'),
        description: description(input.description),
        assignee_email: input.assigneeEmail === null ? null : email(input.assigneeEmail)
      }
      const listId = id(input.listId, 'Esa lista')
      if (input.id !== undefined) return { kind: 'update', table: 'shared_tasks', values, match: { id: id(input.id, 'Esa tarea') } }
      return { kind: 'insert', table: 'shared_tasks', values: { list_id: listId, ...values, created_by: me.id } }
    })
  }

  setTaskStatus(taskId: string, status: TaskStatus): Promise<SharedActionResult> {
    return this.run(() => ({ kind: 'update', table: 'shared_tasks', values: { status }, match: { id: id(taskId, 'Esa tarea') } }))
  }

  deleteTask(taskId: string): Promise<SharedActionResult> {
    return this.run(() => ({ kind: 'delete', table: 'shared_tasks', match: { id: id(taskId, 'Esa tarea') } }))
  }

  /** Builds the write from the signed-in user, runs it, then syncs so the lists show it. */
  private async run(build: (me: SharedSession) => SharedWrite): Promise<SharedActionResult> {
    let me: SharedSession | null
    let write: SharedWrite
    try {
      me = await this.deps.source.session()
      if (!me) return { ok: false, error: 'Inicia sesión en Listas compartidas, en Ajustes.', state: this.deps.sync.state() }
      write = build(me)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), state: this.deps.sync.state() }
    }
    let failure: string | null = null
    try {
      const { error, count } = await me.write(write)
      if (error) failure = explain(error)
      else if (write.kind !== 'insert' && count === 0) failure = 'No se hizo el cambio: no tienes permiso o ya no existe.'
    } catch (error) {
      failure = `No se pudo guardar el cambio: ${error instanceof Error ? error.message : String(error)}`
    }
    const state = await this.deps.sync.refresh()
    return failure ? { ok: false, error: failure, state } : { ok: true, state }
  }
}
