import type { AppStatus, EmailAction, InboxItem, Meeting, ReminderAlert } from '@shared/types'
import type { ParsedEmail } from '../domain/email'
import { dueReminders } from '../domain/reminders'
import type { SecureStore } from '../adapters/secureStore'
import { GoogleAuth } from '../adapters/googleAuth'
import { GmailService } from '../adapters/gmail'
import { CalendarService } from '../adapters/calendar'
import { ClaudeTriage, describeClaudeError } from '../adapters/claude'

const INBOX_POLL_MS = 60_000
const CALENDAR_POLL_MS = 5 * 60_000
const REMINDER_TICK_MS = 15_000

export interface NarsilEvents {
  inboxChanged(items: InboxItem[]): void
  meetingsChanged(meetings: Meeting[]): void
  reminder(alert: ReminderAlert): void
  statusChanged(status: AppStatus): void
}

interface Tracked {
  parsed: ParsedEmail
  item: InboxItem
}

/** Application core: polls Gmail and Calendar, triages mail with Claude and fires reminders. */
export class NarsilService {
  readonly auth: GoogleAuth
  private gmail: GmailService | null = null
  private calendar: CalendarService | null = null
  private readonly inbox = new Map<string, Tracked>()
  private meetings: Meeting[] = []
  private readonly firedReminders = new Set<string>()
  private readonly timers: NodeJS.Timeout[] = []
  private lastError: string | undefined
  private inboxBusy = false

  constructor(
    private readonly store: SecureStore,
    private readonly events: NarsilEvents
  ) {
    this.auth = new GoogleAuth(store)
  }

  start(): void {
    this.connectServices()
    this.timers.push(
      setInterval(() => void this.pollInbox(), INBOX_POLL_MS),
      setInterval(() => void this.pollCalendar(), CALENDAR_POLL_MS),
      setInterval(() => this.checkReminders(), REMINDER_TICK_MS)
    )
    void this.refresh()
  }

  stop(): void {
    this.timers.forEach(clearInterval)
    this.timers.length = 0
  }

  status(): AppStatus {
    const status: AppStatus = {
      hasGoogleClient: this.auth.hasClientConfig(),
      googleConnected: this.auth.isConnected(),
      hasAnthropicKey: this.anthropicKey() !== null
    }
    if (this.lastError) status.lastError = this.lastError
    return status
  }

  inboxItems(): InboxItem[] {
    return [...this.inbox.values()]
      .map((t) => t.item)
      .sort((a, b) => b.email.receivedAt.localeCompare(a.email.receivedAt))
  }

  upcomingMeetings(): Meeting[] {
    return this.meetings
  }

  async refresh(): Promise<void> {
    await Promise.all([this.pollInbox(), this.pollCalendar()])
  }

  importGoogleClient(json: string): void {
    this.auth.saveClientConfig(json)
    this.emitStatus()
  }

  async connectGoogle(): Promise<void> {
    await this.auth.connect()
    this.connectServices()
    this.lastError = undefined
    this.emitStatus()
    await this.refresh()
  }

  async disconnectGoogle(): Promise<void> {
    await this.auth.disconnect()
    this.gmail = null
    this.calendar = null
    this.inbox.clear()
    this.meetings = []
    this.events.inboxChanged([])
    this.events.meetingsChanged([])
    this.emitStatus()
  }

  setAnthropicKey(key: string): void {
    const trimmed = key.trim()
    if (trimmed) this.store.set('anthropic-key', trimmed)
    else this.store.delete('anthropic-key')
    // Re-triage anything that failed for lack of a key.
    for (const tracked of this.inbox.values()) {
      if (!tracked.item.triage) void this.triage(tracked)
    }
    this.emitStatus()
  }

  async applyAction(emailId: string, action: Exclude<EmailAction, 'reply'>): Promise<void> {
    const gmail = this.requireGmail()
    if (!this.inbox.has(emailId)) throw new Error('This email is no longer in the list.')
    if (action === 'archive') await gmail.archive(emailId)
    else if (action === 'delete') await gmail.trash(emailId)
    else await gmail.save(emailId)
    this.removeFromInbox(emailId)
  }

  async sendReply(emailId: string, body: string): Promise<void> {
    const gmail = this.requireGmail()
    const tracked = this.inbox.get(emailId)
    if (!tracked) throw new Error('This email is no longer in the list.')
    if (!body.trim()) throw new Error('The reply is empty.')
    await gmail.reply(tracked.parsed, body)
    this.removeFromInbox(emailId)
  }

  private connectServices(): void {
    const client = this.auth.getAuthorizedClient()
    this.gmail = client ? new GmailService(client) : null
    this.calendar = client ? new CalendarService(client) : null
  }

  private requireGmail(): GmailService {
    if (!this.gmail) throw new Error('Connect your Google account first.')
    return this.gmail
  }

  private anthropicKey(): string | null {
    return this.store.get('anthropic-key') ?? process.env.ANTHROPIC_API_KEY ?? null
  }

  private async pollInbox(): Promise<void> {
    if (!this.gmail || this.inboxBusy) return
    this.inboxBusy = true
    try {
      const ids = await this.gmail.listUnread()
      const current = new Set(ids)
      let changed = false
      for (const id of [...this.inbox.keys()]) {
        if (!current.has(id)) {
          this.inbox.delete(id)
          changed = true
        }
      }
      const fresh: Tracked[] = []
      for (const id of ids) {
        if (this.inbox.has(id)) continue
        const parsed = await this.gmail.getMessage(id)
        const tracked: Tracked = { parsed, item: { email: parsed.summary, triage: null } }
        this.inbox.set(id, tracked)
        fresh.push(tracked)
        changed = true
      }
      if (changed) this.emitInbox()
      for (const tracked of fresh) await this.triage(tracked)
      this.clearError()
    } catch (error) {
      this.setError(`Gmail: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.inboxBusy = false
    }
  }

  private async triage(tracked: Tracked): Promise<void> {
    const key = this.anthropicKey()
    if (!key) {
      tracked.item = { ...tracked.item, triageError: 'Add your Anthropic API key to get suggestions.' }
      this.emitInbox()
      return
    }
    try {
      const triage = await new ClaudeTriage(key).triage(tracked.parsed)
      tracked.item = { email: tracked.item.email, triage }
    } catch (error) {
      tracked.item = { email: tracked.item.email, triage: null, triageError: describeClaudeError(error) }
    }
    if (this.inbox.has(tracked.item.email.id)) this.emitInbox()
  }

  private async pollCalendar(): Promise<void> {
    if (!this.calendar) return
    try {
      this.meetings = await this.calendar.upcoming()
      this.events.meetingsChanged(this.meetings)
      this.checkReminders()
      this.clearError()
    } catch (error) {
      this.setError(`Calendar: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private checkReminders(): void {
    for (const alert of dueReminders(this.meetings, new Date(), this.firedReminders)) {
      this.firedReminders.add(alert.key)
      this.events.reminder(alert)
    }
  }

  private removeFromInbox(id: string): void {
    this.inbox.delete(id)
    this.emitInbox()
  }

  private emitInbox(): void {
    this.events.inboxChanged(this.inboxItems())
  }

  private emitStatus(): void {
    this.events.statusChanged(this.status())
  }

  private setError(message: string): void {
    this.lastError = message
    this.emitStatus()
  }

  private clearError(): void {
    if (this.lastError === undefined) return
    this.lastError = undefined
    this.emitStatus()
  }
}
