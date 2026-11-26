import { randomUUID } from 'node:crypto'
import type {
  Account,
  AppStatus,
  EmailAction,
  InboxItem,
  Meeting,
  ProviderKind,
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
import { ClaudeTriage, describeClaudeError } from '../adapters/claude'
import type { AccountConnection, MailProvider, ProviderAuth } from './ports'
import type { AccountRegistry, SecretStore } from './accounts'

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

/** One provider per kind, each with the extra call that stores its app registration. */
export interface Providers {
  google: ProviderAuth & { saveClientConfig(json: string): void }
  microsoft: ProviderAuth & { saveClientId(clientId: string): void }
}

export interface NarsilDeps {
  store: SecretStore
  events: NarsilEvents
  rules: RulesRepository
  accounts: AccountRegistry
  providers: Providers
  /** Runs once at startup before accounts connect, e.g. the legacy Google token migration. */
  migrate?: () => Promise<void>
}

/** A failed triage is retried on later polls up to this many attempts in total. */
const MAX_TRIAGE_ATTEMPTS = 3

const NOT_CONFIGURED: Record<ProviderKind, string> = {
  google: 'Primero carga tu archivo de cliente OAuth de Google.',
  microsoft: 'Primero guarda el ID de aplicación (cliente) de Microsoft.'
}

interface Tracked {
  key: string
  accountId: string
  parsed: ParsedEmail
  item: InboxItem
  attempts: number
  triaging: boolean
}

interface Connected {
  account: Account
  connection: AccountConnection
}

const itemKey = (accountId: string, messageId: string): string => `${accountId}:${messageId}`

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Application core: polls every connected account's mail and calendar, triages mail
 * with Claude, applies user rules and fires meeting reminders.
 */
export class NarsilService {
  private readonly store: SecretStore
  private readonly events: NarsilEvents
  private readonly rulesRepo: RulesRepository
  private readonly accounts: AccountRegistry
  private readonly providers: Providers
  private readonly migrate: (() => Promise<void>) | undefined
  private readonly connections = new Map<string, Connected>()
  /** Keyed by `${accountId}:${messageId}`. */
  private readonly inbox = new Map<string, Tracked>()
  private readonly meetingsByAccount = new Map<string, Meeting[]>()
  private meetings: Meeting[] = []
  private readonly firedReminders = new Set<string>()
  private readonly timers: NodeJS.Timeout[] = []
  /**
   * Current problems, keyed by source (`${accountId}:mail`, `${accountId}:calendar`,
   * `${accountId}:connect`, `migration`, `startup`).
   */
  private readonly errors = new Map<string, string>()
  /** The latest init() run; sign-ins wait for it so they never race the startup migration. */
  private initRun: Promise<void> | null = null
  /** One sign-in per provider kind; a second click joins it instead of starting another. */
  private readonly adding = new Map<ProviderKind, Promise<void>>()
  private readonly inboxBusy = new Set<string>()
  private ruleList: Rule[]
  private activity: RuleActivity[] = []

  constructor(deps: NarsilDeps) {
    this.store = deps.store
    this.events = deps.events
    this.rulesRepo = deps.rules
    this.accounts = deps.accounts
    this.providers = deps.providers
    this.migrate = deps.migrate
    this.ruleList = this.rulesRepo.load()
  }

  start(): void {
    this.timers.push(
      setInterval(() => void this.pollInbox(), INBOX_POLL_MS),
      setInterval(() => void this.pollCalendar(), CALENDAR_POLL_MS),
      setInterval(() => this.checkReminders(), REMINDER_TICK_MS)
    )
    void this.init()
      .then(() => this.refresh())
      .catch((error: unknown) => this.setError('startup', message(error)))
  }

  /** Runs the startup migration, then connects every stored account. Called by start(). */
  init(): Promise<void> {
    const run = this.runInit()
    this.initRun = run
    return run
  }

  private async runInit(): Promise<void> {
    if (this.migrate) {
      try {
        await this.migrate()
        this.errors.delete('migration')
      } catch (error) {
        // status() already reports a damaged account list; do not blame the migration for it.
        if (this.accountListDamaged()) this.errors.delete('migration')
        else this.errors.set('migration', `No se pudo migrar tu cuenta de Google anterior (se reintentará al reiniciar): ${message(error)}`)
      }
    }
    this.syncConnections()
    this.errors.delete('startup')
    this.emitStatus()
  }

  stop(): void {
    this.timers.forEach(clearInterval)
    this.timers.length = 0
  }

  status(): AppStatus {
    let accounts: Account[] = []
    let damaged: string | undefined
    try {
      accounts = this.accounts.list()
    } catch (error) {
      damaged = message(error)
    }
    const status: AppStatus = {
      accounts,
      hasGoogleClient: this.providers.google.isConfigured(),
      hasMicrosoftClient: this.providers.microsoft.isConfigured(),
      hasAnthropicKey: this.anthropicKey() !== null
    }
    const errors = [...(damaged ? [damaged] : []), ...this.errors.values()]
    if (errors.length > 0) status.lastError = errors.join('\n')
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
    this.providers.google.saveClientConfig(json)
    this.reconnect('google')
    this.emitStatus()
  }

  setMicrosoftClientId(clientId: string): void {
    this.providers.microsoft.saveClientId(clientId)
    this.reconnect('microsoft')
    this.emitStatus()
  }

  /**
   * Signs in a new account in the browser, rejecting one whose email is already connected.
   * A call made while a sign-in of the same kind runs joins it and gets the same outcome.
   */
  addAccount(kind: ProviderKind): Promise<void> {
    let pending = this.adding.get(kind)
    if (!pending) {
      pending = this.runAddAccount(kind).finally(() => this.adding.delete(kind))
      this.adding.set(kind, pending)
    }
    return pending
  }

  private async runAddAccount(kind: ProviderKind): Promise<void> {
    const provider = this.providers[kind]
    if (!provider.isConfigured()) throw new Error(NOT_CONFIGURED[kind])
    await this.initRun?.catch(() => undefined)
    const added = await provider.addAccount()
    const email = added.email.trim()
    const accounts = this.accounts.list()
    // The provider recognized an account that is already registered: never discard its credentials.
    if (!accounts.some((a) => a.id === added.accountId)) {
      const duplicate = accounts.some((a) => a.provider === kind && a.email.toLowerCase() === email.toLowerCase())
      if (duplicate) {
        await provider.removeAccount(added.accountId)
        throw new Error(`La cuenta ${email} ya está conectada.`)
      }
      this.accounts.add({ id: added.accountId, provider: kind, email })
    }
    this.syncConnections()
    this.errors.delete('startup')
    this.emitStatus()
    await this.refresh()
  }

  /** Forgets an account's credentials and drops its emails and meetings. */
  async removeAccount(accountId: string): Promise<void> {
    const account = this.accounts.list().find((a) => a.id === accountId)
    if (!account) return
    await this.providers[account.provider].removeAccount(accountId)
    this.accounts.remove(accountId)
    this.disconnect(accountId)
    this.emitInbox()
    this.events.meetingsChanged(this.meetings)
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

  async applyAction(key: string, action: Exclude<EmailAction, 'reply'>): Promise<void> {
    const { tracked, mail } = this.requireTracked(key)
    await this.perform(mail, tracked.parsed.summary.id, action)
    this.removeFromInbox(key)
  }

  /** Replies from the account that received the email. */
  async sendReply(key: string, body: string): Promise<void> {
    const { tracked, mail } = this.requireTracked(key)
    if (!body.trim()) throw new Error('La respuesta está vacía.')
    await mail.reply(tracked.parsed, body)
    this.removeFromInbox(key)
  }

  private requireTracked(key: string): { tracked: Tracked; mail: MailProvider } {
    const tracked = this.inbox.get(key)
    if (!tracked) throw new Error('Este correo ya no está en la lista.')
    const connected = this.connections.get(tracked.accountId)
    if (!connected) throw new Error('La cuenta de este correo ya no está conectada.')
    return { tracked, mail: connected.connection.mail }
  }

  /** True when the stored account list cannot be read; status() reports it. */
  private accountListDamaged(): boolean {
    try {
      this.accounts.list()
      return false
    } catch {
      return true
    }
  }

  /** Connects stored accounts that are not connected yet and drops removed ones. */
  private syncConnections(): void {
    let accounts: Account[]
    try {
      accounts = this.accounts.list()
    } catch {
      return // A damaged list is reported by status(); keep the current connections.
    }
    const ids = new Set(accounts.map((a) => a.id))
    for (const id of [...this.connections.keys()]) if (!ids.has(id)) this.disconnect(id)
    for (const account of accounts) {
      if (this.connections.has(account.id)) continue
      const source = `${account.id}:connect`
      let connection: AccountConnection | null
      try {
        connection = this.providers[account.provider].connect(account.id)
      } catch (error) {
        // One unreadable credential file must not keep the other accounts from connecting.
        this.errors.set(
          source,
          `${account.email}: no se pudieron leer sus credenciales (${message(error)}). Quita la cuenta y vuelve a agregarla.`
        )
        continue
      }
      if (connection) {
        this.connections.set(account.id, { account, connection })
        this.errors.delete(source)
      } else {
        this.errors.set(source, `${account.email}: faltan sus credenciales. Quita la cuenta y vuelve a agregarla.`)
      }
    }
  }

  /** Rebuilds the connections of one provider after its app registration changed. */
  private reconnect(kind: ProviderKind): void {
    for (const [id, connected] of [...this.connections]) {
      if (connected.account.provider === kind) this.connections.delete(id)
    }
    this.syncConnections()
  }

  private disconnect(accountId: string): void {
    this.connections.delete(accountId)
    for (const [key, tracked] of [...this.inbox]) if (tracked.accountId === accountId) this.inbox.delete(key)
    this.meetingsByAccount.delete(accountId)
    this.mergeMeetings()
    for (const source of [...this.errors.keys()]) if (source.startsWith(`${accountId}:`)) this.errors.delete(source)
  }

  /** True while `connected` is still the live connection for its account. */
  private isLive(connected: Connected): boolean {
    return this.connections.get(connected.account.id) === connected
  }

  private async perform(mail: MailProvider, messageId: string, action: RuleAction): Promise<void> {
    if (action === 'archive') await mail.archive(messageId)
    else if (action === 'delete') await mail.trash(messageId)
    else await mail.save(messageId)
  }

  private setRules(rules: Rule[]): void {
    this.rulesRepo.save(rules)
    this.ruleList = rules
    this.events.rulesChanged(rules)
  }

  /** Runs the first matching rule on an email. Returns true when the email was handled. */
  private async applyRules(mail: MailProvider, parsed: ParsedEmail): Promise<boolean> {
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
      await this.perform(mail, parsed.summary.id, rule.action)
    } catch (error) {
      entry.error = message(error)
      handled = false
    }
    this.activity = [entry, ...this.activity].slice(0, MAX_ACTIVITY)
    this.events.activityChanged(this.activity)
    return handled
  }

  private async applyRulesToInbox(): Promise<void> {
    let changed = false
    for (const tracked of [...this.inbox.values()]) {
      const connected = this.connections.get(tracked.accountId)
      if (!connected) continue
      if (await this.applyRules(connected.connection.mail, tracked.parsed)) {
        this.inbox.delete(tracked.key)
        changed = true
      }
    }
    if (changed) this.emitInbox()
  }

  private anthropicKey(): string | null {
    return this.store.get('anthropic-key') ?? process.env.ANTHROPIC_API_KEY ?? null
  }

  private async pollInbox(): Promise<void> {
    // Each account polls on its own, so a failing or slow account never holds up the others.
    await Promise.all([...this.connections.values()].map((c) => this.pollAccountInbox(c)))
  }

  private async pollAccountInbox(connected: Connected): Promise<void> {
    const { account, connection } = connected
    if (this.inboxBusy.has(account.id)) return
    this.inboxBusy.add(account.id)
    const source = `${account.id}:mail`
    try {
      const ids = await connection.mail.listUnread()
      if (!this.isLive(connected)) return
      const current = new Set(ids.map((id) => itemKey(account.id, id)))
      let changed = false
      for (const [key, tracked] of [...this.inbox]) {
        if (tracked.accountId === account.id && !current.has(key)) {
          this.inbox.delete(key)
          changed = true
        }
      }
      let unreadable = 0
      for (const id of ids) {
        const key = itemKey(account.id, id)
        if (this.inbox.has(key)) continue
        try {
          const parsed = await connection.mail.getMessage(id)
          if (!this.isLive(connected)) return
          // Rules run before triage, so handled emails never reach Claude.
          if (await this.applyRules(connection.mail, parsed)) continue
          this.inbox.set(key, {
            key,
            accountId: account.id,
            parsed,
            item: { key, email: parsed.summary, triage: null },
            attempts: 0,
            triaging: false
          })
          changed = true
        } catch {
          // One unreadable message must not block the rest; it is retried on the next poll.
          unreadable++
        }
      }
      if (changed) this.emitInbox()
      for (const tracked of [...this.inbox.values()]) {
        if (tracked.accountId !== account.id) continue
        if (!tracked.item.triage && tracked.attempts < MAX_TRIAGE_ATTEMPTS) await this.triage(tracked)
      }
      if (unreadable > 0) {
        this.setError(source, `${account.email}: no se pudieron leer ${unreadable} correo(s); se reintentará en la próxima revisión.`)
      } else this.clearError(source)
    } catch (error) {
      if (this.isLive(connected)) this.setError(source, `${account.email}: ${message(error)}`)
    } finally {
      this.inboxBusy.delete(account.id)
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
      tracked.item = { key: tracked.key, email: tracked.item.email, triage }
    } catch (error) {
      tracked.item = { key: tracked.key, email: tracked.item.email, triage: null, triageError: describeClaudeError(error) }
    } finally {
      tracked.triaging = false
    }
    if (this.inbox.has(tracked.key)) this.emitInbox()
  }

  private async pollCalendar(): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map(async (connected) => {
        const source = `${connected.account.id}:calendar`
        try {
          const meetings = await connected.connection.calendar.upcoming()
          if (!this.isLive(connected)) return
          this.meetingsByAccount.set(connected.account.id, meetings)
          this.clearError(source)
        } catch (error) {
          // Keep the last known meetings of this account so its reminders still fire.
          if (this.isLive(connected)) this.setError(source, `${connected.account.email} (calendario): ${message(error)}`)
        }
      })
    )
    this.mergeMeetings()
    this.events.meetingsChanged(this.meetings)
    this.checkReminders()
  }

  private mergeMeetings(): void {
    this.meetings = [...this.meetingsByAccount.values()].flat().sort((a, b) => a.start.localeCompare(b.start))
  }

  private checkReminders(): void {
    for (const alert of dueReminders(this.meetings, new Date(), this.firedReminders)) {
      this.firedReminders.add(alert.key)
      this.events.reminder(alert)
    }
  }

  private removeFromInbox(key: string): void {
    this.inbox.delete(key)
    this.emitInbox()
  }

  private emitInbox(): void {
    this.events.inboxChanged(this.inboxItems())
  }

  private emitStatus(): void {
    this.events.statusChanged(this.status())
  }

  private setError(source: string, text: string): void {
    if (this.errors.get(source) === text) return
    this.errors.set(source, text)
    this.emitStatus()
  }

  private clearError(source: string): void {
    if (!this.errors.delete(source)) return
    this.emitStatus()
  }
}
