import { randomUUID } from 'node:crypto'
import type {
  AppStatus,
  EmailAction,
  InboxItem,
  Meeting,
  ReminderAlert,
  Rule,
  RuleAction,
  RuleActivity,
  RuleInput
} from '@shared/types'
import { findMatchingRule, normalizeRule } from '@shared/rules'
import type { ParsedEmail } from '../domain/email'
import type { RulesRepository } from '../adapters/rulesStore'
import { dueReminders } from '../domain/reminders'
import type { SecureStore } from '../adapters/secureStore'
import { GoogleAuth } from '../adapters/googleAuth'
import { GmailService } from '../adapters/gmail'
import { CalendarService } from '../adapters/calendar'
import { ClaudeTriage, describeClaudeError } from '../adapters/claude'

const INBOX_POLL_MS = 60_000
const CALENDAR_POLL_MS = 5 * 60_000
const REMINDER_TICK_MS = 15_000
const MAX_ACTIVITY = 50

export interface NarsilEvents {
  inboxChanged(items: InboxItem[]): void
  meetingsChanged(meetings: Meeting[]): void
  reminder(alert: ReminderAlert): void
  statusChanged(status: AppStatus): void
  rulesChanged(rules: Rule[]): void
  activityChanged(activity: RuleActivity[]): void
}

/** A failed triage is retried on later polls up to this many attempts in total. */
const MAX_TRIAGE_ATTEMPTS = 3

interface Tracked {
  parsed: ParsedEmail
  item: InboxItem
  attempts: number
  triaging: boolean
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
  private ruleList: Rule[]
  private activity: RuleActivity[] = []

  constructor(
    private readonly store: SecureStore,
    private readonly events: NarsilEvents,
    private readonly rulesRepo: RulesRepository
  ) {
    this.auth = new GoogleAuth(store)
    this.ruleList = rulesRepo.load()
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

  rules(): Rule[] {
    return this.ruleList
  }

  ruleActivity(): RuleActivity[] {
    return this.activity
  }

  /** Creates or updates a rule, persists it, then applies it to the emails already listed. */
  async saveRule(input: RuleInput): Promise<void> {
    const id = input.id && this.ruleList.some((r) => r.id === input.id) ? input.id : randomUUID()
    const rule = normalizeRule(input, id)
    const exists = this.ruleList.some((r) => r.id === id)
    this.setRules(exists ? this.ruleList.map((r) => (r.id === id ? rule : r)) : [...this.ruleList, rule])
    await this.applyRulesToInbox()
  }

  deleteRule(id: string): void {
    this.setRules(this.ruleList.filter((r) => r.id !== id))
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
    // A new key gets a fresh set of attempts for anything not yet triaged.
    for (const tracked of this.inbox.values()) {
      if (!tracked.item.triage) {
        tracked.attempts = 0
        void this.triage(tracked)
      }
    }
    this.emitStatus()
  }

  async applyAction(emailId: string, action: Exclude<EmailAction, 'reply'>): Promise<void> {
    const gmail = this.requireGmail()
    if (!this.inbox.has(emailId)) throw new Error('Este correo ya no está en la lista.')
    await this.perform(gmail, emailId, action)
    this.removeFromInbox(emailId)
  }

  async sendReply(emailId: string, body: string): Promise<void> {
    const gmail = this.requireGmail()
    const tracked = this.inbox.get(emailId)
    if (!tracked) throw new Error('Este correo ya no está en la lista.')
    if (!body.trim()) throw new Error('La respuesta está vacía.')
    await gmail.reply(tracked.parsed, body)
    this.removeFromInbox(emailId)
  }

  private connectServices(): void {
    const client = this.auth.getAuthorizedClient()
    this.gmail = client ? new GmailService(client) : null
    this.calendar = client ? new CalendarService(client) : null
  }

  private async perform(gmail: GmailService, emailId: string, action: RuleAction): Promise<void> {
    if (action === 'archive') await gmail.archive(emailId)
    else if (action === 'delete') await gmail.trash(emailId)
    else await gmail.save(emailId)
  }

  private setRules(rules: Rule[]): void {
    this.rulesRepo.save(rules)
    this.ruleList = rules
    this.events.rulesChanged(rules)
  }

  /** Runs the first matching rule on an email. Returns true when the email was handled. */
  private async applyRules(gmail: GmailService, parsed: ParsedEmail): Promise<boolean> {
    const rule = findMatchingRule(this.ruleList, {
      from: parsed.summary.from,
      subject: parsed.summary.subject,
      body: parsed.bodyText || parsed.summary.snippet
    })
    if (!rule) return false
    const entry: RuleActivity = {
      id: randomUUID(),
      ruleName: rule.name,
      action: rule.action,
      from: parsed.summary.from,
      subject: parsed.summary.subject,
      at: new Date().toISOString()
    }
    let handled = true
    try {
      await this.perform(gmail, parsed.summary.id, rule.action)
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
      handled = false
    }
    this.activity = [entry, ...this.activity].slice(0, MAX_ACTIVITY)
    this.events.activityChanged(this.activity)
    return handled
  }

  private async applyRulesToInbox(): Promise<void> {
    const gmail = this.gmail
    if (!gmail) return
    let changed = false
    for (const tracked of [...this.inbox.values()]) {
      if (await this.applyRules(gmail, tracked.parsed)) {
        this.inbox.delete(tracked.item.email.id)
        changed = true
      }
    }
    if (changed) this.emitInbox()
  }

  private requireGmail(): GmailService {
    if (!this.gmail) throw new Error('Primero conecta tu cuenta de Google.')
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
      let unreadable = 0
      for (const id of ids) {
        if (this.inbox.has(id)) continue
        try {
          const parsed = await this.gmail.getMessage(id)
          // Rules run before triage, so handled emails never reach Claude.
          if (await this.applyRules(this.gmail, parsed)) continue
          this.inbox.set(id, { parsed, item: { email: parsed.summary, triage: null }, attempts: 0, triaging: false })
          changed = true
        } catch {
          // One unreadable message must not block the rest; it is retried on the next poll.
          unreadable++
        }
      }
      if (changed) this.emitInbox()
      for (const tracked of [...this.inbox.values()]) {
        if (!tracked.item.triage && tracked.attempts < MAX_TRIAGE_ATTEMPTS) await this.triage(tracked)
      }
      if (unreadable > 0) this.setError(`Gmail: no se pudieron leer ${unreadable} correo(s); se reintentará en la próxima revisión.`)
      else this.clearError()
    } catch (error) {
      this.setError(`Gmail: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.inboxBusy = false
    }
  }

  private async triage(tracked: Tracked): Promise<void> {
    if (tracked.triaging) return
    const key = this.anthropicKey()
    if (!key) {
      tracked.item = { ...tracked.item, triageError: 'Agrega tu API key de Anthropic para recibir sugerencias.' }
      this.emitInbox()
      return
    }
    tracked.triaging = true
    tracked.attempts++
    try {
      const triage = await new ClaudeTriage(key).triage(tracked.parsed)
      tracked.item = { email: tracked.item.email, triage }
    } catch (error) {
      tracked.item = { email: tracked.item.email, triage: null, triageError: describeClaudeError(error) }
    } finally {
      tracked.triaging = false
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
      this.setError(`Calendario: ${error instanceof Error ? error.message : String(error)}`)
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
