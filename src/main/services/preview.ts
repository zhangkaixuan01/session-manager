import fsp from 'node:fs/promises'
import readline from 'node:readline'
import fs from 'node:fs'
import type { PreviewMessage, PreviewResult, ProviderId } from '@shared/types'
import { decompressZstCapped } from '../infra/zstd'
import { codexTitleCandidate, extractCodexText, isCompressed } from '../providers/codex'
import { parseTimestampToMs } from '../infra/time'

const MAX_MESSAGES = 500
const MAX_TOTAL_BYTES = 1024 * 1024

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function stripReminder(text: string): string {
  return text.replace(SYSTEM_REMINDER_RE, '').trim()
}

function claudeExtractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('')
  }
  return ''
}

function isClaudeInjected(text: string): boolean {
  return (
    text.includes('<local-command-caveat>') ||
    text.startsWith('<local-command-stdout>') ||
    text.startsWith('<local-command-stderr>') ||
    text.startsWith('<task-notification>')
  )
}

class Collector {
  messages: PreviewMessage[] = []
  totalBytes = 0
  truncated = false

  /** 超限即拒绝并置截断标记 */
  push(role: 'user' | 'assistant', ts: number | null, text: string): boolean {
    const clean = stripReminder(text).trim()
    if (clean === '') return true
    if (this.messages.length >= MAX_MESSAGES) {
      this.truncated = true
      return false
    }
    this.totalBytes += Buffer.byteLength(clean, 'utf8')
    if (this.totalBytes > MAX_TOTAL_BYTES) {
      this.truncated = true
      return false
    }
    this.messages.push({ role, ts, text: clean })
    return true
  }
}

// ─── Claude：逐行流式读，assistant 同 message.id 相邻合并 ───────────────────

export async function previewClaude(p: string): Promise<PreviewResult> {
  const c = new Collector()
  const rl = readline.createInterface({
    input: fs.createReadStream(p, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  let lastAssistantId: string | null = null
  let lastAssistantText = ''

  try {
    for await (const line of rl) {
      if (line.trim() === '') continue
      let v: Record<string, unknown>
      try {
        v = JSON.parse(line)
      } catch {
        continue
      }
      if (v.type !== 'user' && v.type !== 'assistant') continue
      if (v.isMeta === true) continue
      const message = v.message as
        | { role?: string; content?: unknown; id?: unknown }
        | undefined
      if (!message) continue
      const ts = parseTimestampToMs(v.timestamp)
      const text = claudeExtractText(message.content)
      if (text === '') continue

      if (v.type === 'assistant') {
        const msgId = typeof message.id === 'string' ? message.id : null
        if (msgId !== null && msgId === lastAssistantId) {
          // 同一条 API 消息的后续块/快照：追加（快照重复时跳过）
          if (!lastAssistantText.endsWith(text)) lastAssistantText += text
          continue
        }
        if (lastAssistantId !== null) {
          if (!c.push('assistant', null, lastAssistantText)) break
        }
        lastAssistantId = msgId
        lastAssistantText = text
        continue
      }

      // user：先冲刷待输出的 assistant
      if (lastAssistantId !== null) {
        if (!c.push('assistant', null, lastAssistantText)) break
        lastAssistantId = null
        lastAssistantText = ''
      }
      if (isClaudeInjected(text) || text.trim().startsWith('<command-name>')) continue
      if (!c.push('user', ts, text)) break
    }
  } finally {
    rl.close()
  }
  if (lastAssistantId !== null) c.push('assistant', null, lastAssistantText)
  return { messages: c.messages, truncated: c.truncated }
}

// ─── Codex：response_item.payload.type === "message" ───────────────────────

async function readCodexLines(p: string): Promise<{ lines: string[]; truncated: boolean }> {
  if (!isCompressed(p)) {
    const text = await fsp.readFile(p, 'utf8')
    return { lines: text.split(/\r?\n/), truncated: false }
  }
  const { text, truncated } = await decompressZstCapped(p)
  return { lines: text.split(/\r?\n/), truncated }
}

export async function previewCodex(p: string): Promise<PreviewResult> {
  const { lines, truncated: srcTruncated } = await readCodexLines(p)
  const c = new Collector()
  for (const line of lines) {
    if (line.trim() === '') continue
    let v: Record<string, unknown>
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    if (v.type !== 'response_item') continue
    const payload = v.payload as { type?: string; role?: string; content?: unknown } | undefined
    if (!payload || payload.type !== 'message') continue
    const role = payload.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = extractCodexText(payload.content)
    if (text === '') continue
    const ts = parseTimestampToMs(v.timestamp)
    if (role === 'user') {
      // 注入上下文行不进预览；IDE 上下文只取真实提问
      const candidate = codexTitleCandidate(text)
      if (candidate === null || candidate === '') continue
      if (!c.push('user', ts, candidate)) break
    } else {
      if (!c.push('assistant', ts, text)) break
    }
  }
  return { messages: c.messages, truncated: c.truncated || srcTruncated }
}

export async function previewSession(providerId: ProviderId, p: string): Promise<PreviewResult> {
  return providerId === 'claude' ? previewClaude(p) : previewCodex(p)
}
