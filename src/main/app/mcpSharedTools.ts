import type { SharedAction, SharedActionResult, SharedList, SharedSnapshot, SharedState, SharedTask } from '@shared/types'
import { parseToolArgs as parse } from '../../mcp/protocol'

/** What the MCP tools use of the shared lists: the same changes and sync the screens use. */
export interface SharedMcpDeps {
  apply(action: SharedAction): Promise<SharedActionResult>
  refresh(): Promise<SharedState>
  state(): SharedState
}

export type SharedToolName =
  | 'get_shared_lists'
  | 'create_shared_list'
  | 'rename_shared_list'
  | 'delete_shared_list'
  | 'invite_to_shared_list'
  | 'answer_shared_invitation'
  | 'remove_shared_member'
  | 'leave_shared_list'
  | 'save_shared_task'
  | 'set_shared_task_status'
  | 'delete_shared_task'

type Handler = (args: Record<string, unknown>) => Promise<unknown>

interface PersonOut {
  email: string
  name: string
}

const NOT_SIGNED_IN = 'Shared lists are not signed in. Ask the user to sign in under Ajustes, Listas compartidas.'

function person(snapshot: SharedSnapshot, id: string | null): PersonOut | null {
  const found = snapshot.people.find((p) => p.id === id)
  return found ? { email: found.email, name: found.name } : null
}

const nameOf = (snapshot: SharedSnapshot, email: string): string => snapshot.people.find((p) => p.email === email)?.name ?? ''

function taskOut(snapshot: SharedSnapshot, task: SharedTask): Record<string, unknown> {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    status: task.status,
    assignee: task.assigneeEmail ? { email: task.assigneeEmail, name: nameOf(snapshot, task.assigneeEmail) } : null,
    createdBy: person(snapshot, task.createdBy),
    lastChange: { by: person(snapshot, task.updatedBy), at: task.updatedAt }
  }
}

/** Members who accepted, then pending invitations, each in the order they were added. */
function members(snapshot: SharedSnapshot, listId: string): SharedSnapshot['members'] {
  const pending = (accepted: string | null): number => (accepted === null ? 1 : 0)
  return snapshot.members
    .filter((m) => m.listId === listId)
    .sort((a, b) => pending(a.acceptedAt) - pending(b.acceptedAt) || a.addedAt.localeCompare(b.addedAt))
}

function listOut(snapshot: SharedSnapshot, list: SharedList): Record<string, unknown> {
  return {
    id: list.id,
    name: list.name,
    owner: person(snapshot, list.ownerId),
    youOwnIt: list.ownerId === snapshot.userId,
    members: members(snapshot, list.id).map((m) => ({ email: m.email, name: nameOf(snapshot, m.email), accepted: m.acceptedAt !== null })),
    tasks: snapshot.tasks.filter((t) => t.listId === list.id).map((t) => taskOut(snapshot, t))
  }
}

/** Compares names the way people type them: no case, no accents, single spaces. */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')

/**
 * The email of the accepted member `query` names: their email, their full name or their first
 * name. Fails when nobody or more than one person matches, so Claude asks the user.
 */
function resolveAssignee(snapshot: SharedSnapshot, list: SharedList, query: string): string {
  const accepted = members(snapshot, list.id).filter((m) => m.acceptedAt !== null)
  const people = accepted.map((m) => ({ email: m.email, name: nameOf(snapshot, m.email) }))
  const wanted = fold(query)
  const tiers = [
    people.filter((p) => p.email === wanted),
    people.filter((p) => p.name && fold(p.name) === wanted),
    people.filter((p) => p.name && fold(p.name).split(' ')[0] === wanted)
  ]
  const matches = tiers.find((tier) => tier.length > 0) ?? []
  const describe = (list: PersonOut[]): string => list.map((p) => (p.name ? `${p.name} (${p.email})` : p.email)).join(', ')
  if (matches.length === 1) return matches[0]!.email
  if (matches.length > 1) {
    throw new Error(`More than one member matches "${query}": ${describe(matches)}. Ask the user which one, then pass their email.`)
  }
  throw new Error(`No member of "${list.name}" who accepted the invitation matches "${query}". Members: ${describe(people)}.`)
}

