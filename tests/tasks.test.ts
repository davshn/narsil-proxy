import { describe, expect, it } from 'vitest'
import { TASK_STATUSES, type PendingTask } from '@shared/types'
import { MAX_TASK_DESCRIPTION, MAX_TASK_NAME, MAX_TASK_PROJECT, TaskList, type TasksRepository } from '../src/main/app/tasks'

class MemoryRepo implements TasksRepository {
  saves = 0
  constructor(public tasks: PendingTask[] = []) {}
  load(): PendingTask[] {
    return structuredClone(this.tasks)
  }
  save(tasks: PendingTask[]): void {
    this.saves += 1
    this.tasks = structuredClone(tasks)
  }
}

function list(repo = new MemoryRepo()): { repo: MemoryRepo; tasks: TaskList } {
  let n = 0
  const tasks = new TaskList(repo, {
    newId: () => `t${++n}`,
    now: () => new Date('2026-11-26T12:00:00Z')
  })
  return { repo, tasks }
}

describe('TaskList.save', () => {
  it('adds a task with trimmed fields, to do, and stores it', () => {
    const { repo, tasks } = list()
    const result = tasks.save({ name: '  Revisar contrato ', description: ' Ver cláusula 4 \n', project: ' Tenzor ' })
    const expected: PendingTask = {
      id: 't1',
      name: 'Revisar contrato',
      description: 'Ver cláusula 4',
      project: 'Tenzor',
      status: 'todo',
      createdAt: '2026-11-26T12:00:00.000Z'
    }
    expect(result).toEqual([expected])
    expect(repo.tasks).toEqual([expected])
  })

  it('accepts a task without project or description', () => {
    const { tasks } = list()
    expect(tasks.save({ name: 'Llamar al banco', description: '', project: '  ' })[0]).toMatchObject({
      name: 'Llamar al banco',
      description: '',
      project: ''
    })
  })

  it('rejects a blank name and stores nothing', () => {
    const { repo, tasks } = list()
    expect(() => tasks.save({ name: '   ', description: 'x', project: 'y' })).toThrow('Escribe un nombre para la tarea.')
    expect(repo.saves).toBe(0)
  })

  it.each([
    [{ name: 'a'.repeat(MAX_TASK_NAME + 1), description: '', project: '' }, `El nombre admite hasta ${MAX_TASK_NAME} caracteres.`],
    [{ name: 'a', description: '', project: 'p'.repeat(MAX_TASK_PROJECT + 1) }, `El proyecto admite hasta ${MAX_TASK_PROJECT} caracteres.`],
    [
      { name: 'a', description: 'd'.repeat(MAX_TASK_DESCRIPTION + 1), project: '' },
      `La descripción admite hasta ${MAX_TASK_DESCRIPTION} caracteres.`
    ]
  ])('rejects fields that are too long (%#)', (input, message) => {
    const { repo, tasks } = list()
    expect(() => tasks.save(input)).toThrow(message)
    expect(repo.saves).toBe(0)
  })

  it('edits an existing task, keeping its id, state and creation date', () => {
    const { tasks } = list()
    tasks.save({ name: 'Uno', description: '', project: 'A' })
    tasks.setStatus('t1', 'paused')
    const result = tasks.save({ id: 't1', name: 'Uno editado', description: 'Más detalle', project: 'B' })
    expect(result).toEqual([
      { id: 't1', name: 'Uno editado', description: 'Más detalle', project: 'B', status: 'paused', createdAt: '2026-11-26T12:00:00.000Z' }
    ])
  })

  it('refuses to edit a task that no longer exists', () => {
    const { tasks } = list()
    expect(() => tasks.save({ id: 'gone', name: 'x', description: '', project: '' })).toThrow('Esa tarea ya no existe.')
  })
})

describe('TaskList.setStatus and remove', () => {
  it.each(TASK_STATUSES)('sets status %s and stores it', (status) => {
    const { repo, tasks } = list()
    tasks.save({ name: 'Uno', description: '', project: '' })
    expect(tasks.setStatus('t1', status)[0]?.status).toBe(status)
    expect(repo.tasks[0]?.status).toBe(status)
  })

  it('removes only the given task', () => {
    const { repo, tasks } = list()
    tasks.save({ name: 'Uno', description: '', project: '' })
    tasks.save({ name: 'Dos', description: '', project: '' })
    expect(tasks.remove('t1').map((t) => t.id)).toEqual(['t2'])
    expect(repo.tasks.map((t) => t.id)).toEqual(['t2'])
  })

  it('reports a missing task for setStatus and remove', () => {
    const { tasks } = list()
    expect(() => tasks.setStatus('gone', 'done')).toThrow('Esa tarea ya no existe.')
    expect(() => tasks.remove('gone')).toThrow('Esa tarea ya no existe.')
  })
})

describe('TaskList.list', () => {
  it('reads the stored tasks once', () => {
    const stored: PendingTask = {
      id: 'x',
      name: 'Guardada',
      description: '',
      project: 'P',
      status: 'todo',
      createdAt: '2026-11-01T00:00:00.000Z'
    }
    const repo = new MemoryRepo([stored])
    const { tasks } = list(repo)
    expect(tasks.list()).toEqual([stored])
    repo.tasks = []
    expect(tasks.list()).toEqual([stored])
  })

  it('returns copies, so callers cannot change the stored list', () => {
    const { tasks } = list()
    tasks.save({ name: 'Uno', description: '', project: '' })
    tasks.list()[0]!.name = 'cambiado'
    expect(tasks.list()[0]?.name).toBe('Uno')
  })
})
