import type { Meeting } from '@shared/types'
import { htmlToText, type ParsedEmail } from './email'

/** The subset of Microsoft Graph types that Narsil reads. Every field may be missing or null. */
export interface GraphRecipientLike {
  emailAddress?: { name?: string | null; address?: string | null } | null
}

export interface GraphMessageLike {
  id?: string | null
  conversationId?: string | null
  subject?: string | null
  from?: GraphRecipientLike | null
  replyTo?: GraphRecipientLike[] | null
  bodyPreview?: string | null
  body?: { contentType?: string | null; content?: string | null } | null
  receivedDateTime?: string | null
  internetMessageId?: string | null
}

export interface GraphEventLike {
  id?: string | null
  subject?: string | null
  start?: { dateTime?: string | null; timeZone?: string | null } | null
  end?: { dateTime?: string | null; timeZone?: string | null } | null
  location?: { displayName?: string | null } | null
  isAllDay?: boolean | null
  isCancelled?: boolean | null
  responseStatus?: { response?: string | null } | null
  onlineMeeting?: { joinUrl?: string | null } | null
  onlineMeetingUrl?: string | null
}

const ZONE_DESIGNATOR = /(Z|[+-]\d{2}:?\d{2})$/i

/**
 * Parses a Graph timestamp as UTC. With `Prefer: outlook.timezone="UTC"` Graph returns
 * values like `2026-11-26T15:00:00.0000000` without a `Z`, which `Date` would read as local time.
 */
function parseUtc(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(ZONE_DESIGNATOR.test(value) ? value : `${value}Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

/** `Name <address>`, the bare address when there is no name, or undefined without an address. */
function formatRecipient(recipient: GraphRecipientLike | null | undefined): string | undefined {
  const address = recipient?.emailAddress?.address?.trim()
  if (!address) return undefined
  const name = recipient?.emailAddress?.name?.trim()
  return name && name !== address ? `${name} <${address}>` : address
}

export function parseGraphMessage(message: GraphMessageLike, accountId: string): ParsedEmail {
  const from = formatRecipient(message.from) ?? '(Remitente desconocido)'
  const replyTo = formatRecipient(message.replyTo?.[0]) ?? from
  const content = message.body?.content ?? ''
  const bodyText = message.body?.contentType?.toLowerCase() === 'html' ? htmlToText(content) : content.trim()

  const parsed: ParsedEmail = {
    summary: {
      id: message.id ?? '',
      accountId,
      threadId: message.conversationId ?? '',
      from,
      replyTo,
      subject: message.subject?.trim() || '(Sin asunto)',
      snippet: message.bodyPreview ?? '',
      receivedAt: (parseUtc(message.receivedDateTime) ?? new Date()).toISOString()
    },
    bodyText,
    replyTo
  }
  if (message.internetMessageId) parsed.messageId = message.internetMessageId
  return parsed
}

function httpsLink(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Maps a Graph calendarView event to a Meeting, or null when it should not trigger reminders:
 * all-day events, cancelled events and events the user declined.
 */
export function toMeetingFromGraph(event: GraphEventLike, accountId: string): Meeting | null {
  if (!event.id || event.isAllDay || event.isCancelled) return null
  if (event.responseStatus?.response === 'declined') return null
  const start = parseUtc(event.start?.dateTime)
  const end = parseUtc(event.end?.dateTime)
  if (!start || !end) return null

  const meeting: Meeting = {
    id: `${accountId}:${event.id}`,
    accountId,
    title: event.subject?.trim() || '(Reunión sin título)',
    start: start.toISOString(),
    end: end.toISOString()
  }
  const location = event.location?.displayName?.trim()
  if (location) meeting.location = location
  const link = httpsLink(event.onlineMeeting?.joinUrl ?? event.onlineMeetingUrl)
  if (link) meeting.link = link
  return meeting
}
