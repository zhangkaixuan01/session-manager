import fsp from 'node:fs/promises'
import path from 'node:path'
import type { SessionMeta, TitleSource } from '@shared/types'
import { codexSessionRoots } from '../paths'
import { readFirstLines, readTailBytesLines } from '../infra/head-tail'
import { cachedParse } from '../infra/parse-cache'
import { readZstHeadLines } from '../infra/zstd'
import {
  parseTimestampToMs,
  truncateSummary,
  TITLE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  pathBasename
} from '../infra/time'
import { loadThreadTitles, retryPendingDbUpdates } from './codex-titles'

const PROVIDER_ID = 'codex'
const HEAD_LINES = 10
const TAIL_BYTES = 64 * 1024

// ─── rollout 文件双形态（翻译自 cc-switch codex_rollout_file.rs） ───────────

export function isCompressed(p: string): boolean {
  return p.endsWith('.jsonl.zst')
}

export function isRolloutFileName(name: string): boolean {
  return name.endsWith('.jsonl') || name.endsWith('.jsonl.zst')
}

/** 去掉 .zst 后的逻辑路径 */
export function logicalPath(p: string): string {
  return isCompressed(p) ? p.slice(0, -'.zst'.length) : p
}

/** 另一形态路径：x.jsonl ↔ x.jsonl.zst */
export function siblingPath(p: string): string {
  return isCompressed(p) ? logicalPath(p) : p + '.zst'
}

/** 同逻辑名两形态并存时保留普通形态（删除时两份都要删） */
export function dedupeSiblings(paths: string[]): string[] {
  const plain = new Set(paths.filter((p) => !isCompressed(p)).map(logicalPath))
  return paths.filter((p) => !isCompressed(p) || !plain.has(logicalPath(p)))
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/

// ─── 首条用户消息过滤（翻译自 cc-switch codex.rs） ─────────────────────────

const VSCODE_CONTEXT_PREFIX = '# Context from my IDE setup:'
const CODEX_REQUEST_MARKER = 'my request for codex'

function codexRequestHeadingPayload(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('#')) return null
  const heading = trimmed.replace(/^#+/, '').trimStart()
  if (!heading.toLowerCase().startsWith(CODEX_REQUEST_MARKER)) return null
  const suffix = heading.slice(CODEX_REQUEST_MARKER.length).trimStart()
  if (suffix === '') return ''
  const sep = suffix[0]
  if (![':', '：', '-', '—'].includes(sep)) return null
  return suffix.replace(/^[\s:：\-—]+/, '').trim()
}

/** VS Code 注入的上下文里，真实提问是最后一个 "## My request for Codex:" 节 */
function extractIdePrompt(text: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let prompt: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const inline = codexRequestHeadingPayload(lines[i])
    if (inline === null) continue
    if (inline !== '') {
      prompt = inline
      continue
    }
    const following = lines.slice(i + 1).join('\n').trim()
    if (following) prompt = following
  }
  return prompt
}

export function codexTitleCandidate(text: string): string | null {
  const t = text.trim()
  if (
    t === '' ||
    t.startsWith('# AGENTS.md') ||
    t.startsWith('<environment_context>') ||
    t.startsWith('<user_instructions>') ||
    t.startsWith('<turn_aborted>')
  ) {
    return null
  }
  if (t.startsWith(VSCODE_CONTEXT_PREFIX)) return extractIdePrompt(t)
  return t
}

export function extractCodexText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object') {
          const item = b as { text?: unknown }
          return typeof item.text === 'string' ? item.text : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

function isSubagentSource(source: unknown): boolean {
  return typeof source === 'object' && source !== null && 'subagent' in source
}

// ─── 单文件扫描 ────────────────────────────────────────────────────────────

