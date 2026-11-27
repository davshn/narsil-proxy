import { useEffect, useRef, useState } from 'react'
import type { Theme } from '@shared/dayNight'
import { useReducedMotion, useTheme } from '../theme'
import { petArtNames, type Pose } from './petArt'

export type { Pose }

export interface PoseState {
  /** The status carries an error. */
  hasError: boolean
  /** A meeting reminder is showing. */
  reminder: boolean
  /** Some email still waits for Claude's triage. */
  triaging: boolean
  /** Unread mail is waiting. */
  unread: boolean
  /** An action or reply just succeeded. */
  celebrating: boolean
}

/** Her pose, by priority: error > reminder > triage > unread mail > a success > idle. */
export function petPose(s: PoseState): Pose {
  if (s.hasError) return 'error'
  if (s.reminder) return 'necesita'
  if (s.triaging) return 'trabajando'
  if (s.unread) return 'necesita'
  if (s.celebrating) return 'terminado'
  return 'base'
}

// Bundled by Vite, so they load from the app itself (CSP `img-src 'self'`).
const ART = import.meta.glob<string>('../assets/narsil/*.{png,webp}', { eager: true, import: 'default' })

/** The animated loop for the pose when motion is welcome, else the still. */
function artFor(pose: Pose, theme: Theme, animated: boolean): string {
  const { loop, still } = petArtNames(pose, theme)
  const animation = animated ? ART[`../assets/narsil/${loop}`] : undefined
  return animation ?? ART[`../assets/narsil/${still}`] ?? ''
}

// Like the narsilPet overlay: a drawing fades into the next, and each stays a
// moment, so a burst of state changes doesn't flicker.
const FADE_MS = 200
const HOLD_MS = 800

interface Layer {
  id: number
  src: string
  leaving: boolean
}

interface NarsilPetProps {
  pose: Pose
  /** `full` draws her whole; `head` crops head and shoulders into a small circle. */
  variant?: 'full' | 'head'
}

/** Narsil, the chibi sea serpent, drawn in the art of the current theme. Decorative: callers label their buttons. */
export function NarsilPet({ pose, variant = 'full' }: NarsilPetProps): React.JSX.Element {
  const theme = useTheme()
  const reduceMotion = useReducedMotion()
  const wanted = artFor(pose, theme, variant === 'full' && !reduceMotion)

  const [layers, setLayers] = useState<Layer[]>(() => [{ id: 0, src: wanted, leaving: false }])
  const shown = useRef({ src: wanted, at: performance.now() })
  const latest = useRef(wanted)
  const holding = useRef<number | null>(null)
  const nextId = useRef(1)

  useEffect(() => {
    latest.current = wanted
    if (holding.current !== null || wanted === shown.current.src) return

    const swap = (): void => {
      holding.current = null
      const src = latest.current
      if (src === shown.current.src) return
      shown.current = { src, at: performance.now() }
      const image = new Image()
      image.src = src
      // Only once it can paint, so the fade never starts from a blank.
      const enter = (): void => {
        if (shown.current.src !== src) return
        const id = nextId.current++
        setLayers((prev) => [...prev.map((l) => ({ ...l, leaving: true })), { id, src, leaving: false }])
        window.setTimeout(() => setLayers((prev) => prev.filter((l) => !l.leaving || l.id > id)), FADE_MS)
      }
      image.decode().then(enter, enter)
    }

    const wait = shown.current.at + HOLD_MS - performance.now()
    if (wait <= 0) swap()
    else holding.current = window.setTimeout(swap, wait)
  }, [wanted])

  useEffect(
    () => () => {
      if (holding.current !== null) window.clearTimeout(holding.current)
      holding.current = null
    },
    []
  )

  return (
    <span className={`pet pet--${variant}`} aria-hidden="true">
      {layers.map((l) => (
        <img key={l.id} className={l.leaving ? 'pet__img pet__img--out' : 'pet__img'} src={l.src} alt="" draggable={false} />
      ))}
    </span>
  )
}

/** The water she swims in under the dock: rings spreading where she meets it, and a drifting wave. */
export function Water(): React.JSX.Element {
  let wave = 'M-24 14'
  for (let x = -24; x < 144; x += 12) wave += ' q3 -3 6 0 t6 0'
  return (
    <svg className="water" viewBox="0 0 120 22" width="120" height="22" aria-hidden="true">
      {[0, 0.8, 1.6].map((delay) => (
        <ellipse key={delay} className="water__ripple" style={{ animationDelay: `${delay}s` }} cx="60" cy="12" rx="30" ry="5" />
      ))}
      <path className="water__wave" d={wave} />
    </svg>
  )
}
