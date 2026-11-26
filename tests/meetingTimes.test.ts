import { describe, expect, it } from 'vitest'
import { defaultTimes, shiftEnd, toIso } from '../src/renderer/src/components/meetingTimes'

describe('Agregar reunión defaults', () => {
  it('starts at the next half hour today and lasts 30 minutes', () => {
    expect(defaultTimes(new Date(2026, 10, 26, 10, 7))).toEqual({ date: '2026-11-26', start: '10:30', end: '11:00' })
    expect(defaultTimes(new Date(2026, 10, 26, 10, 30))).toEqual({ date: '2026-11-26', start: '11:00', end: '11:30' })
  })

  it('moves to tomorrow after 23:30 and never ends past 23:59', () => {
    expect(defaultTimes(new Date(2026, 10, 26, 23, 40))).toEqual({ date: '2026-11-27', start: '00:00', end: '00:30' })
    expect(defaultTimes(new Date(2026, 10, 26, 23, 10))).toEqual({ date: '2026-11-26', start: '23:30', end: '23:59' })
  })
})

describe('changing Inicio', () => {
  it('keeps the duration', () => {
    expect(shiftEnd('10:30', '11:15', '14:00')).toBe('14:45')
  })

  it('falls back to 30 minutes when the end was not after the start', () => {
    expect(shiftEnd('10:30', '10:00', '12:00')).toBe('12:30')
  })
})

describe('toIso', () => {
  it('reads the date and time in the local time zone', () => {
    expect(toIso('2026-11-26', '15:00')).toBe(new Date(2026, 10, 26, 15, 0).toISOString())
  })

  it('keeps unparseable input as typed', () => {
    expect(toIso('', '15:00')).toBe('T15:00')
  })
})
