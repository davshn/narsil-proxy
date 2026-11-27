import type { SharedList, SharedMember, SharedSnapshot, SharedTask } from '@shared/types'

const GONE = 'alguien que ya no está'
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** A person by profile id: their name, their email when they set none, "tú" for the user. */
export function personLabel(snapshot: SharedSnapshot, id: string | null): string {
  if (id === snapshot.userId) return 'tú'
  const person = snapshot.people.find((p) => p.id === id)
  return person ? person.name || person.email : GONE
}

/** A member by email. Nobody sees an invited person's name before they accept, so that is the email. */
export function memberLabel(snapshot: SharedSnapshot, email: string): string {
  const person = snapshot.people.find((p) => p.email === email)
  const label = person?.name || email
  return email === snapshot.email ? `${label} (tú)` : label
}

/** Lists the user accepted or owns, by name. */
export function workLists(snapshot: SharedSnapshot): SharedList[] {
  return snapshot.lists.filter((l) => l.accepted).sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
}

/** Lists the user was invited to and has not answered yet. */
export function invitations(snapshot: SharedSnapshot): SharedList[] {
  return snapshot.lists.filter((l) => !l.accepted)
}

export const ownedByMe = (snapshot: SharedSnapshot, list: SharedList): boolean => list.ownerId === snapshot.userId

/** Members who accepted, then pending invitations, each in the order they were added. */
export function membersOf(snapshot: SharedSnapshot, listId: string): SharedMember[] {
  const pending = (m: SharedMember): number => (m.acceptedAt === null ? 1 : 0)
  return snapshot.members
    .filter((m) => m.listId === listId)
    .sort((a, b) => pending(a) - pending(b) || a.addedAt.localeCompare(b.addedAt))
}

/** The assignee and the creator change a task; the database checks the same. */
export const canChange = (snapshot: SharedSnapshot, task: SharedTask): boolean =>
  task.createdBy === snapshot.userId || task.assigneeEmail === snapshot.email

/** The creator and the list owner delete a task. */
export function canDelete(snapshot: SharedSnapshot, task: SharedTask): boolean {
  const list = snapshot.lists.find((l) => l.id === task.listId)
  return task.createdBy === snapshot.userId || (list !== undefined && ownedByMe(snapshot, list))
}

/** Unfinished tasks assigned to the user in the lists they work in: what the tab count adds. */
export function assignedToMe(snapshot: SharedSnapshot | null): number {
  if (!snapshot) return 0
  const lists = new Set(workLists(snapshot).map((l) => l.id))
  return snapshot.tasks.filter((t) => t.assigneeEmail === snapshot.email && t.status !== 'done' && lists.has(t.listId)).length
}

/** Unfinished first, then finished, each with the latest change first. */
export function sortSharedTasks(tasks: SharedTask[]): SharedTask[] {
  const done = (t: SharedTask): number => (t.status === 'done' ? 1 : 0)
  return [...tasks].sort((a, b) => done(a) - done(b) || b.updatedAt.localeCompare(a.updatedAt))
}

const pad = (n: number): string => String(n).padStart(2, '0')

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "Último cambio: Ana Pérez, hoy a las 10:05", in the computer's time zone. */
export function changedLabel(snapshot: SharedSnapshot, task: SharedTask, now = new Date()): string {
  const at = new Date(task.updatedAt)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const day = sameDay(at, now) ? 'hoy' : sameDay(at, yesterday) ? 'ayer' : `el ${at.getDate()} ${MONTHS[at.getMonth()]}`
  return `Último cambio: ${personLabel(snapshot, task.updatedBy)}, ${day} a las ${pad(at.getHours())}:${pad(at.getMinutes())}`
}
