import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Rule } from '@shared/types'

const dir = mkdtempSync(join(tmpdir(), 'narsil-rules-'))
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const { RulesFileStore } = await import('../src/main/adapters/rulesStore')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('RulesFileStore', () => {
  it('keeps the folder of a save rule across a save and reload', () => {
    const rules: Rule[] = [
      {
        id: 'r1',
        name: 'Bancos',
        enabled: true,
        action: 'save',
        conditions: { from: 'banco.com', subject: '', body: '' },
        folder: { accountId: 'g1', id: 'Label_1', name: 'Bancos' }
      },
      { id: 'r2', name: 'Promos', enabled: true, action: 'archive', conditions: { from: 'shop', subject: '', body: '' } }
    ]
    new RulesFileStore().save(rules)
    expect(new RulesFileStore().load()).toEqual(rules)
  })
})
