import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { petArtNames } from '../src/renderer/src/components/petArt'

describe('petArtNames', () => {
  it('animates the idle pose with the parada loop and keeps base as its still', () => {
    expect(petArtNames('base', 'light')).toEqual({ loop: 'parada-claro.webp', still: 'base-claro.png' })
    expect(petArtNames('base', 'dark')).toEqual({ loop: 'parada-oscuro.webp', still: 'base-oscuro.png' })
  })

  it('uses the loop and still of the same name for every other pose', () => {
    expect(petArtNames('trabajando', 'light')).toEqual({ loop: 'trabajando-claro.webp', still: 'trabajando-claro.png' })
    expect(petArtNames('error', 'dark')).toEqual({ loop: 'error-oscuro.webp', still: 'error-oscuro.png' })
  })

  it('names only drawings that are bundled with the renderer', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/assets/narsil')
    const poses = ['base', 'trabajando', 'necesita', 'error', 'terminado'] as const
    for (const pose of poses) {
      for (const theme of ['light', 'dark'] as const) {
        const { loop, still } = petArtNames(pose, theme)
        expect(existsSync(join(dir, loop)), loop).toBe(true)
        expect(existsSync(join(dir, still)), still).toBe(true)
      }
    }
  })
})
