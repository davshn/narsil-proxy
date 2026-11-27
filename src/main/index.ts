import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, screen, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { themeAt } from '@shared/dayNight'
import {
  IPC,
  TASK_STATUSES,
  WEEKDAYS,
  type Account,
  type ActionResult,
  type EmailAction,
  type FolderResult,
  type FoldersResult,
  type InboxItem,
  type PendingTask,
  type SharedResult,
  type SharedStatus,
  type TasksResult
} from '@shared/types'
import { SecureStore } from './adapters/secureStore'
import { MAX_MEETING_LOCATION, MAX_MEETING_TITLE, NarsilService, type NarsilEvents } from './app/narsilService'
import { AccountRegistry, AccountSettingsSchema, migrateLegacyGoogleTokens } from './app/accounts'
import { RulesFileStore } from './adapters/rulesStore'
import { TasksFileStore } from './adapters/tasksStore'
import { McpPipeServer } from './adapters/mcpPipe'
import { SharedConfigFileStore } from './adapters/sharedConfigStore'
import { makeSupabaseAuth } from './adapters/supabaseClient'
import { SharedAuth } from './app/sharedAuth'
import { createMcpHandlers } from './app/mcpTools'
import { mcpDiscoveryFile } from '../mcp/protocol'
import { MAX_TASK_DESCRIPTION, MAX_TASK_NAME, MAX_TASK_PROJECT, TaskList } from './app/tasks'
import { GoogleProvider } from './adapters/google/provider'
import { MicrosoftProvider } from './adapters/microsoft/provider'

const COLLAPSED = { width: 150, height: 180 }
const EXPANDED = { width: 460, height: 660 }
const MARGIN = 16

let win: BrowserWindow | null = null
let tray: Tray | null = null
let service: NarsilService | null = null
let mcp: McpPipeServer | null = null

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** Keeps the window anchored to the bottom-right corner of the work area. */
function placeWindow(size: { width: number; height: number }): void {
  if (!win) return
  const area = screen.getPrimaryDisplay().workArea
  win.setBounds({
    width: size.width,
    height: size.height,
    x: area.x + area.width - size.width - MARGIN,
    y: area.y + area.height - size.height - MARGIN
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    ...COLLAPSED,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  placeWindow(COLLAPSED)
  win.once('ready-to-show', () => win?.showInactive())

  // The renderer never navigates; open https links in the default browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/**
 * A file of the repository's `resources/` folder. electron-builder copies that folder next to
 * app.asar as `resources/icons` (`extraResources`); unpackaged, the app path is the repository.
 */
function resourcePath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, 'icons', name) : join(app.getAppPath(), 'resources', name)
}

/** narsilPet's app icon, scaled for the notification area. */
/** The macOS menu bar is about 22 points tall, so its icon is smaller than a Windows tray icon. */
const TRAY_SIZE = process.platform === 'darwin' ? 18 : 32

function trayIcon(): Electron.NativeImage {
  return nativeImage.createFromPath(resourcePath('icon.png')).resize({ width: TRAY_SIZE, height: TRAY_SIZE, quality: 'best' })
}

const faces = new Map<string, Electron.NativeImage>()

/**
 * Narsil's head and shoulders from her still, in the claro or oscuro variant of the hour: the
 * square at the top of the drawing, the same crop the panel header shows.
 */
function notificationIcon(): Electron.NativeImage {
  const variant = themeAt(new Date()) === 'light' ? 'claro' : 'oscuro'
  const cached = faces.get(variant)
  if (cached) return cached
  const still = nativeImage.createFromPath(resourcePath(`narsil-${variant}.png`))
  const { width, height } = still.getSize()
  const side = Math.min(width, height)
  const face = still.isEmpty() ? trayIcon() : still.crop({ x: Math.floor((width - side) / 2), y: 0, width: side, height: side })
  faces.set(variant, face)
  return face
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.setToolTip('Narsil')
  const rebuild = (): void => {
    const openAtLogin = app.getLoginItemSettings().openAtLogin
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Mostrar Narsil', click: () => win?.showInactive() },
        { label: 'Ocultar Narsil', click: () => win?.hide() },
        { label: 'Revisar ahora', click: () => void service?.refresh() },
        { type: 'separator' },
        {
          label: process.platform === 'darwin' ? 'Abrir al iniciar sesión' : 'Iniciar con Windows',
          type: 'checkbox',
          checked: openAtLogin,
          click: () => {
            app.setLoginItemSettings({ openAtLogin: !openAtLogin })
            rebuild()
          }
        },
        { type: 'separator' },
        { label: 'Salir', click: () => app.quit() }
      ])
    )
  }
  rebuild()
  tray.on('click', () => (win?.isVisible() ? win.hide() : win?.showInactive()))
}

