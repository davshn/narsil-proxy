import { describe, expect, it } from 'vitest'
import { dueReminders, toMeeting } from '../src/main/domain/reminders'
import type { Meeting } from '@shared/types'

const START = new Date('2026-11-26T15:00:00.000Z')
const meeting: Meeting = {
  id: 'evt-1',
  title: 'Daily',
  start: START.toISOString(),
  end: new Date(START.getTime() + 30 * 60_000).toISOString()
}

const minutesBefore = (m: number): Date => new Date(START.getTime() - m * 60_000)

/** Runs one scheduler tick and records fired keys, like the watcher does. */
function tick(now: Date, fired: Set<string>, meetings: Meeting[] = [meeting]) {
  const alerts = dueReminders(meetings, now, fired)
  alerts.forEach((a) => fired.add(a.key))
  return alerts
}

describe('dueReminders', () => {
  it('fires nothing earlier than 15 minutes before the meeting', () => {
    expect(tick(minutesBefore(16), new Set())).toEqual([])
  })

  it('fires the 15-minute alert at 15 minutes before', () => {
    const alerts = tick(minutesBefore(15), new Set())
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ thresholdMinutes: 15, minutesUntil: 15, meeting })
  })

  it('fires the 15-minute alert only once', () => {
    const fired = new Set<string>()
    tick(minutesBefore(15), fired)
    expect(tick(minutesBefore(14), fired)).toEqual([])
    expect(tick(minutesBefore(6), fired)).toEqual([])
  })

  it('fires the 5-minute alert after the 15-minute one', () => {
    const fired = new Set<string>()
    tick(minutesBefore(15), fired)
    const alerts = tick(minutesBefore(5), fired)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ thresholdMinutes: 5, minutesUntil: 5 })
    expect(tick(minutesBefore(4), fired)).toEqual([])
  })

  it('fires only the 5-minute alert when the app starts 4 minutes before', () => {
    const fired = new Set<string>()
    const alerts = tick(minutesBefore(4), fired)
    expect(alerts.map((a) => a.thresholdMinutes)).toEqual([5])
    expect(alerts[0]?.minutesUntil).toBe(4)
    expect(tick(minutesBefore(3), fired)).toEqual([])
  })

  it('fires the 15-minute alert with the real minutes left when started 10 minutes before', () => {
    const alerts = tick(minutesBefore(10), new Set())
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ thresholdMinutes: 15, minutesUntil: 10 })
  })

  it('fires nothing once the meeting has started', () => {
    expect(tick(START, new Set())).toEqual([])
    expect(tick(new Date(START.getTime() + 60_000), new Set())).toEqual([])
  })

  it('alerts again when a meeting is rescheduled', () => {
    const fired = new Set<string>()
    tick(minutesBefore(15), fired)
    const later = new Date(START.getTime() + 60 * 60_000)
    const moved: Meeting = { ...meeting, start: later.toISOString() }
    const alerts = tick(new Date(later.getTime() - 15 * 60_000), fired, [moved])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.thresholdMinutes).toBe(15)
  })

  it('handles several meetings independently', () => {
    const other: Meeting = { ...meeting, id: 'evt-2', title: '1:1' }
    const alerts = tick(minutesBefore(15), new Set(), [meeting, other])
    expect(alerts.map((a) => a.meeting.id).sort()).toEqual(['evt-1', 'evt-2'])
  })
})

describe('toMeeting', () => {
  it('maps a timed Google Calendar event', () => {
    expect(
      toMeeting({
        id: 'a',
        summary: 'Planning',
        status: 'confirmed',
        start: { dateTime: '2026-11-26T15:00:00Z' },
        end: { dateTime: '2026-11-26T15:30:00Z' },
        location: 'Room 1',
        hangoutLink: 'https://meet.google.com/abc'
      })
    ).toEqual({
      id: 'a',
      title: 'Planning',
      start: '2026-11-26T15:00:00.000Z',
      end: '2026-11-26T15:30:00.000Z',
      location: 'Room 1',
      link: 'https://meet.google.com/abc'
    })
  })

  it('skips all-day events', () => {
    expect(toMeeting({ id: 'b', start: { date: '2026-11-26' }, end: { date: '2026-11-27' } })).toBeNull()
  })

  it('skips cancelled events', () => {
    expect(
      toMeeting({ id: 'c', status: 'cancelled', start: { dateTime: '2026-11-26T15:00:00Z' }, end: { dateTime: '2026-11-26T16:00:00Z' } })
    ).toBeNull()
  })

  it('skips events the user declined', () => {
    expect(
      toMeeting({
        id: 'd',
        start: { dateTime: '2026-11-26T15:00:00Z' },
        end: { dateTime: '2026-11-26T16:00:00Z' },
        attendees: [{ self: true, responseStatus: 'declined' }]
      })
    ).toBeNull()
  })

  it('uses a placeholder title when the event has none', () => {
    expect(
      toMeeting({ id: 'e', start: { dateTime: '2026-11-26T15:00:00Z' }, end: { dateTime: '2026-11-26T16:00:00Z' } })?.title
    ).toBe('(Untitled meeting)')
  })
})
