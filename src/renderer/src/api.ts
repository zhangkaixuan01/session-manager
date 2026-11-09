import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import type { AppInfo, ConvertResult, DeleteResult, PreviewResult, RenameResult, SessionMeta, ProviderId, UpdateCheckResult } from '@shared/types'

type FileArgs = { providerId: ProviderId; sourcePath: string }
export const api = {
  listSessions: (providerId: ProviderId) => invoke<SessionMeta[]>('list_sessions', { providerId }),
  renameSession: (args: FileArgs & { sessionId: string; newTitle: string }) => invoke<RenameResult>('rename_session', { args }),
  deleteSession: (args: FileArgs) => invoke<DeleteResult>('delete_session', { args }),
  previewSession: (args: FileArgs) => invoke<PreviewResult>('preview_session', { args }),
  convertSession: (args: FileArgs & { sessionId: string; title?: string }) => invoke<ConvertResult>('convert_session', { args }),
  revealPath: (path: string) => invoke<void>('reveal_path', { path }),
  setTheme: (theme: 'light' | 'dark') => invoke<void>('set_theme', { theme }),
  checkUpdates: () => invoke<UpdateCheckResult>('check_updates'),
  openExternal: (url: string) => invoke<void>('open_external', { url }),
  appInfo: () => invoke<AppInfo>('app_info'),
  copyText: writeText
}
export type { AppInfo, DeleteResult, PreviewResult, RenameResult, SessionMeta, ProviderId }
