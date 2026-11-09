import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SessionMeta, TitleSource } from '@shared/types'
import { claudeProjectsDir } from '../paths'
import { readHeadTailLines, readTailBytesLines } from '../infra/head-tail'
import { cachedParse, forgetCache } from '../infra/parse-cache'
import {
  parseTimestampToMs,
  truncateSummary,
  TITLE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  pathBasename
} from '../infra/time'

const PROVIDER_ID = 'claude'
const HEAD_LINES = 10
/** Claude 把 custom-title / relocated 等元数据写在末尾 64KiB 窗口内 */
const TAIL_BYTES = 64 * 1024

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('')
  }
  return ''
}

/** 注入型文本（cc-switch claude.rs is_injected_text） */
function isInjectedText(text: string): boolean {
  return (
    text.includes('<local-command-caveat>') ||
    text.startsWith('<local-command-stdout>') ||
    text.startsWith('<local-command-stderr>') ||
    text.startsWith('<task-notification>')
  )
}

function isRealUserText(text: string): boolean {
  const t = text.trim()
  return t !== '' && !t.startsWith('<command-name>') && !isInjectedText(t)
}

export { isRealUserText, isInjectedText }

export function isAgentSession(fileName: string): boolean {
  return fileName.startsWith('agent-') || fileName === 'journal.jsonl'
}

async function scanFile(p: string): Promise<SessionMeta | null> {
  const [ht, tail64] = await Promise.all([
    readHeadTailLines(p, HEAD_LINES, 30),
    readTailBytesLines(p, TAIL_BYTES)
  ])

  // ─── 头部：sessionId / cwd / createdAt / 首条真实用户消息 ───
  let sessionId: string | null = null
  let projectDir: string | null = null
  let createdAt: number | null = null
  let firstUserMessage: string | null = null

  for (const line of ht.head) {
    let v: Record<string, unknown>
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    if (sessionId === null && typeof v.sessionId === 'string') sessionId = v.sessionId
    if (projectDir === null && typeof v.cwd === 'string') projectDir = v.cwd
    if (createdAt === null) createdAt = parseTimestampToMs(v.timestamp)
    if (firstUserMessage === null) {
      const message = v.message as { role?: string; content?: unknown } | undefined
      const isUser = v.type === 'user' || message?.role === 'user'
      if (isUser && message) {
        const text = extractText(message.content)
        if (isRealUserText(text)) firstUserMessage = text.trim()
      }
    }
    if (sessionId !== null && projectDir !== null && createdAt !== null && firstUserMessage !== null) {
      break
    }
  }

  // ─── 尾部 64KiB 窗口：从后往前，同名记录最后一条生效 ───
  let lastActiveAt: number | null = null
  let customTitle: string | null = null
  let aiTitle: string | null = null
  // 旧版 Claude Code 的顶部摘要行（本机新版已无，兼容读取）
  let legacySummary: string | null = null
  let relocatedCwd: string | null = null
  let summary: string | null = null

  for (let i = tail64.length - 1; i >= 0; i--) {
    let v: Record<string, unknown>
    try {
      v = JSON.parse(tail64[i])
    } catch {
      continue
    }
    if (lastActiveAt === null) lastActiveAt = parseTimestampToMs(v.timestamp)
    if (customTitle === null && v.type === 'custom-title' && typeof v.customTitle === 'string') {
      const t = v.customTitle.trim()
      if (t) customTitle = t
    }
    if (aiTitle === null && v.type === 'ai-title' && typeof v.aiTitle === 'string') {
      const t = v.aiTitle.trim()
      if (t) aiTitle = t
    }
    if (legacySummary === null && v.type === 'summary' && typeof v.summary === 'string') {
      const t = v.summary.trim()
      if (t) legacySummary = t
    }
    if (relocatedCwd === null && v.type === 'relocated' && typeof v.relocatedCwd === 'string') {
      const t = v.relocatedCwd.trim()
      if (t) relocatedCwd = t
    }
    if (summary === null) {
      if (v.isMeta === true) continue
      const message = v.message as { content?: unknown } | undefined
      if (message) {
        const text = extractText(message.content)
        if (isRealUserText(text)) summary = text
      }
    }
  }

  // /cd 移动过会话：最后的 relocated 记录覆盖起始 cwd
  if (relocatedCwd !== null) projectDir = relocatedCwd

  sessionId ??= path.basename(p, '.jsonl')
  if (sessionId === null) return null

  // 标题优先级：custom-title > ai-title > 旧版 summary > 首条用户消息 > 目录名
  let title: string | null
  let titleSource: TitleSource
  if (customTitle !== null) {
    title = customTitle
    titleSource = 'custom'
  } else if (aiTitle !== null) {
    title = aiTitle
    titleSource = 'auto'
  } else if (legacySummary !== null) {
    title = legacySummary
    titleSource = 'auto'
  } else if (firstUserMessage !== null) {
    title = firstUserMessage
    titleSource = 'firstMessage'
  } else if (projectDir !== null) {
    title = pathBasename(projectDir)
    titleSource = 'dir'
  } else {
    title = null
    titleSource = 'dir'
  }
  title = title !== null ? truncateSummary(title, TITLE_MAX_CHARS) : null

  return {
    providerId: PROVIDER_ID,
    sessionId,
    title,
    titleSource,
    summary: summary !== null ? truncateSummary(summary, SUMMARY_MAX_CHARS) : null,
    projectDir,
    createdAt,
    lastActiveAt,
    sourcePath: p,
    resumeCommand: `claude --resume ${sessionId}`,
    archived: false,
    running: false
  }
}

async function collectJsonlFiles(root: string, files: string[]): Promise<void> {
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const p = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await collectJsonlFiles(p, files)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !isAgentSession(entry.name)) {
      files.push(p)
    }
  }
}

export async function scanClaudeSessions(running: Set<string>): Promise<SessionMeta[]> {
  const root = claudeProjectsDir()
  try {
    await fsp.access(root)
  } catch {
    return []
  }
  const files: string[] = []
  await collectJsonlFiles(root, files)
  const metas: SessionMeta[] = []
  for (const f of files) {
    try {
      const meta = await cachedParse(f, () => scanFile(f))
      if (meta) metas.push({ ...meta, running: running.has(meta.sessionId) })
    } catch {
      // 读不了（占用/权限）：本轮跳过，不缓存
    }
  }
  // 运行中的会话置顶；两组内部均按最近活跃时间倒序。
  metas.sort((a, b) =>
    Number(b.running) - Number(a.running) ||
    (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0)
  )
  return metas
}

/** 重命名后让缓存失效（下一轮列表重扫该文件，读到新 custom-title） */
export function forgetClaudeCache(p: string): void {
  forgetCache(p)
}
