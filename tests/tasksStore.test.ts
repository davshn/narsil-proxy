import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { PendingTask } from '@shared/types'

const dir = mkdtempSync(join(tmpdir(), 'narsil-tasks-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const { TasksFileStore } = await import('../src/main/adapters/tasksStore')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('TasksFileStore', () => {
  it('starts empty when there is no file', () => {
    expect(new TasksFileStore().load()).toEqual([])
  })

  it('keeps every field across a save and reload', () => {
    const tasks: PendingTask[] = [
      {
        id: 't1',
        name: 'Revisar contrato',
        description: 'Línea 1\nLínea 2',
        project: 'Tenzor',
        status: 'in-progress',
        createdAt: '2026-11-26T12:00:00.000Z'
      },
      { id: 't2', name: 'Llamar', description: '', project: '', status: 'done', createdAt: '2026-11-25T08:00:00.000Z' }
    ]
    new TasksFileStore().save(tasks)
    expect(new TasksFileStore().load()).toEqual(tasks)
  })

  it('reads tasks saved before statuses existed: done becomes finished, the rest to do', () => {
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify([
        { id: 'a', name: 'Vieja hecha', description: '', project: 'P', done: true, createdAt: '2026-11-20T00:00:00.000Z' },
        { id: 'b', name: 'Vieja pendiente', description: '', project: '', done: false, createdAt: '2026-11-21T00:00:00.000Z' }
      ])
    )
    expect(new TasksFileStore().load()).toEqual([
      { id: 'a', name: 'Vieja hecha', description: '', project: 'P', status: 'done', createdAt: '2026-11-20T00:00:00.000Z' },
      { id: 'b', name: 'Vieja pendiente', description: '', project: '', status: 'todo', createdAt: '2026-11-21T00:00:00.000Z' }
    ])
  })

  it('refuses a task with an unknown status', () => {
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify([{ id: 'a', name: 'x', description: '', project: '', status: 'lista', createdAt: '2026-11-20T00:00:00.000Z' }])
    )
    expect(() => new TasksFileStore().load()).toThrow('El archivo de pendientes está dañado')
  })

  it('refuses a damaged file instead of losing it', () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify([{ id: 1 }]))
    expect(() => new TasksFileStore().load()).toThrow('El archivo de pendientes está dañado')
  })
})
