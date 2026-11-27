import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AccountRules,
  AppStatus,
  InboxItem,
  Meeting,
  PendingTask,
  ReminderAlert,
  Rule,
  RuleActivity,
  ServerRuleInput,
  TasksResult
} from '@shared/types'
import { serverRuleDraftFromEmail } from '@shared/rules'
import { NarsilPet, Water, petPose } from './components/NarsilPet'
import { EmailCard } from './components/EmailCard'
import { Meetings } from './components/Meetings'
import { Setup } from './components/Setup'
import { Rules } from './components/Rules'
import { Tasks } from './components/Tasks'
import { useDayNightTheme } from './theme'

type Tab = 'mail' | 'meetings' | 'tasks' | 'rules' | 'setup'

/** How long Narsil shows her "done" pose after an action or reply succeeds. */
const CELEBRATE_MS = 3000

const EMPTY_STATUS: AppStatus = { accounts: [], hasGoogleClient: false, hasMicrosoftClient: false, hasAnthropicKey: false }

/** Ready once at least one mailbox is connected and Claude can triage. */
function isReady(s: AppStatus): boolean {
  return s.accounts.length > 0 && s.hasAnthropicKey
}

export function App(): React.JSX.Element {
  useDayNightTheme()
  const [status, setStatus] = useState<AppStatus>(EMPTY_STATUS)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [alert, setAlert] = useState<ReminderAlert | null>(null)
  const [expanded, setExpandedState] = useState(false)
  const [tab, setTab] = useState<Tab>('mail')
  const [refreshing, setRefreshing] = useState(false)
  const [rules, setRules] = useState<Rule[]>([])
  const [activity, setActivity] = useState<RuleActivity[]>([])
  const [serverRules, setServerRules] = useState<AccountRules[]>([])
  const [ruleDraft, setRuleDraft] = useState<ServerRuleInput | null>(null)
  const takeRuleDraft = useCallback(() => setRuleDraft(null), [])
  /** The email a clicked notification asked to show; cleared once it is scrolled into view. */
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [celebrating, setCelebrating] = useState(false)
  const celebrateTimer = useRef<number | null>(null)
  const [tasks, setTasks] = useState<PendingTask[]>([])
  const [tasksError, setTasksError] = useState<string | null>(null)
  const takeTasks = useCallback((result: TasksResult) => {
    setTasks(result.tasks)
    if (result.ok) setTasksError(null)
  }, [])
  const pendingTasks = tasks.filter((t) => t.status !== 'done').length

  /** Shows the "done" pose for a few seconds; a new success restarts the clock. */
  const celebrate = useCallback(() => {
    if (celebrateTimer.current !== null) window.clearTimeout(celebrateTimer.current)
    setCelebrating(true)
    celebrateTimer.current = window.setTimeout(() => {
      celebrateTimer.current = null
      setCelebrating(false)
    }, CELEBRATE_MS)
  }, [])

  useEffect(
    () => () => {
      if (celebrateTimer.current !== null) window.clearTimeout(celebrateTimer.current)
    },
    []
  )

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
    void window.narsil.getTasks().then((result) => {
      setTasks(result.tasks)
      setTasksError(result.ok ? null : (result.error ?? null))
    })
    void window.narsil.getMeetings().then(setMeetings)
    void window.narsil.getRules().then(setRules)
    void window.narsil.getRuleActivity().then(setActivity)
    void window.narsil.getServerRules().then(setServerRules)
    const offs = [
      window.narsil.onServerRulesChanged(setServerRules),
      window.narsil.onStatusChanged(setStatus),
      window.narsil.onInboxChanged(setInbox),
      window.narsil.onMeetingsChanged(setMeetings),
      window.narsil.onRulesChanged(setRules),
      window.narsil.onTasksChanged(setTasks),
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

  const onAction = useCallback(
    async (key: string, action: 'archive' | 'delete' | 'save', folderId?: string) => {
      const result = await window.narsil.applyAction(key, action, folderId)
      if (result.ok) celebrate()
      return result.ok ? null : (result.error ?? 'La acción falló.')
    },
    [celebrate]
  )

  const onReply = useCallback(
    async (key: string, body: string) => {
      const result = await window.narsil.sendReply(key, body)
      if (result.ok) celebrate()
      return result.ok ? null : (result.error ?? 'No se pudo enviar la respuesta.')
    },
    [celebrate]
  )

  const onCreateRule = useCallback((from: string, accountId: string) => {
    setRuleDraft(serverRuleDraftFromEmail(from, accountId))
    setTab('rules')
  }, [])

  const pose = petPose({
    hasError: Boolean(status.lastError),
    reminder: alert !== null,
    triaging: inbox.some((item) => item.triage === null && !item.triageError),
    unread: inbox.length > 0,
    celebrating
  })
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
          <Water />
          <NarsilPet pose={pose} />
          {inbox.length > 0 && <span className="dock__badge">{inbox.length}</span>}
        </button>
      </main>
    )
  }

  return (
    <main className="panel">
      <header className="panel__head">
        <NarsilPet pose={pose} variant="head" />
        <h1 className="panel__title">Narsil</h1>
        <nav className="tabs" aria-label="Secciones">
          <button type="button" className="tab" aria-pressed={tab === 'mail'} onClick={() => setTab('mail')}>
            Correo{inbox.length > 0 ? ` ${inbox.length}` : ''}
          </button>
          <button type="button" className="tab" aria-pressed={tab === 'meetings'} onClick={() => setTab('meetings')}>
            Reuniones
          </button>
          <button type="button" className="tab" aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}>
            Pendientes{pendingTasks > 0 ? ` ${pendingTasks}` : ''}
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
        {tab === 'meetings' && (
          <Meetings meetings={meetings} accounts={status.accounts} accountLabel={accountLabel} onCreated={celebrate} />
        )}
        {tab === 'tasks' && (
          <>
            {tasksError && <p className="panel__error">{tasksError}</p>}
            <Tasks tasks={tasks} onResult={takeTasks} />
          </>
        )}
        {tab === 'rules' && (
          <Rules
            rules={rules}
            serverRules={serverRules}
            activity={activity}
            accounts={status.accounts}
            incomingDraft={ruleDraft}
            onDraftTaken={takeRuleDraft}
          />
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
            <p className="empty">No tienes correos sin leer en el periodo que revisa Narsil. Puedes ampliarlo en Ajustes.</p>
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
