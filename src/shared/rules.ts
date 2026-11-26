import type { Rule, RuleConditions, RuleInput } from './types'

/** Pure rule logic shared by the main process (matching) and the renderer (drafts). */

export interface RuleTarget {
  from: string
  subject: string
  body: string
}

const FIELD_LABEL: Record<keyof RuleConditions, string> = {
  from: 'Remitente',
  subject: 'Asunto',
  body: 'Texto'
}

export function emailAddress(mailbox: string): string {
  return (/<([^>]+)>/.exec(mailbox)?.[1] ?? mailbox).trim().toLowerCase()
}

function hasConditions(conditions: RuleConditions): boolean {
  return Object.values(conditions).some((value) => value.trim() !== '')
}

export function matchesRule(rule: Rule, target: RuleTarget): boolean {
  if (!rule.enabled || !hasConditions(rule.conditions)) return false
  return (Object.keys(FIELD_LABEL) as Array<keyof RuleConditions>).every((field) => {
    const needle = rule.conditions[field].trim().toLowerCase()
    return needle === '' || target[field].toLowerCase().includes(needle)
  })
}

/** The first enabled rule, in list order, whose conditions all match. */
export function findMatchingRule(rules: readonly Rule[], target: RuleTarget): Rule | null {
  return rules.find((rule) => matchesRule(rule, target)) ?? null
}

export function describeConditions(conditions: RuleConditions): string {
  return (Object.keys(FIELD_LABEL) as Array<keyof RuleConditions>)
    .filter((field) => conditions[field].trim() !== '')
    .map((field) => `${FIELD_LABEL[field]} contiene "${conditions[field].trim()}"`)
    .join(' y ')
}

/** Trims the input and rejects a rule with no conditions, which would match every email. */
export function normalizeRule(input: RuleInput, id: string): Rule {
  const conditions: RuleConditions = {
    from: input.conditions.from.trim(),
    subject: input.conditions.subject.trim(),
    body: input.conditions.body.trim()
  }
  if (!hasConditions(conditions)) throw new Error('Agrega al menos una condición.')
  return {
    id,
    name: input.name.trim() || describeConditions(conditions),
    enabled: input.enabled,
    action: input.action,
    conditions
  }
}

/** A starting point for a rule about one sender, used by "Crear regla" on an email. */
export function ruleDraftFromEmail(from: string): RuleInput {
  const address = emailAddress(from)
  return {
    name: `Correos de ${address}`,
    enabled: true,
    action: 'archive',
    conditions: { from: address, subject: '', body: '' }
  }
}
