export type ProviderId = 'claude' | 'codex'

/** 标题来源：custom=用户改名 / auto=CLI 自动生成 / firstMessage=首条消息 / dir=目录名 */
export type TitleSource = 'custom' | 'auto' | 'firstMessage' | 'dir'

export interface SessionMeta {
  providerId: ProviderId
  sessionId: string
  title: string | null
  titleSource: TitleSource
  summary: string | null
  projectDir: string | null
  /** 毫秒时间戳 */
  createdAt: number | null
  /** 毫秒时间戳 */
  lastActiveAt: number | null
  sourcePath: string
  resumeCommand: string
  /** Codex archived_sessions 中的会话 */
  archived: boolean
  /** 会话正在运行（Claude Code 有运行时注册表可查） */
  running: boolean
}

export interface PreviewMessage {
  role: 'user' | 'assistant'
  ts: number | null
  text: string
}

export interface PreviewResult {
  messages: PreviewMessage[]
  truncated: boolean
}

export interface RenameResult {
  ok: boolean
  error?: string
  warnings: string[]
  /** Codex 专用：state 数据库是否成功更新 */
  dbUpdated?: boolean
}

export interface DeleteResult {
  ok: boolean
  error?: string
  /** 一并移入回收站的关联文件数（Claude sidecar / Codex 兄弟形态） */
  extraTrashed?: number
}

/** 跨 CLI 转换结果：生成对方格式的会话副本 */
export interface ConvertResult {
  ok: boolean
  error?: string
  /** 目标 CLI 的 resume 命令（codex resume <id> / claude --resume <id>） */
  resumeCommand?: string
  newSessionId?: string
  /** 副本落在哪一侧 */
  targetProvider?: ProviderId
  /** 转换提示（如丢弃的思考记录数） */
  warnings: string[]
}

export interface AppInfo {
  /** 应用版本（package.json version） */
  version: string
  runtime: string
  sqliteAvailable: boolean
  platform: string
}

/** 检查更新结果（GitHub Releases latest） */
export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string | null
  hasUpdate: boolean
  /** Release 页面地址 */
  releaseUrl: string | null
  /** 更新说明（截断） */
  notes: string | null
  /** 请求失败时的错误信息（仓库不存在 / 网络不通） */
  error?: string
}
