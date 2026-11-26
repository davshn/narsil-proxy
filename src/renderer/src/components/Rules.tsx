import { useEffect, useState } from 'react'
import type { Rule, RuleAction, RuleActivity, RuleInput } from '@shared/types'
import { describeConditions } from '@shared/rules'

const ACTION_LABEL: Record<RuleAction, string> = {
  archive: 'Archivar',
  delete: 'Eliminar (a la papelera)',
  save: 'Guardar'
}

const DONE: Record<RuleAction, string> = { archive: 'archivó', delete: 'movió a la papelera', save: 'guardó' }
const FAILED: Record<RuleAction, string> = {
  archive: 'no pudo archivar',
  delete: 'no pudo mover a la papelera',
  save: 'no pudo guardar'
}

const EMPTY: RuleInput = {
  name: '',
  enabled: true,
  action: 'archive',
  conditions: { from: '', subject: '', body: '' }
}

interface RulesProps {
  rules: Rule[]
  activity: RuleActivity[]
  /** A draft handed over from an email card; opens the form prefilled. */
  incomingDraft: RuleInput | null
  onDraftTaken(): void
}

export function Rules({ rules, activity, incomingDraft, onDraftTaken }: RulesProps): React.JSX.Element {
  const [draft, setDraft] = useState<RuleInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (incomingDraft) {
      setDraft(incomingDraft)
      setError(null)
      onDraftTaken()
    }
  }, [incomingDraft, onDraftTaken])

  async function save(input: RuleInput): Promise<boolean> {
    setBusy(true)
    setError(null)
    const result = await window.narsil.saveRule(input)
    setBusy(false)
    if (!result.ok) setError(result.error ?? 'No se pudo guardar la regla.')
    return result.ok
  }

  const setCondition = (field: keyof RuleInput['conditions'], value: string): void =>
    setDraft((d) => (d ? { ...d, conditions: { ...d.conditions, [field]: value } } : d))

  return (
    <section className="rules" aria-label="Reglas">
      {draft ? (
        <form
          className="rule-form"
          onSubmit={(e) => {
            e.preventDefault()
            void save(draft).then((ok) => ok && setDraft(null))
          }}
        >
          <h3>{draft.id ? 'Editar regla' : 'Nueva regla'}</h3>
          <p className="rule-form__hint">
            Se aplica a los correos nuevos y a los que ya están en la lista. Deben cumplirse todas las condiciones que llenes.
          </p>
          <label>
            Nombre
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Opcional" />
          </label>
          <label>
            Remitente contiene
            <input value={draft.conditions.from} onChange={(e) => setCondition('from', e.target.value)} placeholder="tienda.com" />
          </label>
          <label>
            Asunto contiene
            <input value={draft.conditions.subject} onChange={(e) => setCondition('subject', e.target.value)} placeholder="oferta" />
          </label>
          <label>
            Texto contiene
            <input value={draft.conditions.body} onChange={(e) => setCondition('body', e.target.value)} placeholder="darse de baja" />
          </label>
          <label>
            Acción
            <select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value as RuleAction })}>
              {(Object.keys(ACTION_LABEL) as RuleAction[]).map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABEL[action]}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p className="rules__error" role="alert">
              {error}
            </p>
          )}
          <div className="rule-form__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setDraft(null)} disabled={busy}>
              Cancelar
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar regla'}
            </button>
          </div>
        </form>
      ) : (
        <div className="rules__head">
          <button type="button" className="btn btn--primary" onClick={() => setDraft(EMPTY)}>
            Nueva regla
          </button>
        </div>
      )}

      {rules.length === 0 ? (
        !draft && (
          <p className="empty">
            Todavía no tienes reglas. Crea una aquí o desde un correo con “Crear regla”.
          </p>
        )
      ) : (
        <ul className="rule-list">
          {rules.map((rule) => (
            <li key={rule.id} className={rule.enabled ? 'rule' : 'rule rule--off'}>
              <div className="rule__text">
                <span className="rule__name">{rule.name}</span>
                <span className="rule__when">
                  {describeConditions(rule.conditions)}: {ACTION_LABEL[rule.action].toLowerCase()}
                </span>
              </div>
              <div className="rule__controls">
                <label className="rule__toggle">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={() => void save({ ...rule, enabled: !rule.enabled })}
                  />
                  Activa
                </label>
                <button type="button" className="link-btn" onClick={() => setDraft(rule)}>
                  Editar
                </button>
                <button type="button" className="link-btn link-btn--danger" onClick={() => void window.narsil.deleteRule(rule.id)}>
                  Borrar
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {activity.length > 0 && (
        <>
          <h3 className="rules__subhead">Actividad reciente</h3>
          <ul className="activity">
            {activity.map((entry) => (
              <li key={entry.id} className={entry.error ? 'activity__item activity__item--error' : 'activity__item'}>
                <time dateTime={entry.at}>
                  {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </time>
                <span>
                  <strong>{entry.ruleName}</strong> {entry.error ? FAILED[entry.action] : DONE[entry.action]} “{entry.subject}”
                  {entry.error && <span className="activity__error">: {entry.error}</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
