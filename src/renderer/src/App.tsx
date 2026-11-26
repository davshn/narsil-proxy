import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppStatus, InboxItem, Meeting, ReminderAlert, Rule, RuleActivity, RuleInput } from '@shared/types'
import { ruleDraftFromEmail } from '@shared/rules'
import { Shard } from './components/Shard'
import { EmailCard } from './components/EmailCard'
import { Meetings } from './components/Meetings'
import { Setup } from './components/Setup'
import { Rules } from './components/Rules'

type Tab = 'mail' | 'meetings' | 'rules' | 'setup'

const EMPTY_STATUS: AppStatus = { accounts: [], hasGoogleClient: false, hasMicrosoftClient: false, hasAnthropicKey: false }

/** Ready once at least one mailbox is connected and Claude can triage. */
function isReady(s: AppStatus): boolean {
  return s.accounts.length > 0 && s.hasAnthropicKey
}

export function App(): React.JSX.Element {
  const [status, setStatus] = useState<AppStatus>(EMPTY_STATUS)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [alert, setAlert] = useState<ReminderAlert | null>(null)
  const [expanded, setExpandedState] = useState(false)
  const [tab, setTab] = useState<Tab>('mail')
  const [refreshing, setRefreshing] = useState(false)
  const [rules, setRules] = useState<Rule[]>([])
  const [activity, setActivity] = useState<RuleActivity[]>([])
  const [ruleDraft, setRuleDraft] = useState<RuleInput | null>(null)
  const takeRuleDraft = useCallback(() => setRuleDraft(null), [])
  /** The email a clicked notification asked to show; cleared once it is scrolled into view. */
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<string | null>(null)

  const setExpanded = useCallback((value: boolean) => {
    setExpandedState(value)
    void window.narsil.setExpanded(value)
  }, [])

  useEffect(() => {
    void window.narsil.getStatus().then((s) => {
      setStatus(s)
      if (!isReady(s)) setTab('setup')
    })
    void window.narsil.getInbox().then(setInbox)
    void window.narsil.getMeetings().then(setMeetings)
    void window.narsil.getRules().then(setRules)
    void window.narsil.getRuleActivity().then(setActivity)
    const offs = [
      window.narsil.onStatusChanged(setStatus),
      window.narsil.onInboxChanged(setInbox),
      window.narsil.onMeetingsChanged(setMeetings),
      window.narsil.onRulesChanged(setRules),
      window.narsil.onRuleActivityChanged(setActivity),
      window.narsil.onReminder((a) => {
        setAlert(a)
        setTab('meetings')
        setExpanded(true)
      }),
      window.narsil.onFocusEmail((key) => {
        setExpanded(true)
        setTab('mail')
        setFocusKey(key)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [setExpanded])

  // Runs after the panel rendered the mail list, so the card exists to scroll to.
  useEffect(() => {
    if (focusKey === null || !expanded || tab !== 'mail') return
    setFocusKey(null)
    const card = document.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)
    if (!card) return
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' })
    setHighlighted(focusKey)
  }, [focusKey, expanded, tab])

  useEffect(() => {
    if (highlighted === null) return
    const timer = setTimeout(() => setHighlighted(null), 2000)
    return () => clearTimeout(timer)
  }, [highlighted])

  const onAction = useCallback(async (key: string, action: 'archive' | 'delete' | 'save') => {
    const result = await window.narsil.applyAction(key, action)
    return result.ok ? null : (result.error ?? 'La acción falló.')
  }, [])

  const onReply = useCallback(async (key: string, body: string) => {
    const result = await window.narsil.sendReply(key, body)
    return result.ok ? null : (result.error ?? 'No se pudo enviar la respuesta.')
  }, [])

  const onCreateRule = useCallback((from: string) => {
    setRuleDraft(ruleDraftFromEmail(from))
    setTab('rules')
  }, [])

  const needsAttention = inbox.length > 0 || alert !== null
  // Account labels only help once there is more than one mailbox to tell apart.
  const accountLabel = useMemo(() => {
    if (status.accounts.length < 2) return (): undefined => undefined
    const emails = new Map(status.accounts.map((a) => [a.id, a.email]))
    return (accountId: string): string | undefined => emails.get(accountId)
  }, [status.accounts])

  if (!expanded) {
    return (
      <main className="dock">
        <div className="dock__grip" title="Arrastra para mover a Narsil" />
        <button
          type="button"
          className="dock__avatar"
          onClick={() => setExpanded(true)}
          aria-label={inbox.length > 0 ? `Abrir Narsil, ${inbox.length} correos pendientes` : 'Abrir Narsil'}
        >
          <Shard size={64} alert={needsAttention} />
          {inbox.length > 0 && <span className="dock__badge">{inbox.length}</span>}
        </button>
      </main>
    )
  }

  return (
    <main className="panel">
      <header className="panel__head">
        <Shard size={26} alert={needsAttention} />
        <h1 className="panel__title">Narsil</h1>
        <nav className="tabs" aria-label="Secciones">
          <button type="button" className="tab" aria-pressed={tab === 'mail'} onClick={() => setTab('mail')}>
            Correo{inbox.length > 0 ? ` ${inbox.length}` : ''}
          </button>
          <button type="button" className="tab" aria-pressed={tab === 'meetings'} onClick={() => setTab('meetings')}>
            Reuniones
          </button>
          <button type="button" className="tab" aria-pressed={tab === 'rules'} onClick={() => setTab('rules')}>
            Reglas
          </button>
          <button type="button" className="tab" aria-pressed={tab === 'setup'} onClick={() => setTab('setup')}>
            Ajustes
          </button>
        </nav>
        <button type="button" className="icon-btn" onClick={() => setExpanded(false)} aria-label="Minimizar Narsil">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {alert && (
        <div className="reminder" role="alert">
          <div>
            <strong className="reminder__title">{alert.meeting.title}</strong>
            <span className="reminder__when">
              Empieza en {alert.minutesUntil} {alert.minutesUntil === 1 ? 'minuto' : 'minutos'}
            </span>
          </div>
          <div className="reminder__actions">
            {alert.meeting.link && (
              <a className="btn btn--primary" href={alert.meeting.link} target="_blank" rel="noreferrer">
                Unirse a la llamada
              </a>
            )}
            <button type="button" className="btn btn--ghost" onClick={() => setAlert(null)}>
              Descartar
            </button>
          </div>
        </div>
      )}

      {status.lastError && tab !== 'setup' && <p className="panel__error">{status.lastError}</p>}

      <section className="panel__body">
        {tab === 'setup' && <Setup status={status} />}
        {tab === 'meetings' && <Meetings meetings={meetings} accountLabel={accountLabel} />}
        {tab === 'rules' && (
          <Rules rules={rules} activity={activity} incomingDraft={ruleDraft} onDraftTaken={takeRuleDraft} />
        )}
        {tab === 'mail' &&
          (!isReady(status) ? (
            <p className="empty">
              Termina la configuración para que Narsil pueda leer tu bandeja de entrada.{' '}
              <button type="button" className="link-btn" onClick={() => setTab('setup')}>
                Abrir ajustes
              </button>
            </p>
          ) : inbox.length === 0 ? (
            <p className="empty">No tienes correos sin leer de los últimos dos días.</p>
          ) : (
            inbox.map((item) => (
              <EmailCard
                key={item.key}
                item={item}
                accountLabel={accountLabel(item.email.accountId)}
                highlighted={item.key === highlighted}
                onAction={onAction}
                onReply={onReply}
                onCreateRule={onCreateRule}
              />
            ))
          ))}
      </section>

      {tab === 'mail' && isReady(status) && (
        <footer className="panel__foot">
          <button
            type="button"
            className="link-btn"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true)
              void window.narsil.refresh().finally(() => setRefreshing(false))
            }}
          >
            {refreshing ? 'Revisando…' : 'Revisar ahora'}
          </button>
        </footer>
      )}
    </main>
  )
}
