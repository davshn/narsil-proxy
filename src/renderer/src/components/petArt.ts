import type { Theme } from '@shared/dayNight'

/** The poses Narsil takes here, named as narsilPet's stills. */
export type Pose = 'base' | 'trabajando' | 'necesita' | 'error' | 'terminado'

/**
 * narsilPet has no `base` loop: while idle she plays the `parada` loop, and `base` stays the
 * still for reduced motion and the small head crop.
 */
const LOOP: Record<Pose, string> = {
  base: 'parada',
  trabajando: 'trabajando',
  necesita: 'necesita',
  error: 'error',
  terminado: 'terminado'
}

/** The file names of a pose's animated loop and its still, in the theme's variant. */
export function petArtNames(pose: Pose, theme: Theme): { loop: string; still: string } {
  const variant = theme === 'light' ? 'claro' : 'oscuro'
  return { loop: `${LOOP[pose]}-${variant}.webp`, still: `${pose}-${variant}.png` }
}
