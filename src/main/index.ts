import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, screen, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { IPC, type ActionResult } from '@shared/types'
import { SecureStore } from './adapters/secureStore'
import { NarsilService } from './app/narsilService'

const COLLAPSED = { width: 150, height: 170 }
const EXPANDED = { width: 420, height: 640 }
const MARGIN = 16

let win: BrowserWindow | null = null
let tray: Tray | null = null
let service: NarsilService | null = null

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

/** Draws a 32x32 glowing orb so the tray icon needs no binary asset. */
function trayIcon(): Electron.NativeImage {
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5) / 15.5
      const i = (y * size + x) * 4
      const alpha = d <= 1 ? 255 : 0
      buf[i] = 255 // B
      buf[i + 1] = Math.round(200 - 80 * d) // G
      buf[i + 2] = Math.round(120 - 60 * d) // R
      buf[i + 3] = alpha
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

function createTray(): void {
  tray = new Tray(trayIcon())
  tray.setToolTip('Narsil')
  const rebuild = (): void => {
    const openAtLogin = app.getLoginItemSettings().openAtLogin
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Narsil', click: () => win?.showInactive() },
        { label: 'Hide Narsil', click: () => win?.hide() },
        { label: 'Check now', click: () => void service?.refresh() },
        { type: 'separator' },
        {
          label: 'Start with Windows',
          type: 'checkbox',
          checked: openAtLogin,
          click: () => {
            app.setLoginItemSettings({ openAtLogin: !openAtLogin })
            rebuild()
          }
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ])
    )
  }
  rebuild()
  tray.on('click', () => (win?.isVisible() ? win.hide() : win?.showInactive()))
}

async function run(fn: () => Promise<void> | void): Promise<ActionResult> {
  try {
    await fn()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

const EmailId = z.string().min(1).max(256)
const ActionSchema = z.enum(['archive', 'delete', 'save'])
const ReplyBody = z.string().min(1).max(50_000)
const ApiKey = z.string().max(500)

function registerIpc(svc: NarsilService): void {
  ipcMain.handle(IPC.getStatus, () => svc.status())
  ipcMain.handle(IPC.getInbox, () => svc.inboxItems())
  ipcMain.handle(IPC.getMeetings, () => svc.upcomingMeetings())
  ipcMain.handle(IPC.refresh, () => run(() => svc.refresh()))
  ipcMain.handle(IPC.connectGoogle, () => run(() => svc.connectGoogle()))
  ipcMain.handle(IPC.disconnectGoogle, () => run(() => svc.disconnectGoogle()))
  ipcMain.handle(IPC.setAnthropicKey, (_e, key: unknown) => run(() => svc.setAnthropicKey(ApiKey.parse(key))))
  ipcMain.handle(IPC.applyAction, (_e, id: unknown, action: unknown) =>
    run(() => svc.applyAction(EmailId.parse(id), ActionSchema.parse(action)))
  )
  ipcMain.handle(IPC.sendReply, (_e, id: unknown, body: unknown) =>
    run(() => svc.sendReply(EmailId.parse(id), ReplyBody.parse(body)))
  )
  ipcMain.handle(IPC.importGoogleClient, () =>
    run(async () => {
      const result = await dialog.showOpenDialog({
        title: 'Select your Google OAuth client file',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile']
      })
      const path = result.filePaths[0]
      if (result.canceled || !path) throw new Error('No file selected.')
      svc.importGoogleClient(await readFile(path, 'utf8'))
    })
  )
  ipcMain.handle(IPC.setExpanded, (_e, expanded: unknown) => {
    placeWindow(expanded === true ? EXPANDED : COLLAPSED)
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => win?.showInactive())

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.narsil.desktop')
    createWindow()
    createTray()

    service = new NarsilService(new SecureStore(), {
      inboxChanged: (items) => send(IPC.inboxChanged, items),
      meetingsChanged: (meetings) => send(IPC.meetingsChanged, meetings),
      statusChanged: (status) => send(IPC.statusChanged, status),
      reminder: (alert) => {
        send(IPC.reminder, alert)
        win?.showInactive()
        const time = new Date(alert.meeting.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        new Notification({
          title: `${alert.meeting.title} in ${alert.minutesUntil} min`,
          body: `Starts at ${time}${alert.meeting.location ? `, ${alert.meeting.location}` : ''}`,
          icon: trayIcon()
        }).show()
      }
    })
    registerIpc(service)
    service.start()
  })

  // Narsil lives in the tray; closing the window does not quit it.
  app.on('window-all-closed', () => undefined)
  app.on('before-quit', () => service?.stop())
}
