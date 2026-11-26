import type { MailProvider } from '../../app/ports'
import type { ParsedEmail } from '../../domain/email'
import { parseGraphMessage, type GraphMessageLike } from '../../domain/graph'
import { pathSegment, type GraphClient } from './graphClient'

const MAX_MESSAGES = 20
const LOOKBACK_MS = 2 * 24 * 60 * 60_000
const MESSAGE_FIELDS = 'id,conversationId,subject,from,replyTo,bodyPreview,body,receivedDateTime,internetMessageId'

/** Plain text as HTML: escapes markup characters and turns line breaks into `<br>`. */
function textToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r\n|\r|\n/g, '<br>')
}

interface MessageList {
  value?: Array<{ id?: string | null; receivedDateTime?: string | null }>
}

interface InboxFolder {
  unreadItemCount?: number | null
  totalItemCount?: number | null
}

/** Outlook mail for one account through Microsoft Graph. */
export class OutlookMail implements MailProvider {
  constructor(
    private readonly graph: GraphClient,
    private readonly accountId: string
  ) {}

  async listUnread(): Promise<string[]> {
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString()
    // Graph rejects $orderby combined with this $filter as an inefficient filter: sort locally.
    const res = await this.graph.request<MessageList>('GET', '/me/mailFolders/inbox/messages', {
      query: {
        $filter: `isRead eq false and receivedDateTime ge ${since}`,
        $select: 'id,receivedDateTime',
        $top: String(MAX_MESSAGES)
      }
    })
    return (res?.value ?? [])
      .flatMap((m) => (m.id ? [{ id: m.id, at: Date.parse(m.receivedDateTime ?? '') || 0 }] : []))
      .sort((a, b) => b.at - a.at)
      .map((m) => m.id)
  }

  /** `${unreadItemCount}:${totalItemCount}:${newestId}` of the inbox; any new message changes it. */
  async changeToken(): Promise<string> {
    const [folder, newest] = await Promise.all([
      this.graph.request<InboxFolder>('GET', '/me/mailFolders/inbox', {
        query: { $select: 'unreadItemCount,totalItemCount' }
      }),
      // Without $orderby Graph returns the newest message first.
      this.graph.request<MessageList>('GET', '/me/mailFolders/inbox/messages', {
        query: { $top: '1', $select: 'id' }
      })
    ])
    return `${folder?.unreadItemCount ?? ''}:${folder?.totalItemCount ?? ''}:${newest?.value?.[0]?.id ?? ''}`
  }

  async getMessage(id: string): Promise<ParsedEmail> {
    const message = await this.graph.request<GraphMessageLike>('GET', `/me/messages/${pathSegment(id)}`, {
      query: { $select: MESSAGE_FIELDS },
      headers: { Prefer: 'outlook.body-content-type="text"' }
    })
    return parseGraphMessage(message ?? {}, this.accountId)
  }

  /** Marks read, then moves to the Archive folder. Marking first: a move gives the message a new id. */
  async archive(id: string): Promise<void> {
    await this.markRead(id)
    await this.move(id, 'archive')
  }

  /** Moves to Deleted Items, where Outlook keeps it recoverable. Never sends DELETE. */
  async trash(id: string): Promise<void> {
    await this.move(id, 'deleteditems')
  }

  /** Flags for follow-up and marks read, keeping it in the inbox. */
  async save(id: string): Promise<void> {
    await this.graph.request('PATCH', `/me/messages/${pathSegment(id)}`, {
      body: { isRead: true, flag: { flagStatus: 'flagged' } }
    })
  }

  /**
   * Graph's reply keeps the conversation, recipients and subject of the original message.
   * Graph reads `comment` as HTML, so the plain text is escaped and its line breaks kept.
   */
  async reply(email: ParsedEmail, body: string): Promise<void> {
    await this.graph.request('POST', `/me/messages/${pathSegment(email.summary.id)}/reply`, {
      body: { comment: textToHtml(body) }
    })
    await this.markRead(email.summary.id)
  }

  private async markRead(id: string): Promise<void> {
    await this.graph.request('PATCH', `/me/messages/${pathSegment(id)}`, { body: { isRead: true } })
  }

  private async move(id: string, destinationId: string): Promise<void> {
    await this.graph.request('POST', `/me/messages/${pathSegment(id)}/move`, { body: { destinationId } })
  }
}
