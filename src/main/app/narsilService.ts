import { randomUUID } from 'node:crypto'
import type {
  Account,
  AccountRules,
  AccountSettings,
  AppStatus,
  ConvertTarget,
  EmailAction,
  InboxItem,
  MailFolder,
  Meeting,
  NewServerRule,
  ProviderKind,
  ReminderAlert,
  Rule,
  RuleActivity,
  RuleInput,
  ServerRule,
  ServerRuleInput
} from '@shared/types'
import { findMatchingRule, normalizeFolderName, normalizeRule, normalizeServerRule, serverActionForLocal } from '@shared/rules'
import type { ParsedEmail } from '../domain/email'
import type { RulesRepository } from '../adapters/rulesStore'
import { dueReminders } from '../domain/reminders'
import { ClaudeTriage, describeClaudeError } from '../adapters/claude'
import { ReconnectRequiredError, type AccountConnection, type MailProvider, type ProviderAuth } from './ports'
import type { AccountRegistry, SecretStore } from './accounts'

const INBOX_POLL_MS = 60_000
/** The cheap change check; a full inbox poll runs only when an account's token changed. */
const CHANGE_CHECK_MS = 15_000
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
  serverRulesChanged(rules: AccountRules[]): void
  /**
   * Emails that arrived since the previous poll of one account, after their triage attempt.
   * Never empty. Excludes emails a rule handled, those received before the account's first load
   * and those already announced once.
   */
  newEmails(items: InboxItem[]): void
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
/** How many announced message ids each account remembers, so none is announced twice. */
const MAX_ANNOUNCED = 500

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
  /** The triage in flight, if any; a second caller awaits it instead of starting another. */
  triaging: Promise<void> | null
}

interface Connected {
  account: Account
  connection: AccountConnection
}

/** The last listed server rules of one account. */
interface RuleListState {
  rules: ServerRule[]
  error?: string
}

