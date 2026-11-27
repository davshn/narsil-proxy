import { randomUUID } from 'node:crypto'
import type { PendingTask, PendingTaskInput, TaskStatus } from '@shared/types'

export const MAX_TASK_NAME = 200
export const MAX_TASK_PROJECT = 100
export const MAX_TASK_DESCRIPTION = 5000

export interface TasksRepository {
  load(): PendingTask[]
  save(tasks: PendingTask[]): void
}

export interface TaskListOptions {
  newId?: () => string
  now?: () => Date
}

const MISSING = 'Esa tarea ya no existe.'

function checkLength(value: string, max: number, label: string): string {
  if (value.length > max) throw new Error(`${label} admite hasta ${max} caracteres.`)
  return value
}

/** The "Pendientes" list. Every change is stored before it is returned. */
export class TaskList {
  private tasks: PendingTask[] | undefined
  private readonly newId: () => string
  private readonly now: () => Date

  constructor(
    private readonly repo: TasksRepository,
    options: TaskListOptions = {}
  ) {
    this.newId = options.newId ?? randomUUID
    this.now = options.now ?? (() => new Date())
  }

  list(): PendingTask[] {
    return this.current().map((task) => ({ ...task }))
  }

  /** Adds a task, or edits task `input.id` keeping its state and creation date. */
  save(input: PendingTaskInput): PendingTask[] {
    const name = input.name.trim()
    if (!name) throw new Error('Escribe un nombre para la tarea.')
    const fields = {
      name: checkLength(name, MAX_TASK_NAME, 'El nombre'),
      project: checkLength(input.project.trim(), MAX_TASK_PROJECT, 'El proyecto'),
      description: checkLength(input.description.trim(), MAX_TASK_DESCRIPTION, 'La descripción')
    }
    const tasks = this.current()
    if (input.id === undefined) {
      return this.commit([...tasks, { id: this.newId(), ...fields, status: 'todo', createdAt: this.now().toISOString() }])
    }
    const id = input.id
    if (!tasks.some((task) => task.id === id)) throw new Error(MISSING)
    return this.commit(tasks.map((task) => (task.id === id ? { ...task, ...fields } : task)))
  }

  setStatus(id: string, status: TaskStatus): PendingTask[] {
    const tasks = this.current()
    if (!tasks.some((task) => task.id === id)) throw new Error(MISSING)
    return this.commit(tasks.map((task) => (task.id === id ? { ...task, status } : task)))
  }

  remove(id: string): PendingTask[] {
    const tasks = this.current()
    if (!tasks.some((task) => task.id === id)) throw new Error(MISSING)
    return this.commit(tasks.filter((task) => task.id !== id))
  }

  private current(): PendingTask[] {
    this.tasks ??= this.repo.load()
    return this.tasks
  }

  /** Stores first: a failed write leaves the list as it was. */
  private commit(tasks: PendingTask[]): PendingTask[] {
    this.repo.save(tasks)
    this.tasks = tasks
    return this.list()
  }
}