/** The MCP tools for shared lists. Every change goes through the same path as the screens. */
export function createSharedMcpHandlers(deps: SharedMcpDeps): Record<SharedToolName, Handler> {
  const snapshotNow = (): SharedSnapshot => {
    const { snapshot } = deps.state()
    if (!snapshot) throw new Error(NOT_SIGNED_IN)
    return snapshot
  }

  /** Runs a change; a refusal becomes the error Claude reads. Answers with the lists after it. */
  const run = async (action: SharedAction): Promise<SharedSnapshot | null> => {
    const result = await deps.apply(action)
    if (!result.ok) throw new Error(result.error ?? 'The change was not saved.')
    return result.state.snapshot
  }

  const listAfter = (snapshot: SharedSnapshot | null, listId: string): unknown => {
    const list = snapshot?.lists.find((l) => l.id === listId)
    return list && snapshot ? listOut(snapshot, list) : { listId }
  }

  const taskAfter = (snapshot: SharedSnapshot | null, id: string | undefined): unknown => {
    const task = snapshot?.tasks.find((t) => t.id === id)
    return task && snapshot ? taskOut(snapshot, task) : { id }
  }

  return {
    get_shared_lists: async (args) => {
      parse('get_shared_lists', args)
      const state = await deps.refresh()
      if (!state.signedIn || !state.snapshot) return { signedIn: false, message: NOT_SIGNED_IN }
      const { snapshot } = state
      return {
        me: snapshot.email,
        ...(state.error ? { syncError: `${state.error}. This is the last stored copy.` } : {}),
        invitations: snapshot.lists
          .filter((l) => !l.accepted)
          .map((l) => ({ listId: l.id, name: l.name, owner: person(snapshot, l.ownerId) })),
        lists: snapshot.lists.filter((l) => l.accepted).map((l) => listOut(snapshot, l))
      }
    },
    create_shared_list: async (args) => {
      const { name } = parse('create_shared_list', args)
      const before = new Set(snapshotNow().lists.map((l) => l.id))
      const after = await run({ type: 'createList', name })
      const created = after?.lists.find((l) => !before.has(l.id))
      return created && after ? listOut(after, created) : { created: name }
    },
    rename_shared_list: async (args) => {
      const { listId, name } = parse('rename_shared_list', args)
      return listAfter(await run({ type: 'renameList', listId, name }), listId)
    },
    delete_shared_list: async (args) => {
      const { listId } = parse('delete_shared_list', args)
      await run({ type: 'deleteList', listId })
      return { deleted: listId }
    },
    invite_to_shared_list: async (args) => {
      const { listId, email } = parse('invite_to_shared_list', args)
      return listAfter(await run({ type: 'invite', listId, email }), listId)
    },
    answer_shared_invitation: async (args) => {
      const { listId, accept } = parse('answer_shared_invitation', args)
      if (!accept) {
        await run({ type: 'leave', listId })
        return { declined: listId }
      }
      return listAfter(await run({ type: 'acceptInvitation', listId }), listId)
    },
    remove_shared_member: async (args) => {
      const { listId, email } = parse('remove_shared_member', args)
      return listAfter(await run({ type: 'removeMember', listId, email }), listId)
    },
    leave_shared_list: async (args) => {
      const { listId } = parse('leave_shared_list', args)
      await run({ type: 'leave', listId })
      return { left: listId }
    },
    save_shared_task: async (args) => {
      const input = parse('save_shared_task', args)
      const snapshot = snapshotNow()
      // Claude often sends only what changes; keep the rest of an edited task.
      const current = input.id === undefined ? undefined : snapshot.tasks.find((t) => t.id === input.id)
      if (input.id !== undefined && !current) throw new Error('That shared task does not exist. Call get_shared_lists for the current ids.')
      const listId = current?.listId ?? input.listId
      const name = input.name ?? current?.name
      if (!listId || name === undefined) throw new Error('A new shared task needs listId and name.')
      const list = snapshot.lists.find((l) => l.id === listId && l.accepted)
      if (!list) throw new Error('That shared list does not exist. Call get_shared_lists for the current ids.')
      const assigneeEmail =
        input.assignee === undefined
          ? (current?.assigneeEmail ?? null)
          : input.assignee === null || input.assignee.trim() === ''
            ? null
            : resolveAssignee(snapshot, list, input.assignee)
      const before = new Set(snapshot.tasks.map((t) => t.id))
      const after = await run({
        type: 'saveTask',
        task: {
          ...(current ? { id: current.id } : {}),
          listId,
          name,
          description: input.description ?? current?.description ?? '',
          assigneeEmail
        }
      })
      // A new task is the one whose id was not there before.
      return taskAfter(after, current?.id ?? after?.tasks.find((t) => !before.has(t.id))?.id)
    },
    set_shared_task_status: async (args) => {
      const { id, status } = parse('set_shared_task_status', args)
      return taskAfter(await run({ type: 'setTaskStatus', taskId: id, status }), id)
    },
    delete_shared_task: async (args) => {
      const { id } = parse('delete_shared_task', args)
      await run({ type: 'deleteTask', taskId: id })
      return { deleted: id }
    }
  }
}
