import { describe, expect, it } from 'vitest'
import { isDay, themeAt } from '@shared/dayNight'

describe('isDay', () => {
  it('is night just before 6:00', () => {
    expect(isDay(5)).toBe(false)
  })

  it('is day from 6:00', () => {
    expect(isDay(6)).toBe(true)
  })

  it('is still day at 17:xx', () => {
    expect(isDay(17)).toBe(true)
  })

  it('is night from 18:00', () => {
    expect(isDay(18)).toBe(false)
  })
})

describe('themeAt', () => {
  it('uses the light theme by day, on the local clock', () => {
    expect(themeAt(new Date(2026, 10, 26, 6, 0))).toBe('light')
    expect(themeAt(new Date(2026, 10, 26, 17, 59))).toBe('light')
  })

  it('uses the dark theme by night, on the local clock', () => {
    expect(themeAt(new Date(2026, 10, 26, 5, 59))).toBe('dark')
    expect(themeAt(new Date(2026, 10, 26, 18, 0))).toBe('dark')
    expect(themeAt(new Date(2026, 10, 26, 0, 0))).toBe('dark')
  })
})
