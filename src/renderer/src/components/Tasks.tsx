import { useState } from 'react'
import { TASK_STATUSES, type PendingTask, type PendingTaskInput, type TasksResult } from '@shared/types'
import { NO_PROJECT, STATUS_LABEL, groupTasks, isFinished, projectsOf } from './taskGroups'

/** The app checks these again; the inputs only keep typing within them. */
const MAX_NAME = 200
const MAX_PROJECT = 100
const MAX_DESCRIPTION = 5000

interface TasksProps {
  tasks: PendingTask[]
  /** A call answered; `tasks` is what is stored now, also after a failure. */
  onResult(result: TasksResult): void
}

/** "Pendientes": tasks the user writes down, grouped by project. */
export function Tasks({ tasks, onResult }: TasksProps): React.JSX.Element {
  /** null: no form; a task: editing it; 'new': adding one. */
  const [editing, setEditing] = useState<PendingTask | 'new' | null>(null)
  const [filter, setFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const projects = projectsOf(tasks)
  const hasLoose = tasks.some((t) => !t.project)
  // A project whose last task was deleted is no longer offered; show everything again.
  const activeFilter = filter && (filter === NO_PROJECT ? hasLoose : projects.includes(filter)) ? filter : ''
  const groups = groupTasks(tasks, activeFilter || undefined)

  async function call(request: Promise<TasksResult>): Promise<boolean> {
    const result = await request
    onResult(result)
    setError(result.ok ? null : (result.error ?? 'No se pudo guardar el cambio.'))
    return result.ok
  }

  return (
    <section aria-label="Pendientes">
      {editing ? (
        <TaskForm
          task={editing === 'new' ? undefined : editing}
          projects={projects}
          initialProject={editing === 'new' && activeFilter !== NO_PROJECT ? activeFilter : undefined}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            const result = await window.narsil.saveTask(input)
            onResult(result)
            if (result.ok) setEditing(null)
            return result.ok ? null : (result.error ?? 'No se pudo guardar la tarea.')
          }}
        />
      ) : (
        <div className="tasks__head">
          {(projects.length > 1 || (projects.length > 0 && hasLoose)) && (
            <label className="tasks__filter">
              <select value={activeFilter} aria-label="Proyecto" onChange={(e) => setFilter(e.target.value)}>
                <option value="">Todos los proyectos</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                {hasLoose && <option value={NO_PROJECT}>Sin proyecto</option>}
              </select>
            </label>
          )}
          <button type="button" className="btn btn--primary" onClick={() => setEditing('new')}>
            Agregar tarea
          </button>
        </div>
      )}

      {error && (
        <p className="task-form__error" role="alert">
          {error}
        </p>
      )}

      {tasks.length === 0 ? (
        <p className="empty">Anota aquí lo que se te ocurra, con su proyecto, para no perderlo de vista.</p>
      ) : (
        groups.map((group) => (
          <section key={group.project} className="tasks__group" aria-label={label(group.project)}>
            <h3 className="tasks__project">
              {label(group.project)}
              <span className="tasks__count">{group.pending === 0 ? 'todo terminado' : `${group.pending} sin terminar`}</span>
            </h3>
            <ul className="tasks">
              {group.tasks.map((task) => (
                <li key={task.id} className={isFinished(task) ? 'task task--done' : 'task'}>
                  <div className="task__what">
                    <span className="task__name">{task.name}</span>
                    {task.description && <p className="task__description">{task.description}</p>}
                  </div>
                  <label className="task__status" data-status={task.status}>
                    <select
                      value={task.status}
                      aria-label={`Estado de "${task.name}"`}
                      onChange={(e) => void call(window.narsil.setTaskStatus(task.id, e.target.value as PendingTask['status']))}
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
                            void call(window.narsil.deleteTask(task.id))
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
                        <button type="button" className="link-btn" onClick={() => setEditing(task)}>
                          Editar
                        </button>
                        <button type="button" className="link-btn link-btn--danger" onClick={() => setConfirming(task.id)}>
                          Eliminar
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  )
}

const label = (project: string): string => (project === NO_PROJECT ? 'Sin proyecto' : project)

interface TaskFormProps {
  /** The task being edited, or undefined for a new one. */
  task?: PendingTask
  projects: string[]
  /** The project a new task starts in. */
  initialProject?: string
  onCancel(): void
  /** Resolves to the error to show, or null once saved. */
  onSave(input: PendingTaskInput): Promise<string | null>
}

function TaskForm({ task, projects, initialProject, onCancel, onSave }: TaskFormProps): React.JSX.Element {
  const [name, setName] = useState(task?.name ?? '')
  const [project, setProject] = useState(task?.project ?? initialProject ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      className="task-form"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        void onSave({ ...(task ? { id: task.id } : {}), name, project, description }).then((message) => {
          setBusy(false)
          setError(message)
        })
      }}
    >
      <h3>{task ? 'Editar tarea' : 'Agregar tarea'}</h3>
      <label>
        Nombre
        <input value={name} maxLength={MAX_NAME} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Revisar el contrato" />
      </label>
      <label>
        Proyecto
        <input
          value={project}
          maxLength={MAX_PROJECT}
          list="task-projects"
          onChange={(e) => setProject(e.target.value)}
          placeholder="Opcional"
        />
        <datalist id="task-projects">
          {projects.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
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
      {error && (
        <p className="task-form__error" role="alert">
          {error}
        </p>
      )}
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
