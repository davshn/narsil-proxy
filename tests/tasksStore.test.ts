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
      { id: 't1', name: 'Revisar contrato', description: 'Línea 1\nLínea 2', project: 'Tenzor', done: false, createdAt: '2026-11-26T12:00:00.000Z' },
      { id: 't2', name: 'Llamar', description: '', project: '', done: true, createdAt: '2026-11-25T08:00:00.000Z' }
    ]
    new TasksFileStore().save(tasks)
    expect(new TasksFileStore().load()).toEqual(tasks)
  })

  it('refuses a damaged file instead of losing it', () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify([{ id: 1 }]))
    expect(() => new TasksFileStore().load()).toThrow('El archivo de pendientes está dañado')
  })
})
