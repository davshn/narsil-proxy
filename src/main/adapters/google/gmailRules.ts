import { gmail, type gmail_v1 } from '@googleapis/gmail'
import type { OAuth2Client } from 'google-auth-library'
import type { NewServerRule, RuleConditions, ServerRule, ServerRuleAction } from '@shared/types'
import { describeConditions } from '@shared/rules'
import { ReconnectRequiredError, type RuleProvider } from '../../app/ports'
import { GMAIL_SETTINGS_SCOPE } from '../googleAuth'

const INBOX = 'INBOX'
const TRASH = 'TRASH'
const UNNAMED = 'Filtro de Gmail'
/** Criteria Narsil never writes; a filter using any of them is read-only in Narsil. */
const FOREIGN_CRITERIA = ['to', 'negatedQuery', 'hasAttachment', 'excludeChats', 'size', 'sizeComparison'] as const
const INSUFFICIENT_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'])

/** The Gmail filter for a rule; empty conditions are left out of the criteria. */
export function filterRequestBody(rule: NewServerRule): gmail_v1.Schema$Filter {
  const criteria: gmail_v1.Schema$FilterCriteria = {}
  if (rule.conditions.from) criteria.from = rule.conditions.from
  if (rule.conditions.subject) criteria.subject = rule.conditions.subject
  if (rule.conditions.body) criteria.query = rule.conditions.body
  const action: gmail_v1.Schema$FilterAction =
    rule.action === 'archive'
      ? { removeLabelIds: [INBOX] }
      : rule.action === 'delete'
        ? { addLabelIds: [TRASH] }
        : { addLabelIds: [rule.folderId ?? ''], removeLabelIds: [INBOX] }
  return { criteria, action }
}

const same = (ids: string[], expected: string[]): boolean => ids.length === expected.length && ids.every((id, i) => id === expected[i])

/** The rule a Gmail filter is, or a read-only best guess when Narsil never writes that filter. */
export function filterToServerRule(filter: gmail_v1.Schema$Filter, accountId: string, labels: Map<string, string>): ServerRule | null {
  if (!filter.id) return null
  const criteria = filter.criteria ?? {}
  const conditions: RuleConditions = { from: criteria.from ?? '', subject: criteria.subject ?? '', body: criteria.query ?? '' }
  const add = filter.action?.addLabelIds ?? []
  const remove = filter.action?.removeLabelIds ?? []
  const userLabel = add.find((id) => labels.has(id))
  let action: ServerRuleAction | null = null
  if (add.length === 0 && same(remove, [INBOX])) action = 'archive'
  else if (same(add, [TRASH]) && remove.length === 0) action = 'delete'
  else if (userLabel && add.length === 1 && same(remove, [INBOX])) action = 'move'
  const foreign = FOREIGN_CRITERIA.some((key) => Boolean(criteria[key])) || Boolean(filter.action?.forward)
  const managedByNarsil = action !== null && !foreign && Object.values(conditions).some((v) => v.trim() !== '')
  const shown: ServerRuleAction = action ?? (add.includes(TRASH) ? 'delete' : userLabel ? 'move' : 'archive')
  return {
    id: filter.id,
    accountId,
    name: describeConditions(conditions) || UNNAMED,
    conditions,
    action: shown,
    ...(shown === 'move' && userLabel ? { folderId: userLabel, folderName: labels.get(userLabel) ?? '' } : {}),
    managedByNarsil
  }
}

/** True for Google's 403 answer to a token that lacks the scope the request needs. */
export function isInsufficientScope(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const e = error as {
    code?: unknown
    status?: unknown
    message?: unknown
    errors?: Array<{ reason?: unknown }>
    response?: { status?: unknown; data?: { error?: { details?: Array<{ reason?: unknown }>; errors?: Array<{ reason?: unknown }> } } }
  }
  const status = [e.status, e.code, e.response?.status].map(Number).find((n) => Number.isFinite(n) && n > 0)
  if (status !== 403) return false
  const reasons = [...(e.errors ?? []), ...(e.response?.data?.error?.errors ?? []), ...(e.response?.data?.error?.details ?? [])]
  if (reasons.some((r) => typeof r.reason === 'string' && INSUFFICIENT_REASONS.has(r.reason))) return true
  return typeof e.message === 'string' && /insufficient/i.test(e.message)
}

/** Gmail filters of one account through `users.settings.filters`. */
export class GmailRules implements RuleProvider {
  private readonly api: gmail_v1.Gmail

  constructor(
    private readonly auth: OAuth2Client,
    private readonly accountId: string
  ) {
    this.api = gmail({ version: 'v1', auth })
  }

  async list(): Promise<ServerRule[]> {
    return this.call(async () => {
      const [filters, labels] = await Promise.all([this.api.users.settings.filters.list({ userId: 'me' }), this.labelNames()])
      return (filters.data.filter ?? []).flatMap((f) => filterToServerRule(f, this.accountId, labels) ?? [])
    })
  }

  async create(rule: NewServerRule): Promise<ServerRule> {
    return this.call(async () => {
      const res = await this.api.users.settings.filters.create({ userId: 'me', requestBody: filterRequestBody(rule) })
      const labels = new Map(rule.action === 'move' && rule.folderId ? [[rule.folderId, rule.folderName ?? '']] : [])
      const created = filterToServerRule(res.data, this.accountId, labels)
      if (!created) throw new Error('Google no devolvió el filtro creado.')
      return created
    })
  }

  async remove(ruleId: string): Promise<void> {
    await this.call(() => this.api.users.settings.filters.delete({ userId: 'me', id: ruleId }))
  }

  private async labelNames(): Promise<Map<string, string>> {
    const res = await this.api.users.labels.list({ userId: 'me' })
    return new Map((res.data.labels ?? []).flatMap((l) => (l.type === 'user' && l.id ? [[l.id, l.name ?? '']] : [])))
  }

  /**
   * Fails fast without a request when the stored grant is known to lack the settings scope
   * (accounts connected before rules lived in Gmail), and maps Google's 403 to the same error.
   */
  private async call<T>(request: () => Promise<T>): Promise<T> {
    const granted = this.auth.credentials?.scope
    if (typeof granted === 'string' && !granted.split(/\s+/).includes(GMAIL_SETTINGS_SCOPE)) throw new ReconnectRequiredError()
    try {
      return await request()
    } catch (error) {
      if (isInsufficientScope(error)) throw new ReconnectRequiredError()
      throw error
    }
  }
}