const SUGGESTION: Record<EmailAction, string> = {
  save: 'guardar',
  archive: 'archivar',
  delete: 'eliminar',
  reply: 'responder'
}
const MAX_TITLE = 80
const MAX_GROUP_SUBJECTS = 3

/** Shown notifications stay referenced until clicked or closed; a collected one loses its click handler. */
const liveNotifications = new Set<Notification>()

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text
}

function senderName(from: string): string {
  return /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1] ?? from
}

/** Shows the panel expanded and tells the renderer which email to bring into view (null: just the list). */
function focusEmail(key: string | null): void {
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()
  placeWindow(EXPANDED)
  send(IPC.focusEmail, key)
}

/** One notification per poll: the email itself when one arrived, a count when several did. */
function notifyNewEmails(items: InboxItem[], accounts: Account[]): void {
  const [first] = items
  if (!first) return
  let title: string
  let body: string
  let key: string | null
  if (items.length === 1) {
    const { email, triage } = first
    // Plain concatenation: email text is data and never goes through a template or markup.
    title = truncate(senderName(email.from) + ' · ' + email.subject, MAX_TITLE)
    body = triage ? triage.summary + '\nSugerencia: ' + SUGGESTION[triage.recommendedAction] : email.snippet
    const account = accounts.length > 1 ? accounts.find((a) => a.id === email.accountId) : undefined
    if (account) body += '\n' + account.email
    key = first.key
  } else {
    title = `${items.length} correos nuevos`
    body = items
      .slice(0, MAX_GROUP_SUBJECTS)
      .map((item) => item.email.subject)
      .join('\n')
    key = null
  }
  const notification = new Notification({ title, body, icon: notificationIcon() })
  liveNotifications.add(notification)
  const release = (): void => void liveNotifications.delete(notification)
  notification.on('click', () => {
    release()
    focusEmail(key)
  })
  notification.on('close', release)
  notification.show()
}

function failure(error: unknown): ActionResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

async function run(fn: () => Promise<void> | void): Promise<ActionResult> {
  try {
    await fn()
    return { ok: true }
  } catch (error) {
    return failure(error)
  }
}

/** `${accountId}:${messageId}`; Graph message ids are long, so allow room. */
const ItemKey = z.string().min(1).max(1024)
const AccountId = z.string().min(1).max(64)
const ProviderSchema = z.enum(['google', 'microsoft'])
const ClientId = z.string().max(100)
const ActionSchema = z.enum(['archive', 'delete', 'save'])
/** Graph folder ids are long base64 strings, like message ids. */
const FolderId = z.string().min(1).max(1024)
/** The service trims it and enforces 1-100 characters with a Spanish message. */
const FolderName = z.string().max(500)
const ReplyBody = z.string().min(1).max(50_000)
const ApiKey = z.string().max(500)
const Condition = z.string().max(200)
const RuleInputSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().max(120),
  enabled: z.boolean(),
  action: ActionSchema,
  conditions: z.object({ from: Condition, subject: Condition, body: Condition }),
  folder: z.object({ accountId: AccountId, id: FolderId, name: z.string().max(500) }).optional()
})
/** Gmail filter ids are short; Outlook rule ids are long base64 strings. */
const ServerRuleId = z.string().min(1).max(1024)
const ServerRuleInputSchema = z.object({
  id: ServerRuleId.optional(),
  accountId: AccountId,
  name: z.string().max(120),
  conditions: z.object({ from: Condition, subject: Condition, body: Condition }),
  action: z.enum(['archive', 'delete', 'move']),
  folderId: FolderId.optional(),
  folderName: z.string().max(500).optional()
})
const NewMeetingSchema = z.object({
  title: z.string().max(MAX_MEETING_TITLE * 2),
  start: z.string().min(1).max(64),
  end: z.string().min(1).max(64),
  location: z.string().max(MAX_MEETING_LOCATION * 2).optional(),
  repeat: z.object({ days: z.array(z.enum(WEEKDAYS)).max(14), until: z.string().max(10) }).optional()
})
const ConvertTargetSchema = z
  .object({ accountId: AccountId, folderId: FolderId.optional(), folderName: z.string().max(500).optional() })
  .optional()

