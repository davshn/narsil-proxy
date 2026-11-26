import { useEffect, useSyncExternalStore } from 'react'
import { themeAt, type Theme } from '@shared/dayNight'

/** How often the clock is re-checked, like the narsil-skin mod. */
const CHECK_MS = 10_000

const root = (): HTMLElement => document.documentElement

/** Sets the theme of the hour on the page. Called once before the first render, so nothing flashes. */
export function applyThemeOfTheHour(): Theme {
  const theme = themeAt(new Date())
  root().dataset.theme = theme
  return theme
}

/**
 * Switches light/dark by the local clock: re-checks every 10 s, and when the window
 * regains focus or becomes visible again (a sleeping laptop skips timers).
 * The attribute is only written when the hour's theme changes, so the colors
 * cross-fade once at 6:00 and 18:00 (see the registered tokens in styles.css).
 */
export function useDayNightTheme(): void {
  useEffect(() => {
    let last = themeAt(new Date())
    if (root().dataset.theme === undefined) root().dataset.theme = last
    const check = (): void => {
      const theme = themeAt(new Date())
      if (theme === last) return
      last = theme
      root().dataset.theme = theme
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') check()
    }
    const timer = window.setInterval(check, CHECK_MS)
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}

function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(root(), { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}

const currentTheme = (): Theme => (root().dataset.theme === 'light' ? 'light' : 'dark')

/** The theme the page shows now, following `data-theme` on the root element. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, currentTheme)
}

const REDUCE_MOTION = '(prefers-reduced-motion: reduce)'

function subscribeMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCE_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

const prefersReducedMotion = (): boolean => window.matchMedia(REDUCE_MOTION).matches

/** True while the system asks for reduced motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, prefersReducedMotion)
}
