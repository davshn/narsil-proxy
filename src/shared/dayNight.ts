export type Theme = 'light' | 'dark'

/** Day runs from 6:00 to 17:59 on the local clock, like the narsil-skin mod. */
export function isDay(hour: number): boolean {
  return hour >= 6 && hour < 18
}

/** The light theme by day and the dark theme by night. */
export function themeAt(date: Date): Theme {
  return isDay(date.getHours()) ? 'light' : 'dark'
}