function registerIpc(svc: NarsilService): void {
  ipcMain.handle(IPC.getStatus, () => svc.status())
  ipcMain.handle(IPC.getInbox, () => svc.inboxItems())
  ipcMain.handle(IPC.getMeetings, () => svc.upcomingMeetings())
  ipcMain.handle(IPC.createMeeting, (_e, accountId: unknown, input: unknown) =>
    run(async () => {
      await svc.createMeeting(AccountId.parse(accountId), NewMeetingSchema.parse(input))
    })
  )
  ipcMain.handle(IPC.refresh, () => run(() => svc.refresh()))
  ipcMain.handle(IPC.addAccount, (_e, provider: unknown) => run(() => svc.addAccount(ProviderSchema.parse(provider))))
  ipcMain.handle(IPC.removeAccount, (_e, id: unknown) => run(() => svc.removeAccount(AccountId.parse(id))))
  ipcMain.handle(IPC.setMicrosoftClientId, (_e, id: unknown) => run(() => svc.setMicrosoftClientId(ClientId.parse(id))))
  ipcMain.handle(IPC.setAnthropicKey, (_e, key: unknown) => run(() => svc.setAnthropicKey(ApiKey.parse(key))))
  ipcMain.handle(IPC.applyAction, (_e, key: unknown, action: unknown, folderId: unknown) =>
    run(() => svc.applyAction(ItemKey.parse(key), ActionSchema.parse(action), FolderId.optional().parse(folderId)))
  )
  ipcMain.handle(IPC.listFolders, async (_e, accountId: unknown): Promise<FoldersResult> => {
    try {
      return { ok: true, folders: await svc.listFolders(AccountId.parse(accountId)) }
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle(IPC.createFolder, async (_e, accountId: unknown, name: unknown): Promise<FolderResult> => {
    try {
      return { ok: true, folder: await svc.createFolder(AccountId.parse(accountId), FolderName.parse(name)) }
    } catch (error) {
      return failure(error)
    }
  })
  ipcMain.handle(IPC.setAccountSettings, (_e, accountId: unknown, settings: unknown) =>
    run(() => svc.setAccountSettings(AccountId.parse(accountId), AccountSettingsSchema.parse(settings)))
  )
  ipcMain.handle(IPC.sendReply, (_e, key: unknown, body: unknown) =>
    run(() => svc.sendReply(ItemKey.parse(key), ReplyBody.parse(body)))
  )
  ipcMain.handle(IPC.importGoogleClient, () =>
    run(async () => {
      const result = await dialog.showOpenDialog({
        title: 'Selecciona el archivo de cliente OAuth de Google',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      })
      const path = result.filePaths[0]
      if (result.canceled || !path) throw new Error('No se seleccionó ningún archivo.')
      svc.importGoogleClient(await readFile(path, 'utf8'))
    })
  )
  ipcMain.handle(IPC.getRules, () => svc.rules())
  ipcMain.handle(IPC.getRuleActivity, () => svc.ruleActivity())
  ipcMain.handle(IPC.saveRule, (_e, input: unknown) => run(() => svc.saveRule(RuleInputSchema.parse(input))))
  ipcMain.handle(IPC.deleteRule, (_e, id: unknown) => run(() => svc.deleteRule(z.string().min(1).max(64).parse(id))))
  ipcMain.handle(IPC.getServerRules, () => svc.serverRules())
  ipcMain.handle(IPC.reloadServerRules, () => run(() => svc.loadServerRules()))
  ipcMain.handle(IPC.saveServerRule, (_e, input: unknown) => run(() => svc.saveServerRule(ServerRuleInputSchema.parse(input))))
  ipcMain.handle(IPC.deleteServerRule, (_e, accountId: unknown, ruleId: unknown) =>
    run(() => svc.deleteServerRule(AccountId.parse(accountId), ServerRuleId.parse(ruleId)))
  )
  ipcMain.handle(IPC.convertLocalRule, (_e, ruleId: unknown, target: unknown) =>
    run(() => svc.convertLocalRule(z.string().min(1).max(64).parse(ruleId), ConvertTargetSchema.parse(target)))
  )
  ipcMain.handle(IPC.reconnectAccount, (_e, accountId: unknown) => run(() => svc.reconnectAccount(AccountId.parse(accountId))))
  ipcMain.handle(IPC.setExpanded, (_e, expanded: unknown) => {
    placeWindow(expanded === true ? EXPANDED : COLLAPSED)
  })
}

/** Lengths are checked by TaskList; these only bound what crosses the IPC boundary. */
const TaskId = z.string().min(1).max(64)
const PendingTaskInputSchema = z.object({
  id: TaskId.optional(),
  name: z.string().max(MAX_TASK_NAME * 2),
  description: z.string().max(MAX_TASK_DESCRIPTION * 2),
  project: z.string().max(MAX_TASK_PROJECT * 2)
})

/** Runs a change and answers with every task, the stored ones when the change failed. */
function taskResult(tasks: TaskList, change: () => PendingTask[]): TasksResult {
  try {
    return { ok: true, tasks: change() }
  } catch (error) {
    let current: PendingTask[] = []
    try {
      current = tasks.list()
    } catch {
      // A damaged file: the error above already says so.
    }
    return { ...failure(error), tasks: current }
  }
}

function registerTaskIpc(tasks: TaskList): void {
  ipcMain.handle(IPC.getTasks, () => taskResult(tasks, () => tasks.list()))
  ipcMain.handle(IPC.saveTask, (_e, input: unknown) => taskResult(tasks, () => tasks.save(PendingTaskInputSchema.parse(input))))
  ipcMain.handle(IPC.setTaskStatus, (_e, id: unknown, status: unknown) =>
    taskResult(tasks, () => tasks.setStatus(TaskId.parse(id), z.enum(TASK_STATUSES).parse(status)))
  )
  ipcMain.handle(IPC.deleteTask, (_e, id: unknown) => taskResult(tasks, () => tasks.remove(TaskId.parse(id))))
}

/** Runs a shared-lists call and answers with the sign-in status, the current one when it failed. */
async function sharedResult(shared: SharedAuth, change: () => Promise<SharedStatus>): Promise<SharedResult> {
  try {
    return { ok: true, status: await change() }
  } catch (error) {
    let status: SharedStatus = { configured: false }
    try {
      status = await shared.status()
    } catch {
      // Keep the empty status: the failure is already reported.
    }
    return { ...failure(error), status }
  }
}

function registerSharedIpc(shared: SharedAuth): void {
  ipcMain.handle(IPC.getSharedStatus, () => sharedResult(shared, () => shared.status()))
  ipcMain.handle(IPC.setSharedConfig, (_e, url: unknown, key: unknown) =>
    sharedResult(shared, () => shared.setConfig(z.string().max(300).parse(url), z.string().max(500).parse(key)))
  )
  ipcMain.handle(IPC.sharedSignIn, () => sharedResult(shared, () => shared.signIn()))
  ipcMain.handle(IPC.sharedSignOut, () => sharedResult(shared, () => shared.signOut()))
}

/** Lets Claude reach this Narsil through the MCP bridge (out/main/mcp.js). */
function startMcp(svc: NarsilService, tasks: TaskList): void {
  const server = new McpPipeServer(createMcpHandlers({ service: svc, tasks, tasksChanged: (list) => send(IPC.tasksChanged, list) }), {
    file: mcpDiscoveryFile(process.env, homedir())
  })
  server.start().then(
    () => {
      mcp = server
    },
    (error: unknown) => console.error('Narsil could not open the MCP pipe:', error)
  )
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => win?.showInactive())
  // macOS: clicking the app again (Finder, Spotlight, Launchpad) brings Narsil back.
  app.on('activate', () => win?.showInactive())

  void app.whenReady().then(() => {
    // Windows names toasts after this id; on macOS Narsil lives in the menu bar, not the Dock.
    if (process.platform === 'win32') app.setAppUserModelId('com.narsil.desktop')
    if (process.platform === 'darwin') app.dock?.hide()
    createWindow()
    createTray()

    const store = new SecureStore()
    const accounts = new AccountRegistry(store)
    const google = new GoogleProvider(store)
    const events: NarsilEvents = {
      inboxChanged: (items) => send(IPC.inboxChanged, items),
      meetingsChanged: (meetings) => send(IPC.meetingsChanged, meetings),
      statusChanged: (status) => send(IPC.statusChanged, status),
      rulesChanged: (rules) => send(IPC.rulesChanged, rules),
      activityChanged: (activity) => send(IPC.ruleActivityChanged, activity),
      serverRulesChanged: (rules) => send(IPC.serverRulesChanged, rules),
      newEmails: (items) => notifyNewEmails(items, service?.status().accounts ?? []),
      reminder: (alert) => {
        send(IPC.reminder, alert)
        win?.showInactive()
        const time = new Date(alert.meeting.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        new Notification({
          title: `${alert.meeting.title} en ${alert.minutesUntil} min`,
          body: `Empieza a las ${time}${alert.meeting.location ? `, ${alert.meeting.location}` : ''}`,
          icon: notificationIcon()
        }).show()
      }
    }
    service = new NarsilService({
      store,
      events,
      rules: new RulesFileStore(),
      accounts,
      providers: { google, microsoft: new MicrosoftProvider(store) },
      migrate: async () => {
        await migrateLegacyGoogleTokens({ store, accounts, fetchEmail: (tokens) => google.emailForTokens(tokens) })
      }
    })
    registerIpc(service)
    const tasks = new TaskList(new TasksFileStore())
    registerTaskIpc(tasks)
    registerSharedIpc(
      new SharedAuth({
        configs: new SharedConfigFileStore(),
        secrets: store,
        makeClient: makeSupabaseAuth,
        openBrowser: (url) => shell.openExternal(url)
      })
    )
    service.start()
    startMcp(service, tasks)
  })

  // Narsil lives in the tray; closing the window does not quit it.
  app.on('window-all-closed', () => undefined)
  app.on('before-quit', () => {
    service?.stop()
    void mcp?.stop()
  })
}
