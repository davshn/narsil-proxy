import type { EmailSummary } from '@shared/types'

/** The subset of a Gmail API message (format=full) that Narsil reads. */
export interface GmailPartLike {
  mimeType?: string | null
  headers?: Array<{ name?: string | null; value?: string | null }> | null
  body?: { data?: string | null } | null
  parts?: GmailPartLike[] | null
}

export interface GmailMessageLike {
  id?: string | null
  threadId?: string | null
  snippet?: string | null
  internalDate?: string | null
  payload?: GmailPartLike | null
}

export interface ParsedEmail {
  summary: EmailSummary
  bodyText: string
  replyTo: string
  messageId?: string
  references?: string
}

function header(part: GmailPartLike | null | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase()
  const found = part?.headers?.find((h) => h.name?.toLowerCase() === wanted)
  return found?.value ?? undefined
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

function findPart(part: GmailPartLike | null | undefined, mimeType: string): GmailPartLike | undefined {
  if (!part) return undefined
  if (part.mimeType === mimeType && part.body?.data) return part
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType)
    if (found) return found
  }
  return undefined
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Decodes a numeric entity; out-of-range values become U+FFFD instead of throwing. */
function codePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '�'
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) return codePoint(parseInt(entity.slice(2), 16))
      if (entity.startsWith('#')) return codePoint(parseInt(entity.slice(1), 10))
      return ENTITIES[entity.toLowerCase()] ?? match
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

export function parseMessage(message: GmailMessageLike): ParsedEmail {
  const payload = message.payload
  const from = header(payload, 'From') ?? '(Remitente desconocido)'
  const internal = Number(message.internalDate)

  const plain = findPart(payload, 'text/plain')
  const html = findPart(payload, 'text/html')
  let bodyText = ''
  if (plain?.body?.data) bodyText = decodeBase64Url(plain.body.data).trim()
  else if (html?.body?.data) bodyText = htmlToText(decodeBase64Url(html.body.data))

  const replyTo = header(payload, 'Reply-To') ?? from
  const parsed: ParsedEmail = {
    summary: {
      id: message.id ?? '',
      threadId: message.threadId ?? '',
      from,
      subject: header(payload, 'Subject')?.trim() || '(Sin asunto)',
      snippet: message.snippet ?? '',
      receivedAt: new Date(Number.isFinite(internal) && internal > 0 ? internal : Date.now()).toISOString(),
      replyTo
    },
    bodyText,
    replyTo
  }
  const messageId = header(payload, 'Message-ID')
  const references = header(payload, 'References')
  if (messageId) parsed.messageId = messageId
  if (references) parsed.references = references
  return parsed
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim()
  if (/^re:/i.test(trimmed)) return trimmed
  return trimmed ? `Re: ${trimmed}` : 'Re:'
}

export interface ReplyDraft {
  to: string
  subject: string
  body: string
  inReplyTo?: string
  references?: string
}

/** Removes CR/LF so a header value can never start a new header. */
function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function encodeHeaderWord(value: string): string {
  return /^[\x00-\x7f]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/** Builds an RFC 2822 reply, base64url-encoded as the Gmail API `raw` field expects. */
export function buildReplyRaw(draft: ReplyDraft): string {
  const headers = [
    `To: ${headerValue(draft.to)}`,
    `Subject: ${encodeHeaderWord(headerValue(replySubject(draft.subject)))}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64'
  ]
  if (draft.inReplyTo) {
    const inReplyTo = headerValue(draft.inReplyTo)
    const chain = [draft.references ? headerValue(draft.references) : '', inReplyTo].filter(Boolean).join(' ')
    headers.push(`In-Reply-To: ${inReplyTo}`, `References: ${chain}`)
  }
  const body = Buffer.from(draft.body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n')
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url')
}
