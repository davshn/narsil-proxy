import { describe, expect, it } from 'vitest'
import type { PendingTask } from '@shared/types'
import { NO_PROJECT, groupTasks, projectsOf } from '../src/renderer/src/components/taskGroups'

function task(id: string, project: string, done = false, createdAt = '2026-11-26T12:00:00.000Z'): PendingTask {
  return { id, name: id, description: '', project, done, createdAt }
}

describe('groupTasks', () => {
  it('groups by project alphabetically, with tasks without project last', () => {
    const groups = groupTasks([task('a', 'tenzor'), task('b', ''), task('c', 'Casa'), task('d', 'Tenzor')])
    expect(groups.map((g) => [g.project, g.tasks.map((t) => t.id)])).toEqual([
      ['Casa', ['c']],
      ['tenzor', ['a', 'd']],
      [NO_PROJECT, ['b']]
    ])
  })

  it('lists pending tasks first, newest first, then the done ones', () => {
    const groups = groupTasks([
      task('old', 'P', false, '2026-11-01T00:00:00.000Z'),
      task('done', 'P', true, '2026-11-30T00:00:00.000Z'),
      task('new', 'P', false, '2026-11-20T00:00:00.000Z')
    ])
    expect(groups[0]?.tasks.map((t) => t.id)).toEqual(['new', 'old', 'done'])
    expect(groups[0]?.pending).toBe(2)
  })

  it('keeps only the chosen project', () => {
    const groups = groupTasks([task('a', 'Casa'), task('b', 'Tenzor'), task('c', '')], 'Tenzor')
    expect(groups.map((g) => g.project)).toEqual(['Tenzor'])
  })

  it('keeps only tasks without project when that is chosen', () => {
    const groups = groupTasks([task('a', 'Casa'), task('c', '')], NO_PROJECT)
    expect(groups.map((g) => g.tasks.map((t) => t.id))).toEqual([['c']])
  })
})

describe('projectsOf', () => {
  it('lists each project once, sorted, ignoring case differences and empty projects', () => {
    expect(projectsOf([task('a', 'tenzor'), task('b', ''), task('c', 'Casa'), task('d', 'Tenzor')])).toEqual(['Casa', 'tenzor'])
  })
})
