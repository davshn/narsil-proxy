import type { PendingTask, TaskStatus } from '@shared/types'

/** What each status reads as on the task's label. */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'Por hacer',
  started: 'Iniciada',
  'in-progress': 'En curso',
  paused: 'En pausa',
  done: 'Terminada'
}

export const isFinished = (task: PendingTask): boolean => task.status === 'done'

/** The filter value and group of tasks without a project. Never a real project: those are trimmed. */
export const NO_PROJECT = ' sin-proyecto'

export interface TaskGroup {
  /** The project as first written, or NO_PROJECT. */
  project: string
  tasks: PendingTask[]
  /** Tasks not finished yet. */
  pending: number
}

const keyOf = (project: string): string => (project ? project.toLocaleLowerCase() : NO_PROJECT)

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** Unfinished first and newest first, then the finished ones, newest first too. */
function byState(a: PendingTask, b: PendingTask): number {
  if (isFinished(a) !== isFinished(b)) return isFinished(a) ? 1 : -1
  return b.createdAt.localeCompare(a.createdAt)
}

/**
 * Tasks grouped by project, ignoring case, sorted by name with "no project" last. With
 * `filter` (a project or NO_PROJECT) only that group is kept.
 */
export function groupTasks(tasks: PendingTask[], filter?: string): TaskGroup[] {
  const groups = new Map<string, TaskGroup>()
  for (const task of tasks) {
    const key = keyOf(task.project)
    if (filter !== undefined && key !== keyOf(filter === NO_PROJECT ? '' : filter)) continue
    const group = groups.get(key) ?? { project: task.project || NO_PROJECT, tasks: [], pending: 0 }
    group.tasks.push(task)
    if (!isFinished(task)) group.pending += 1
    groups.set(key, group)
  }
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.project === NO_PROJECT || b.project === NO_PROJECT) return a.project === NO_PROJECT ? 1 : -1
    return byName(a.project, b.project)
  })
  for (const group of sorted) group.tasks.sort(byState)
  return sorted
}

/** Each project once, as first written, sorted by name; for suggestions and the filter. */
export function projectsOf(tasks: PendingTask[]): string[] {
  return groupTasks(tasks)
    .map((group) => group.project)
    .filter((project) => project !== NO_PROJECT)
}