async function scanFile(
  p: string,
  threadTitles: Map<string, string>
): Promise<SessionMeta | null> {
  // 普通文件：逐行读头（session_meta 行超长）+ 尾 64KiB 窗口
  // 压缩文件解不出结尾：头部流式解压 10 行，最后活跃时间用 mtime 兜底
  let head: string[]
  let tail: string[]
  let fallbackLastActive: number | null = null
  if (!isCompressed(p)) {
    const [h, t] = await Promise.all([readFirstLines(p, HEAD_LINES), readTailBytesLines(p, TAIL_BYTES)])
    head = h
    tail = t
  } else {
    head = await readZstHeadLines(p, HEAD_LINES)
    tail = []
    try {
      const st = await fsp.stat(p)
      fallbackLastActive = Math.round(st.mtimeMs)
    } catch {
      fallbackLastActive = null
    }
  }

  let sessionId: string | null = null
  let projectDir: string | null = null
  let createdAt: number | null = null
  let firstUserMessage: string | null = null

  for (const line of head) {
    let v: Record<string, unknown>
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    if (createdAt === null) createdAt = parseTimestampToMs(v.timestamp)
    if (v.type === 'session_meta') {
      const payload = v.payload as Record<string, unknown> | undefined
      if (payload) {
        if (isSubagentSource(payload.source)) return null
        if (sessionId === null) {
          const id = payload.id ?? payload.session_id
          if (typeof id === 'string' && id) sessionId = id
        }
        if (projectDir === null && typeof payload.cwd === 'string') projectDir = payload.cwd
        if (createdAt === null) createdAt = parseTimestampToMs(payload.timestamp)
      }
    }
    if (firstUserMessage === null && v.type === 'response_item') {
      const payload = v.payload as Record<string, unknown> | undefined
      if (payload?.type === 'message' && payload.role === 'user') {
        const text = extractCodexText(payload.content)
        const candidate = codexTitleCandidate(text)
        if (candidate) firstUserMessage = candidate
      }
    }
    if (sessionId !== null && projectDir !== null && createdAt !== null && firstUserMessage !== null) {
      break
    }
  }

  // 尾部（仅普通形态）：最后活跃时间 + 最后一条消息作 summary
  let lastActiveAt: number | null = null
  let summary: string | null = null
  for (let i = tail.length - 1; i >= 0; i--) {
    let v: Record<string, unknown>
    try {
      v = JSON.parse(tail[i])
    } catch {
      continue
    }
    if (lastActiveAt === null) lastActiveAt = parseTimestampToMs(v.timestamp)
    if (summary === null && v.type === 'response_item') {
      const payload = v.payload as Record<string, unknown> | undefined
      if (payload?.type === 'message') {
        const text = extractCodexText(payload.content)
        if (text.trim() !== '') summary = text
      }
    }
    if (lastActiveAt !== null && summary !== null) break
  }
  lastActiveAt ??= fallbackLastActive

  const fileName = path.basename(p)
  sessionId ??= UUID_RE.exec(fileName)?.[0] ?? null
  if (sessionId === null) return null

  let title: string | null
  let titleSource: TitleSource
  const threadTitle = threadTitles.get(sessionId)
  if (threadTitle !== undefined) {
    title = threadTitle
    titleSource = 'custom'
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
    resumeCommand: `codex resume ${sessionId}`,
    archived: p.includes(`${path.sep}archived_sessions${path.sep}`),
    running: false
  }
}

async function collectRolloutFiles(root: string, files: string[]): Promise<void> {
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const p = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await collectRolloutFiles(p, files)
    } else if (entry.isFile() && isRolloutFileName(entry.name)) {
      files.push(p)
    }
  }
}

export async function scanCodexSessions(): Promise<SessionMeta[]> {
  await retryPendingDbUpdates()
  const threadTitles = await loadThreadTitles()

  const files: string[] = []
  for (const root of codexSessionRoots()) {
    await collectRolloutFiles(root, files)
  }
  const deduped = dedupeSiblings(files)

  const metas: SessionMeta[] = []
  for (const f of deduped) {
    try {
      const meta = await cachedParse(f, () => scanFile(f, threadTitles))
      if (meta) metas.push(meta)
    } catch {
      // 读不了：本轮跳过
    }
  }
  metas.sort((a, b) => (b.lastActiveAt ?? b.createdAt ?? 0) - (a.lastActiveAt ?? a.createdAt ?? 0))
  return metas
}