const UNKNOWN_ACCOUNT = 'Esta cuenta ya no está conectada.'

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
  /**
   * Connections with an inbox poll or a change check in flight. Keyed by the connection, not
   * the account id, so a poll of a removed account never blocks or unblocks its re-added successor.
   */
  private readonly inboxBusy = new Set<Connected>()
  /** The inbox poll in flight per connection, so a settings change can wait for it. */
  private readonly inboxRuns = new Map<Connected, Promise<void>>()
  private readonly changeChecking = new Set<Connected>()
  /** The change token each account had when its inbox was last listed and fully read. */
  private readonly changeTokens = new Map<string, string>()
  /**
   * When each account's first successful inbox load listed (epoch ms). Only mail received after
   * it is announced, so mail that was already unread then never notifies, even if it is listed later.
   */
  private readonly firstLoadAt = new Map<string, number>()
  /** Message ids already announced per account, oldest first, capped at MAX_ANNOUNCED. */
  private readonly announced = new Map<string, Set<string>>()
  private ruleList: Rule[]
  private activity: RuleActivity[] = []
  /** Server rules per account id, set once that account was listed. */
  private readonly serverRuleLists = new Map<string, RuleListState>()
  /** Accounts that lack the rule permission; reported in status(), never as an error. */
  private readonly reconnectNeeded = new Set<string>()
  /** One reconnect sign-in per account; a second click joins it. */
  private readonly reconnecting = new Map<string, Promise<void>>()

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
      setInterval(() => void this.checkInboxChanges(), CHANGE_CHECK_MS),
      setInterval(() => void this.pollCalendar(), CALENDAR_POLL_MS),
      setInterval(() => this.checkReminders(), REMINDER_TICK_MS)
    )
    void this.init()
      .then(() => Promise.all([this.refresh(), this.loadServerRules()]))
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
      accounts: accounts.map((a) => (this.reconnectNeeded.has(a.id) ? { ...a, needsReconnect: true } : a)),
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
    const previous = input.id ? this.ruleList.find((r) => r.id === input.id) : undefined
    const id = previous?.id ?? randomUUID()
    // An old save rule without a folder can still be renamed or toggled; it keeps archiving.
    const rule = normalizeRule(input, id, previous?.action === 'save' && !previous.folder)
    const exists = this.ruleList.some((r) => r.id === id)
    this.setRules(exists ? this.ruleList.map((r) => (r.id === id ? rule : r)) : [...this.ruleList, rule])
    await this.applyRulesToInbox()
  }

  deleteRule(id: string): void {
    this.setRules(this.ruleList.filter((r) => r.id !== id))
  }

  /** The last listed server rules of every connected account, in account order. */
  serverRules(): AccountRules[] {
    return [...this.connections.keys()].map((accountId) => {
      const state = this.serverRuleLists.get(accountId)
      return {
        accountId,
        rules: state?.rules ?? [],
        loaded: state !== undefined,
        needsReconnect: this.reconnectNeeded.has(accountId),
        ...(state?.error ? { error: state.error } : {})
      }
    })
  }

  /**
   * Lists the server rules of every connected account (or only `accountId`). Never throws: a
   * missing permission flags the account, any other failure stays on that account's list.
   */
  async loadServerRules(accountId?: string): Promise<void> {
    const targets = [...this.connections.values()].filter((c) => accountId === undefined || c.account.id === accountId)
    await Promise.all(targets.map((c) => this.loadAccountRules(c)))
    this.emitServerRules()
  }

  private async loadAccountRules(connected: Connected): Promise<void> {
    const id = connected.account.id
    try {
      const rules = await connected.connection.rules.list()
      if (!this.isLive(connected)) return
      this.serverRuleLists.set(id, { rules })
      this.setReconnectNeeded(id, false)
    } catch (error) {
      if (!this.isLive(connected)) return
      if (error instanceof ReconnectRequiredError) {
        this.serverRuleLists.set(id, { rules: [] })
        this.setReconnectNeeded(id, true)
      } else {
        this.serverRuleLists.set(id, { rules: this.serverRuleLists.get(id)?.rules ?? [], error: message(error) })
      }
    }
  }

  /**
   * Creates a rule on its account, or replaces rule `input.id` there (remove, then create: Gmail
   * filters cannot be updated). Then applies it once to that account's listed emails.
   */
  async saveServerRule(input: ServerRuleInput): Promise<void> {
    const connected = this.requireConnected(input.accountId)
    const rule = normalizeServerRule(input)
    const rules = connected.connection.rules
    const replacing = input.id
    if (replacing) {
      await this.ruleCall(connected, () => rules.remove(replacing))
      this.patchServerRules(input.accountId, (list) => list.filter((r) => r.id !== replacing))
    }
    let created: ServerRule
    try {
      created = await this.ruleCall(connected, () => rules.create(rule))
    } catch (error) {
      if (replacing && !(error instanceof ReconnectRequiredError)) {
        throw new Error(`Se quitó la regla anterior, pero no se pudo crear la nueva: ${message(error)}`)
      }
      throw error
    }
    this.patchServerRules(input.accountId, (list) => [...list, created])
    await this.applyServerRuleOnce(connected, rule)
  }

  async deleteServerRule(accountId: string, ruleId: string): Promise<void> {
    const connected = this.requireConnected(accountId)
    await this.ruleCall(connected, () => connected.connection.rules.remove(ruleId))
    this.patchServerRules(accountId, (list) => list.filter((r) => r.id !== ruleId))
  }

  /**
   * Replaces a local rule with a server rule, then deletes the local one; if the server rule
   * cannot be created the local rule stays. A save rule with a folder goes to that folder's
   * account; any other rule needs `target.accountId`, and an old save rule also a folder.
   */
  async convertLocalRule(ruleId: string, target?: ConvertTarget): Promise<void> {
    const rule = this.ruleList.find((r) => r.id === ruleId)
    if (!rule) throw new Error('Esta regla ya no existe.')
    const action = serverActionForLocal(rule.action)
    let input: ServerRuleInput
    if (rule.action === 'save' && rule.folder) {
      const { accountId, id, name } = rule.folder
      input = { accountId, name: rule.name, conditions: rule.conditions, action, folderId: id, folderName: name }
    } else {
      if (!target?.accountId) throw new Error('Elige la cuenta donde se guarda esta regla.')
      input = { accountId: target.accountId, name: rule.name, conditions: rule.conditions, action }
      if (action === 'move' && target.folderId) {
        input.folderId = target.folderId
        input.folderName = target.folderName ?? ''
      }
    }
    await this.saveServerRule(input)
    this.deleteRule(ruleId)
  }

  /**
   * Signs in again to a stored account with its own email (to grant the rule permission), then
   * rebuilds its connection with the new credentials, keeping its listed emails, and lists its
   * rules again. A call made while one runs for that account joins it.
   */
  reconnectAccount(accountId: string): Promise<void> {
    let pending = this.reconnecting.get(accountId)
    if (!pending) {
      pending = this.runReconnect(accountId).finally(() => this.reconnecting.delete(accountId))
      this.reconnecting.set(accountId, pending)
    }
    return pending
  }

  private async runReconnect(accountId: string): Promise<void> {
    const account = this.accounts.list().find((a) => a.id === accountId)
    if (!account) throw new Error(UNKNOWN_ACCOUNT)
    await this.initRun?.catch(() => undefined)
    const provider = this.providers[account.provider]
    await provider.reconnect(accountId, account.email)
    const connection = provider.connect(accountId)
    if (connection) {
      this.connections.set(accountId, { account: this.connections.get(accountId)?.account ?? account, connection })
      this.errors.delete(`${accountId}:connect`)
    }
    this.setReconnectNeeded(accountId, false)
    this.emitStatus()
    await this.loadServerRules(accountId)
  }

  /** Runs a rule call; a missing permission flags the account before the error goes on. */
  private async ruleCall<T>(connected: Connected, call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (error instanceof ReconnectRequiredError && this.isLive(connected)) {
        this.setReconnectNeeded(connected.account.id, true)
        this.emitServerRules()
      }
      throw error
    }
  }

  private patchServerRules(accountId: string, change: (rules: ServerRule[]) => ServerRule[]): void {
    const state = this.serverRuleLists.get(accountId)
    this.serverRuleLists.set(accountId, { rules: change(state?.rules ?? []) })
    this.emitServerRules()
  }

  /**
   * The account applies a new rule only to mail that arrives later, so Narsil runs it once on
   * the emails of that account it lists now, logging each in the recent activity.
   */
  private async applyServerRuleOnce(connected: Connected, rule: NewServerRule): Promise<void> {
    const accountId = connected.account.id
    const local: Rule = {
      id: 'server-rule',
      name: rule.name,
      enabled: true,
      conditions: rule.conditions,
      action: rule.action === 'move' ? 'save' : rule.action,
      ...(rule.action === 'move' && rule.folderId
        ? { folder: { accountId, id: rule.folderId, name: rule.folderName ?? '' } }
        : {})
    }
    let changed = false
    for (const tracked of [...this.inbox.values()]) {
      if (tracked.accountId !== accountId || !this.isLive(connected)) continue
      if (await this.applyRules(connected.connection.mail, tracked.parsed, [local])) {
        this.inbox.delete(tracked.key)
        changed = true
      }
    }
    if (changed) this.emitInbox()
  }

  private setReconnectNeeded(accountId: string, needed: boolean): void {
    if (this.reconnectNeeded.has(accountId) === needed) return
    if (needed) this.reconnectNeeded.add(accountId)
    else this.reconnectNeeded.delete(accountId)
    this.emitStatus()
  }

  private emitServerRules(): void {
    this.events.serverRulesChanged(this.serverRules())
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
    this.emitServerRules()
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

  /** Acts on an email from the account that received it; `save` moves it to `folderId`. */
  async applyAction(key: string, action: Exclude<EmailAction, 'reply'>, folderId?: string): Promise<void> {
    const { tracked, mail } = this.requireTracked(key)
    const id = tracked.parsed.summary.id
    if (action === 'archive') await mail.archive(id)
    else if (action === 'delete') await mail.trash(id)
    else {
      if (!folderId) throw new Error('Elige una carpeta para guardar este correo.')
      await mail.moveToFolder(id, folderId)
    }
    this.removeFromInbox(key)
  }

  /** The folders of one connected account, for "Guardar" and save rules. */
  async listFolders(accountId: string): Promise<MailFolder[]> {
    return this.requireConnected(accountId).connection.mail.listFolders()
  }

  async createFolder(accountId: string, name: string): Promise<MailFolder> {
    const valid = normalizeFolderName(name)
    return this.requireConnected(accountId).connection.mail.createFolder(valid)
  }

  /** Saves an account's inbox settings, then lists that account's inbox again with them. */
  async setAccountSettings(accountId: string, settings: AccountSettings): Promise<void> {
    const account = this.accounts.setSettings(accountId, settings)
    this.emitStatus()
    const connected = this.connections.get(accountId)
    if (!connected) return
    connected.account = account
    // A poll already running uses the old settings: wait for it, then list again.
    await this.inboxRuns.get(connected)
    if (!this.isLive(connected)) return
    this.changeTokens.delete(accountId)
    await this.pollAccountInbox(connected)
  }

  private requireConnected(accountId: string): Connected {
    const connected = this.connections.get(accountId)
    if (!connected) throw new Error(UNKNOWN_ACCOUNT)
    return connected
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
    this.changeTokens.delete(accountId)
    this.firstLoadAt.delete(accountId)
    this.announced.delete(accountId)
    this.serverRuleLists.delete(accountId)
    this.reconnectNeeded.delete(accountId)
    this.mergeMeetings()
    for (const source of [...this.errors.keys()]) if (source.startsWith(`${accountId}:`)) this.errors.delete(source)
  }

  /** True while `connected` is still the live connection for its account. */
  private isLive(connected: Connected): boolean {
    return this.connections.get(connected.account.id) === connected
  }

  /** Runs a rule's action. A save rule moves to its folder; an old one without a folder archives. */
  private async performRule(mail: MailProvider, messageId: string, rule: Rule): Promise<void> {
    if (rule.action === 'delete') await mail.trash(messageId)
    else if (rule.action === 'save' && rule.folder) await mail.moveToFolder(messageId, rule.folder.id)
    else await mail.archive(messageId)
  }

  private setRules(rules: Rule[]): void {
    this.rulesRepo.save(rules)
    this.ruleList = rules
    this.events.rulesChanged(rules)
  }

  /** Runs the first matching rule on an email. Returns true when the email was handled. */
  private async applyRules(mail: MailProvider, parsed: ParsedEmail, rules: readonly Rule[] = this.ruleList): Promise<boolean> {
    const rule = findMatchingRule(rules, {
      from: parsed.summary.from,
      subject: parsed.summary.subject,
      body: parsed.bodyText || parsed.summary.snippet,
      accountId: parsed.summary.accountId
    })
    if (!rule) return false
    const entry: RuleActivity = {
      id: randomUUID(),
      ruleName: rule.name,
      action: rule.action === 'save' && !rule.folder ? 'archive' : rule.action,
      ...(rule.action === 'save' && rule.folder ? { folderName: rule.folder.name } : {}),
      from: parsed.summary.from,
      subject: parsed.summary.subject,
      at: new Date().toISOString()
    }
    let handled = true
    try {
      await this.performRule(mail, parsed.summary.id, rule)
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

  /** The fast tick: lists an account's inbox only when its change token moved. Never throws. */
  private async checkInboxChanges(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => this.checkAccountChanges(c)))
  }

  private async checkAccountChanges(connected: Connected): Promise<void> {
    const { account, connection } = connected
    // A hung check must not pile up a new request every tick; the full poll still runs meanwhile.
    if (this.inboxBusy.has(connected) || this.changeChecking.has(connected)) return
    this.changeChecking.add(connected)
    try {
      let token: string
      try {
        token = await connection.mail.changeToken()
      } catch (error) {
        if (!this.isLive(connected)) return
        // Forget the token so the next check that works lists the inbox.
        this.changeTokens.delete(account.id)
        this.setError(`${account.id}:mail`, `${account.email}: ${message(error)}`)
        return
      }
      if (!this.isLive(connected) || this.changeTokens.get(account.id) === token) return
      await this.pollAccountInbox(connected, token)
    } finally {
      this.changeChecking.delete(connected)
    }
  }

  /**
   * Lists one account's inbox, applies rules, triages new emails and announces the ones that
   * arrived since the previous poll. `knownToken` is the change token the caller just read.
   */
  private pollAccountInbox(connected: Connected, knownToken?: string): Promise<void> {
    if (this.inboxBusy.has(connected)) return Promise.resolve()
    const run: Promise<void> = this.runAccountInboxPoll(connected, knownToken).finally(() => {
      if (this.inboxRuns.get(connected) === run) this.inboxRuns.delete(connected)
    })
    this.inboxRuns.set(connected, run)
    return run
  }

  private async runAccountInboxPoll(connected: Connected, knownToken?: string): Promise<void> {
    const { account, connection } = connected
    this.inboxBusy.add(connected)
    const source = `${account.id}:mail`
    try {
      // Read the token before listing, so mail that arrives mid-poll still changes it afterwards.
      let token = knownToken
      let tokenError: unknown = null
      if (token === undefined) {
        try {
          token = await connection.mail.changeToken()
        } catch (error) {
          tokenError = error
        }
      }
      const listedAt = Date.now()
      const ids = await connection.mail.listUnread(account.settings)
      if (!this.isLive(connected)) return
      // Mail received before the account's first load was there before Narsil; only later mail is news.
      // The list holds a limited window, so this is judged by when an email arrived, not by
      // whether it was listed before.
      const since = this.firstLoadAt.get(account.id)
      const announced = this.announced.get(account.id)
      const isNews = (parsed: ParsedEmail): boolean =>
        since !== undefined &&
        Date.parse(parsed.summary.receivedAt) > since &&
        !(announced?.has(parsed.summary.id) ?? false)
      const arrived: Tracked[] = []
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
          if (!this.isLive(connected)) return
          const tracked: Tracked = {
            key,
            accountId: account.id,
            parsed,
            item: { key, email: parsed.summary, triage: null },
            attempts: 0,
            triaging: null
          }
          this.inbox.set(key, tracked)
          if (isNews(parsed)) arrived.push(tracked)
          changed = true
        } catch {
          // One unreadable message must not block the rest; it is retried on the next poll.
          unreadable++
        }
      }
      if (changed) this.emitInbox()
      for (const tracked of [...this.inbox.values()]) {
        if (tracked.accountId !== account.id || tracked.item.triage) continue
        // Join a triage already in flight (e.g. one a new API key started) so the announcement carries it.
        if (tracked.triaging || tracked.attempts < MAX_TRIAGE_ATTEMPTS) await this.triage(tracked)
      }
      if (!this.isLive(connected)) return
      if (since === undefined) this.firstLoadAt.set(account.id, listedAt)
      // After a partial read, forget the token so the next change check lists (and retries) again.
      if (token === undefined || unreadable > 0) this.changeTokens.delete(account.id)
      else this.changeTokens.set(account.id, token)
      // An action or a rule may have removed an email while it was being triaged.
      const fresh = arrived.filter((t) => this.inbox.has(t.key))
      if (fresh.length > 0) {
        this.markAnnounced(account.id, fresh)
        this.events.newEmails(fresh.map((t) => t.item))
      }
      if (unreadable > 0) {
        this.setError(source, `${account.email}: no se pudieron leer ${unreadable} correo(s); se reintentará en la próxima revisión.`)
      } else if (tokenError !== null) {
        this.setError(source, `${account.email}: ${message(tokenError)}`)
      } else this.clearError(source)
    } catch (error) {
      if (this.isLive(connected)) this.setError(source, `${account.email}: ${message(error)}`)
    } finally {
      this.inboxBusy.delete(connected)
    }
  }

  /** Remembers announced ids so the same email never notifies twice, keeping the newest MAX_ANNOUNCED. */
  private markAnnounced(accountId: string, tracked: Tracked[]): void {
    let ids = this.announced.get(accountId)
    if (!ids) this.announced.set(accountId, (ids = new Set()))
    for (const t of tracked) ids.add(t.parsed.summary.id)
    for (const id of ids) {
      if (ids.size <= MAX_ANNOUNCED) break
      ids.delete(id)
    }
  }

  /** Triages one email; a call made while its triage runs awaits that same run. */
  private triage(tracked: Tracked): Promise<void> {
    if (tracked.triaging) return tracked.triaging
    const key = this.anthropicKey()
    if (!key) {
      tracked.item = { ...tracked.item, triageError: 'Agrega tu API key de Anthropic para recibir sugerencias.' }
      this.emitInbox()
      return Promise.resolve()
    }
    tracked.attempts++
    const run = this.runTriage(tracked, key).finally(() => {
      tracked.triaging = null
    })
    tracked.triaging = run
    return run
  }

  private async runTriage(tracked: Tracked, key: string): Promise<void> {
    try {
      const triage = await new ClaudeTriage(key).triage(tracked.parsed)
      tracked.item = { key: tracked.key, email: tracked.item.email, triage }
    } catch (error) {
      tracked.item = { key: tracked.key, email: tracked.item.email, triage: null, triageError: describeClaudeError(error) }
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
