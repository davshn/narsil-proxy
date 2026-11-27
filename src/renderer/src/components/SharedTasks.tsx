import { useState } from 'react'
import {
  TASK_STATUSES,
  type SharedAction,
  type SharedActionResult,
  type SharedList,
  type SharedSnapshot,
  type SharedState,
  type SharedTask,
  type TaskStatus
} from '@shared/types'
import { STATUS_LABEL } from './taskGroups'
import {
  canChange,
  canDelete,
  changedLabel,
  invitations,
  memberLabel,
  membersOf,
  ownedByMe,
  personLabel,
  sortSharedTasks,
  workLists
} from './sharedView'

/** The app checks these again; the inputs only keep typing within them. */
const MAX_LIST_NAME = 100
const MAX_NAME = 200
const MAX_DESCRIPTION = 5000

interface SharedTasksProps {
  state: SharedState
  /** A change answered; `result.state` is the lists after it, also after a failure. */
  onResult(result: SharedActionResult): void
  onOpenSetup(): void
}

/** "Compartidas": lists shared through Supabase, their members and their tasks. */
export function SharedTasks({ state, onResult, onOpenSetup }: SharedTasksProps): React.JSX.Element {
  const [chosen, setChosen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { snapshot } = state

  if (!state.signedIn || !snapshot) {
    return (
      <section aria-label="Compartidas">
        <p className="empty">
          Para compartir tareas con otras personas, inicia sesión en Listas compartidas.{' '}
          <button type="button" className="link-btn" onClick={onOpenSetup}>
            Ir a Ajustes
          </button>
        </p>
      </section>
    )
  }

  const lists = workLists(snapshot)
  const list = lists.find((l) => l.id === chosen) ?? lists[0]

  /** Runs a change and reports it; resolves to whether it was saved. */
  async function act(action: SharedAction): Promise<boolean> {
    const result = await window.narsil.sharedAction(action)
    onResult(result)
    setError(result.ok ? null : (result.error ?? 'No se pudo guardar el cambio.'))
    return result.ok
  }

  return (
    <section aria-label="Compartidas">
      {state.error && (
        <p className="shared__offline" role="status">
          {state.error} Se muestra la última copia guardada.
        </p>
      )}

      <Invitations snapshot={snapshot} act={act} />

      {creating ? (
        <NameForm
          title="Nueva lista"
          label="Nombre de la lista"
          placeholder="Casa"
          submit="Crear lista"
          onCancel={() => setCreating(false)}
          onSave={async (name) => {
            const ok = await act({ type: 'createList', name })
            if (ok) setCreating(false)
            return ok
          }}
        />
      ) : (
        <div className="tasks__head">
          {lists.length > 1 && (
            <label className="tasks__filter">
              <select value={list?.id} aria-label="Lista" onChange={(e) => setChosen(e.target.value)}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className={list ? 'btn' : 'btn btn--primary'} onClick={() => setCreating(true)}>
            Nueva lista
          </button>
        </div>
      )}

      {error && (
        <p className="task-form__error" role="alert">
          {error}
        </p>
      )}

      {list ? (
        <ListView key={list.id} snapshot={snapshot} list={list} act={act} />
      ) : (
        !creating && <p className="empty">Crea una lista e invita a otras personas por su email de Google para repartir tareas.</p>
      )}
    </section>
  )
}

type Act = (action: SharedAction) => Promise<boolean>

function Invitations({ snapshot, act }: { snapshot: SharedSnapshot; act: Act }): React.JSX.Element | null {
  const waiting = invitations(snapshot)
  if (waiting.length === 0) return null
  return (
    <ul className="shared__invitations" aria-label="Invitaciones">
      {waiting.map((l) => (
        <li key={l.id} className="shared__invitation">
          <span>
            {personLabel(snapshot, l.ownerId)} te invitó a <strong>{l.name}</strong>
          </span>
          <span className="shared__invitation-actions">
            <button type="button" className="btn btn--primary" onClick={() => void act({ type: 'acceptInvitation', listId: l.id })}>
              Aceptar
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => void act({ type: 'leave', listId: l.id })}>
              Rechazar
            </button>
          </span>
        </li>
      ))}
    </ul>
  )
}

function ListView({ snapshot, list, act }: { snapshot: SharedSnapshot; list: SharedList; act: Act }): React.JSX.Element {
  /** null: no form; a task: editing it; 'new': adding one. */
  const [editing, setEditing] = useState<SharedTask | 'new' | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const tasks = sortSharedTasks(snapshot.tasks.filter((t) => t.listId === list.id))
  const pending = tasks.filter((t) => t.status !== 'done').length
  const assignable = membersOf(snapshot, list.id).filter((m) => m.acceptedAt !== null)

  return (
    <>
      <Members snapshot={snapshot} list={list} act={act} />

      <div className="shared__list-head">
        <h3 className="tasks__project">
          {list.name}
          <span className="tasks__count">
            {tasks.length === 0 ? 'sin tareas' : pending === 0 ? 'todo terminado' : `${pending} sin terminar`}
          </span>
        </h3>
        {!editing && (
          <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
            Agregar tarea
          </button>
        )}
      </div>

      {editing && (
        <SharedTaskForm
          task={editing === 'new' ? undefined : editing}
          members={assignable.map((m) => ({ email: m.email, label: memberLabel(snapshot, m.email) }))}
          onCancel={() => setEditing(null)}
          onSave={async (fields) => {
            const id = editing === 'new' ? {} : { id: editing.id }
            const ok = await act({ type: 'saveTask', task: { ...id, listId: list.id, ...fields } })
            if (ok) setEditing(null)
            return ok
          }}
        />
      )}

      {tasks.length === 0 && !editing ? (
        <p className="empty">Agrega la primera tarea y asígnala a quien la vaya a hacer.</p>
      ) : (
        <ul className="tasks">
          {tasks.map((task) => {
            const changeable = canChange(snapshot, task)
            return (
              <li key={task.id} className={task.status === 'done' ? 'task task--done' : 'task'}>
                <div className="task__what">
                  <span className="task__name">{task.name}</span>
                  {task.description && <p className="task__description">{task.description}</p>}
                  <p className="shared__meta">
                    {task.assigneeEmail ? `Para ${memberLabel(snapshot, task.assigneeEmail)}` : 'Sin asignar'}
                    <br />
                    {changedLabel(snapshot, task)}
                  </p>
                </div>
                <label className="task__status" data-status={task.status}>
                  <select
                    value={task.status}
                    disabled={!changeable}
                    title={changeable ? undefined : 'Solo quien la creó o a quien está asignada cambia su estado.'}
                    aria-label={`Estado de "${task.name}"`}
                    onChange={(e) => void act({ type: 'setTaskStatus', taskId: task.id, status: e.target.value as TaskStatus })}
                  >
                    {TASK_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {STATUS_LABEL[status]}
                      </option>
                    ))}
                  </select>
                  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
                    <path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                  </svg>
                </label>
                <div className="task__actions">
                  {confirming === task.id ? (
                    <>
                      <button
                        type="button"
                        className="link-btn link-btn--danger"
                        onClick={() => {
                          setConfirming(null)
                          void act({ type: 'deleteTask', taskId: task.id })
                        }}
                      >
                        Sí, eliminar
                      </button>
                      <button type="button" className="link-btn" onClick={() => setConfirming(null)}>
                        No
                      </button>
                    </>
                  ) : (
                    <>
                      {changeable && (
                        <button type="button" className="link-btn" onClick={() => setEditing(task)}>
                          Editar
                        </button>
                      )}
                      {canDelete(snapshot, task) && (
                        <button type="button" className="link-btn link-btn--danger" onClick={() => setConfirming(task.id)}>
                          Eliminar
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

/** Who is in the list, and what the owner (or any other member) can do about it. */
function Members({ snapshot, list, act }: { snapshot: SharedSnapshot; list: SharedList; act: Act }): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [confirming, setConfirming] = useState<'delete' | 'leave' | null>(null)
  const owner = ownedByMe(snapshot, list)
  const members = membersOf(snapshot, list.id)
  const accepted = members.filter((m) => m.acceptedAt !== null).length

  return (
    <details className="shared__members">
      <summary>
        {accepted === 1 ? '1 miembro' : `${accepted} miembros`}
        {accepted < members.length ? `, ${members.length - accepted} por aceptar` : ''}
        {owner ? '. Eres el dueño.' : `. Dueño: ${personLabel(snapshot, list.ownerId)}.`}
      </summary>
      <ul className="shared__people">
        {members.map((m) => (
          <li key={m.email}>
            <span>
              {memberLabel(snapshot, m.email)}
              {m.acceptedAt === null && <span className="shared__pending"> invitación pendiente</span>}
            </span>
            {owner && m.email !== snapshot.email && (
              <button
                type="button"
                className="link-btn link-btn--danger"
                onClick={() => void act({ type: 'removeMember', listId: list.id, email: m.email })}
              >
                Quitar
              </button>
            )}
          </li>
        ))}
      </ul>
      {owner && (
        <form
          className="shared__invite"
          onSubmit={(e) => {
            e.preventDefault()
            void act({ type: 'invite', listId: list.id, email }).then((ok) => ok && setEmail(''))
          }}
        >
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email de Google"
            aria-label="Email de la persona que invitas"
            autoComplete="off"
          />
          <button type="submit" className="btn" disabled={!email.trim()}>
            Invitar
          </button>
        </form>
      )}
      {renaming ? (
        <NameForm
          title="Renombrar la lista"
          label="Nombre de la lista"
          initial={list.name}
          submit="Guardar"
          onCancel={() => setRenaming(false)}
          onSave={async (name) => {
            const ok = await act({ type: 'renameList', listId: list.id, name })
            if (ok) setRenaming(false)
            return ok
          }}
        />
      ) : (
        <div className="shared__list-actions">
          {confirming ? (
            <>
              <span>{confirming === 'delete' ? 'Se borran la lista y todas sus tareas.' : 'Se borran las tareas asignadas a ti.'}</span>
              <button
                type="button"
                className="link-btn link-btn--danger"
                onClick={() => {
                  setConfirming(null)
                  void act(confirming === 'delete' ? { type: 'deleteList', listId: list.id } : { type: 'leave', listId: list.id })
                }}
              >
                {confirming === 'delete' ? 'Sí, eliminar la lista' : 'Sí, salir'}
              </button>
              <button type="button" className="link-btn" onClick={() => setConfirming(null)}>
                No
              </button>
            </>
          ) : owner ? (
            <>
              <button type="button" className="link-btn" onClick={() => setRenaming(true)}>
                Renombrar
              </button>
              <button type="button" className="link-btn link-btn--danger" onClick={() => setConfirming('delete')}>
                Eliminar la lista
              </button>
            </>
          ) : (
            <button type="button" className="link-btn link-btn--danger" onClick={() => setConfirming('leave')}>
              Salir de la lista
            </button>
          )}
        </div>
      )}
    </details>
  )
}

interface NameFormProps {
  title: string
  label: string
  initial?: string
  placeholder?: string
  submit: string
  onCancel(): void
  /** Resolves to whether it was saved; the error shows above the list. */
  onSave(name: string): Promise<boolean>
}

function NameForm({ title, label, initial = '', placeholder, submit, onCancel, onSave }: NameFormProps): React.JSX.Element {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="task-form"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        void onSave(name).then(() => setBusy(false))
      }}
    >
      <h3>{title}</h3>
      <label>
        {label}
        <input value={name} maxLength={MAX_LIST_NAME} autoFocus placeholder={placeholder} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="task-form__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
          {busy ? 'Guardando…' : submit}
        </button>
      </div>
    </form>
  )
}

interface SharedTaskFormProps {
  task?: SharedTask
  /** Members who accepted, the only ones a task can go to. */
  members: { email: string; label: string }[]
  onCancel(): void
  onSave(fields: { name: string; description: string; assigneeEmail: string | null }): Promise<boolean>
}

function SharedTaskForm({ task, members, onCancel, onSave }: SharedTaskFormProps): React.JSX.Element {
  const [name, setName] = useState(task?.name ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [assignee, setAssignee] = useState(task?.assigneeEmail ?? '')
  const [busy, setBusy] = useState(false)

  return (
    <form
      className="task-form"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        void onSave({ name, description, assigneeEmail: assignee || null }).then(() => setBusy(false))
      }}
    >
      <h3>{task ? 'Editar tarea' : 'Agregar tarea'}</h3>
      <label>
        Nombre
        <input value={name} maxLength={MAX_NAME} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Pagar la luz" />
      </label>
      <label>
        Para
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Sin asignar</option>
          {members.map((m) => (
            <option key={m.email} value={m.email}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Descripción
        <textarea
          value={description}
          maxLength={MAX_DESCRIPTION}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Opcional"
        />
      </label>
      <div className="task-form__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
        <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
          {busy ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </form>
  )
}
