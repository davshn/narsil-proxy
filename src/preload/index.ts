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
  setMicrosoftClientId: (clientId) => ipcRenderer.invoke(IPC.setMicrosoftClientId, clientId),
  addAccount: (provider) => ipcRenderer.invoke(IPC.addAccount, provider),
  removeAccount: (accountId) => ipcRenderer.invoke(IPC.removeAccount, accountId),
  setAnthropicKey: (key) => ipcRenderer.invoke(IPC.setAnthropicKey, key),
  getInbox: () => ipcRenderer.invoke(IPC.getInbox),
  getMeetings: () => ipcRenderer.invoke(IPC.getMeetings),
  createMeeting: (accountId, input) => ipcRenderer.invoke(IPC.createMeeting, accountId, input),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  applyAction: (key, action, folderId) => ipcRenderer.invoke(IPC.applyAction, key, action, folderId),
  listFolders: (accountId) => ipcRenderer.invoke(IPC.listFolders, accountId),
  createFolder: (accountId, name) => ipcRenderer.invoke(IPC.createFolder, accountId, name),
  setAccountSettings: (accountId, settings) => ipcRenderer.invoke(IPC.setAccountSettings, accountId, settings),
  sendReply: (key, body) => ipcRenderer.invoke(IPC.sendReply, key, body),
  setExpanded: (expanded) => ipcRenderer.invoke(IPC.setExpanded, expanded),
  getRules: () => ipcRenderer.invoke(IPC.getRules),
  saveRule: (input) => ipcRenderer.invoke(IPC.saveRule, input),
  deleteRule: (id) => ipcRenderer.invoke(IPC.deleteRule, id),
  getRuleActivity: () => ipcRenderer.invoke(IPC.getRuleActivity),
  getServerRules: () => ipcRenderer.invoke(IPC.getServerRules),
  reloadServerRules: () => ipcRenderer.invoke(IPC.reloadServerRules),
  saveServerRule: (input) => ipcRenderer.invoke(IPC.saveServerRule, input),
  deleteServerRule: (accountId, ruleId) => ipcRenderer.invoke(IPC.deleteServerRule, accountId, ruleId),
  convertLocalRule: (ruleId, target) => ipcRenderer.invoke(IPC.convertLocalRule, ruleId, target),
  reconnectAccount: (accountId) => ipcRenderer.invoke(IPC.reconnectAccount, accountId),
  getTasks: () => ipcRenderer.invoke(IPC.getTasks),
  saveTask: (input) => ipcRenderer.invoke(IPC.saveTask, input),
  setTaskStatus: (id, status) => ipcRenderer.invoke(IPC.setTaskStatus, id, status),
  deleteTask: (id) => ipcRenderer.invoke(IPC.deleteTask, id),
  onServerRulesChanged: (listener) => subscribe(IPC.serverRulesChanged, listener),
  onRulesChanged: (listener) => subscribe(IPC.rulesChanged, listener),
  onTasksChanged: (listener) => subscribe(IPC.tasksChanged, listener),
  onRuleActivityChanged: (listener) => subscribe(IPC.ruleActivityChanged, listener),
  onInboxChanged: (listener) => subscribe(IPC.inboxChanged, listener),
  onMeetingsChanged: (listener) => subscribe(IPC.meetingsChanged, listener),
  onReminder: (listener) => subscribe(IPC.reminder, listener),
  onStatusChanged: (listener) => subscribe(IPC.statusChanged, listener),
  onFocusEmail: (listener) => subscribe<string | null | undefined>(IPC.focusEmail, (key) => listener(key ?? null))
}

contextBridge.exposeInMainWorld('narsil', api)
