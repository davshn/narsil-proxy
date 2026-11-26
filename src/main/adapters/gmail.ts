import { gmail, type gmail_v1 } from '@googleapis/gmail'
import type { OAuth2Client } from 'google-auth-library'
import { buildReplyRaw, parseMessage, type ParsedEmail } from '../domain/email'

/** Unread inbox mail from the last two days, excluding Gmail's promotions and social tabs. */
const INBOX_QUERY = 'in:inbox is:unread newer_than:2d -category:promotions -category:social'
const MAX_MESSAGES = 20

export class GmailService {
  private readonly api: gmail_v1.Gmail

  constructor(auth: OAuth2Client) {
    this.api = gmail({ version: 'v1', auth })
  }

  async listUnread(): Promise<string[]> {
    const res = await this.api.users.messages.list({ userId: 'me', q: INBOX_QUERY, maxResults: MAX_MESSAGES })
    return (res.data.messages ?? []).flatMap((m) => (m.id ? [m.id] : []))
  }

  async getMessage(id: string): Promise<ParsedEmail> {
    const res = await this.api.users.messages.get({ userId: 'me', id, format: 'full' })
    return parseMessage(res.data)
  }

  /** Removes the message from the inbox and marks it read; it stays in All Mail. */
  async archive(id: string): Promise<void> {
    await this.modify(id, [], ['INBOX', 'UNREAD'])
  }

  /** Moves the message to Trash, where Gmail keeps it for 30 days. */
  async trash(id: string): Promise<void> {
    await this.api.users.messages.trash({ userId: 'me', id })
  }

  /** Stars the message and marks it read, keeping it in the inbox. */
  async save(id: string): Promise<void> {
    await this.modify(id, ['STARRED'], ['UNREAD'])
  }

  async reply(email: ParsedEmail, body: string): Promise<void> {
    const raw = buildReplyRaw({
      to: email.replyTo,
      subject: email.summary.subject === '(Sin asunto)' ? '' : email.summary.subject,
      body,
      ...(email.messageId ? { inReplyTo: email.messageId } : {}),
      ...(email.references ? { references: email.references } : {})
    })
    await this.api.users.messages.send({ userId: 'me', requestBody: { raw, threadId: email.summary.threadId } })
    await this.modify(email.summary.id, [], ['UNREAD'])
  }

  private async modify(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void> {
    await this.api.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds, removeLabelIds } })
  }
}
