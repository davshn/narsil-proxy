import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type NarsilApi } from '@shared/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: NarsilApi = {
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  importGoogleClient: () => ipcRenderer.invoke(IPC.importGoogleClient),
  connectGoogle: () => ipcRenderer.invoke(IPC.connectGoogle),
  disconnectGoogle: () => ipcRenderer.invoke(IPC.disconnectGoogle),
  setAnthropicKey: (key) => ipcRenderer.invoke(IPC.setAnthropicKey, key),
  getInbox: () => ipcRenderer.invoke(IPC.getInbox),
  getMeetings: () => ipcRenderer.invoke(IPC.getMeetings),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  applyAction: (emailId, action) => ipcRenderer.invoke(IPC.applyAction, emailId, action),
  sendReply: (emailId, body) => ipcRenderer.invoke(IPC.sendReply, emailId, body),
  setExpanded: (expanded) => ipcRenderer.invoke(IPC.setExpanded, expanded),
  onInboxChanged: (listener) => subscribe(IPC.inboxChanged, listener),
  onMeetingsChanged: (listener) => subscribe(IPC.meetingsChanged, listener),
  onReminder: (listener) => subscribe(IPC.reminder, listener),
  onStatusChanged: (listener) => subscribe(IPC.statusChanged, listener)
}

contextBridge.exposeInMainWorld('narsil', api)
