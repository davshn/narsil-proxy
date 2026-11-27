import { describe, expect, it } from 'vitest'
import { googleRecurrence, graphRecurrence, localWallTime, planWeekly } from '../src/main/domain/recurrence'

// Local times, so the expectations hold in any time zone the tests run in.
const at = (y: number, m: number, d: number, h = 0, min = 0): Date => new Date(y, m - 1, d, h, min)

describe('planWeekly', () => {
  it('keeps a meeting that already falls on a chosen day, and sorts and dedupes the days', () => {
    // 2026-12-01 is a Tuesday.
    const plan = planWeekly(at(2026, 12, 1, 19), at(2026, 12, 1, 20, 30), { days: ['TH', 'TU', 'TH'], until: '2027-03-16' })
    expect(plan.start).toEqual(at(2026, 12, 1, 19))
    expect(plan.end).toEqual(at(2026, 12, 1, 20, 30))
    expect(plan.repeat).toEqual({ days: ['TU', 'TH'], until: '2027-03-16' })
  })

  it('moves the first meeting to the first chosen day after its date, keeping the local time', () => {
    // 2026-12-02 is a Wednesday; the next Tuesday is 2026-12-08.
    const plan = planWeekly(at(2026, 12, 2, 19), at(2026, 12, 2, 20), { days: ['TU'], until: '2027-01-26' })
    expect(plan.start).toEqual(at(2026, 12, 8, 19))
    expect(plan.end).toEqual(at(2026, 12, 8, 20))
  })

  it('refuses a series without days', () => {
    expect(() => planWeekly(at(2026, 12, 1, 19), at(2026, 12, 1, 20), { days: [], until: '2027-01-26' })).toThrow(
      'Elige al menos un día para repetir la reunión.'
    )
  })

  it('refuses an end date that is not a date', () => {
    expect(() => planWeekly(at(2026, 12, 1, 19), at(2026, 12, 1, 20), { days: ['TU'], until: '2027-02-30' })).toThrow(
      'La fecha final de la repetición no es válida.'
    )
  })

  it('refuses an end date before the first meeting, also after moving it', () => {
    const tuesdayPlan = { days: ['TU' as const], until: '2026-12-07' }
    // Wednesday 2026-12-02 moves to Tuesday 2026-12-08, after the end date.
    expect(() => planWeekly(at(2026, 12, 2, 19), at(2026, 12, 2, 20), tuesdayPlan)).toThrow(
      'La fecha final debe ser igual o posterior a la primera reunión.'
    )
    // The end date may be the first meeting's own day.
    expect(planWeekly(at(2026, 12, 1, 19), at(2026, 12, 1, 20), { days: ['TU'], until: '2026-12-01' }).start).toEqual(at(2026, 12, 1, 19))
  })
})

describe('calendar recurrence formats', () => {
  it('builds a weekly Google RRULE that ends at the end of the local last day', () => {
    const until = at(2027, 3, 16, 23, 59)
    until.setSeconds(59)
    const stamp = until.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    expect(googleRecurrence({ days: ['TU', 'TH'], until: '2027-03-16' })).toEqual([`RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=${stamp}`])
  })

  it('builds a weekly Outlook pattern from the first date to the last, in the given time zone', () => {
    expect(graphRecurrence(at(2026, 12, 1, 19), { days: ['TU', 'TH'], until: '2027-03-16' }, 'America/Bogota')).toEqual({
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['tuesday', 'thursday'], firstDayOfWeek: 'monday' },
      range: { type: 'endDate', startDate: '2026-12-01', endDate: '2027-03-16', recurrenceTimeZone: 'America/Bogota' }
    })
  })

  it('writes local wall time without an offset, as Outlook expects with a time zone name', () => {
    expect(localWallTime(at(2026, 12, 1, 19, 5))).toBe('2026-12-01T19:05:00')
  })
})
