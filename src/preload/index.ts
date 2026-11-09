import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppInfo,
  ConvertResult,
  DeleteResult,
  PreviewResult,
  RenameResult,
  SessionMeta,
  UpdateCheckResult,
  ProviderId
} from '@shared/types'

const api = {
  listSessions: (providerId: ProviderId): Promise<SessionMeta[]> =>
    ipcRenderer.invoke('sessions:list', providerId),
  renameSession: (args: {
    providerId: ProviderId
    sessionId: string
    sourcePath: string
    newTitle: string
  }): Promise<RenameResult> => ipcRenderer.invoke('sessions:rename', args),
  deleteSession: (args: { providerId: ProviderId; sourcePath: string }): Promise<DeleteResult> =>
    ipcRenderer.invoke('sessions:delete', args),
  previewSession: (args: { providerId: ProviderId; sourcePath: string }): Promise<PreviewResult> =>
    ipcRenderer.invoke('sessions:preview', args),
  convertSession: (args: {
    providerId: ProviderId
    sessionId: string
    sourcePath: string
    title?: string
  }): Promise<ConvertResult> => ipcRenderer.invoke('sessions:convert', args),
  revealPath: (p: string): Promise<void> => ipcRenderer.invoke('shell:revealPath', p),
  setTheme: (theme: 'light' | 'dark'): Promise<void> => ipcRenderer.invoke('app:setTheme', theme),
  checkUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info')
}

contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
