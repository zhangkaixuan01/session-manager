import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { ConvertResult, ProviderId } from '@shared/types'
import {
  claudeProjectsDir,
  codexConfigDir,
  codexSessionIndexPath,
  codexSessionRoots
} from '../paths'
import { readFirstLines } from '../infra/head-tail'
import { decompressZstCapped } from '../infra/zstd'
import { codexTitleCandidate, extractCodexText, isCompressed } from '../providers/codex'
import { isRealUserText } from '../providers/claude'
import { parseTimestampToMs, truncateSummary, SUMMARY_MAX_CHARS } from '../infra/time'
import { registerThreadInDbs, setRenameOverride } from '../providers/codex-titles'
import { validateTitle } from './rename'

/**
 * 跨 CLI 会话转换：读取源会话的对话历史（user / assistant / 工具调用），
 * 按对方 CLI 的原生会话格式重建一份**新副本**（新 sessionId），原文件不动。
 *
 * 已知有损项（社区转换器共识）：thinking/reasoning 不可移植（签名/加密绑定），
 * 工具调用作为历史上下文回放（不重新执行）；上下文超限由目标 CLI 自行压缩兜底。
 */

// ─── 中间表示：与两边原生格式都贴近的行模型 ─────────────────────────────────

interface ConvToolUse {
  /** 两边 id 前缀恰好都是 call_，原样保留 */
  id: string
  name: string
  /** Codex 风格的参数文本（JSON 字符串；custom_tool_call 为裸脚本） */
  args: string
}

interface ConvToolResult {
  id: string
  text: string
  isError: boolean
}

interface ConvRow {
  kind: 'user' | 'assistant'
  ts: number | null
  text: string
  toolUses: ConvToolUse[]
  toolResults: ConvToolResult[]
  /** assistant 行的源模型名（Claude message.model / Codex turn_context.model） */
  model?: string
}

interface SourceData {
  rows: ConvRow[]
  cwd: string | null
  createdAt: number | null
  model: string | null
  droppedThinking: number
}

interface CodexBaseline {
  originator: string
  cliVersion: string
  source: string
  threadSource: string
  modelProvider: string
}

const CODEX_DEFAULT_BASELINE: CodexBaseline = {
  originator: 'codex-tui',
  cliVersion: '0.163.0',
  source: 'vscode',
  threadSource: 'user',
  modelProvider: 'custom'
}

let recentCodexBaselinePromise: Promise<CodexBaseline> | null = null
let recentClaudeVersionPromise: Promise<string> | null = null

function uuid(): string {
  return crypto.randomUUID()
}

function isoOrNull(ts: number | null): string | null {
  return ts !== null && Number.isFinite(ts) ? new Date(ts).toISOString() : null
}

/** Claude 项目目录转义：非字母数字全部替换为 '-'（D:\codes → D--codes） */
function escapeClaudeDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

async function collectFilesRecursive(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  const result: string[] = []
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const p = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...(await collectFilesRecursive(p, predicate)))
    else if (entry.isFile() && predicate(entry.name)) result.push(p)
  }
  return result
}

async function latestFile(paths: string[]): Promise<string | null> {
  let latest: { path: string; mtimeMs: number } | null = null
  for (const p of paths) {
    try {
      const st = await fsp.stat(p)
      if (latest === null || st.mtimeMs > latest.mtimeMs) latest = { path: p, mtimeMs: st.mtimeMs }
    } catch {
      // 文件可能在扫描过程中被 CLI 轮转或清理
    }
  }
  return latest?.path ?? null
}

async function readRecentCodexBaseline(): Promise<CodexBaseline> {
  const files: string[] = []
  for (const root of codexSessionRoots()) {
    files.push(...(await collectFilesRecursive(root, (name) => name.endsWith('.jsonl') || name.endsWith('.jsonl.zst')))
    )
  }
  const latest = await latestFile(files)
  if (latest === null) return { ...CODEX_DEFAULT_BASELINE }

  try {
    const text = isCompressed(latest)
      ? (await decompressZstCapped(latest, 8 * 1024 * 1024)).text
      : (await readFirstLines(latest, 2)).join('\n')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      const v = JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> }
      if (v.type !== 'session_meta' || !v.payload) continue
      const p = v.payload
      return {
        originator: typeof p.originator === 'string' ? p.originator : CODEX_DEFAULT_BASELINE.originator,
        cliVersion: typeof p.cli_version === 'string' ? p.cli_version : CODEX_DEFAULT_BASELINE.cliVersion,
        source: typeof p.source === 'string' ? p.source : CODEX_DEFAULT_BASELINE.source,
        threadSource: typeof p.thread_source === 'string' ? p.thread_source : CODEX_DEFAULT_BASELINE.threadSource,
        modelProvider: typeof p.model_provider === 'string' ? p.model_provider : CODEX_DEFAULT_BASELINE.modelProvider
      }
    }
  } catch {
    // 读取最近文件失败时使用已知可用的最小基线
  }
  return { ...CODEX_DEFAULT_BASELINE }
}

function recentCodexBaseline(): Promise<CodexBaseline> {
  recentCodexBaselinePromise ??= readRecentCodexBaseline()
  return recentCodexBaselinePromise
}

async function readRecentClaudeVersion(): Promise<string> {
  const files = await collectFilesRecursive(claudeProjectsDir(), (name) => name.endsWith('.jsonl'))
  const latest = await latestFile(files)
  if (latest !== null) {
    try {
      for (const line of await readFirstLines(latest, 10)) {
        const v = JSON.parse(line) as { version?: unknown }
        if (typeof v.version === 'string' && v.version.trim() !== '') return v.version
      }
    } catch {
      // 使用 fallback
    }
  }
  return '2.1.311'
}

function recentClaudeVersion(): Promise<string> {
  recentClaudeVersionPromise ??= readRecentClaudeVersion()
  return recentClaudeVersionPromise
}

// ─── 读取端：Claude JSONL → ConvRow[] ───────────────────────────────────────

interface ClaudeBlock {
  type?: unknown
  text?: unknown
  thinking?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
          ? ((b as { text: string }).text)
          : ''
      )
      .join('')
  }
  return ''
}

async function readClaudeSource(p: string): Promise<SourceData> {
  const rows: ConvRow[] = []
  let droppedThinking = 0
  let cwd: string | null = null
  let createdAt: number | null = null

  const rl = readline.createInterface({
    input: fs.createReadStream(p, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  // 相邻同 message.id 的 assistant 行兼容合并：
  // 快照语义（后行包含前行文本）用 endsWith 去重；增量语义直接拼接；
  // tool_use 按 id 去重（两种语义都收敛到"每个调用恰好一次"）
  let curId: string | null = null
  let curText = ''
  let curUses: ConvToolUse[] = []
  const curUseIds = new Set<string>()
  let curTs: number | null = null
  let curModel: string | undefined

  const flushAssistant = () => {
    if (curId === null) return
    if (curText.trim() !== '' || curUses.length > 0) {
      rows.push({ kind: 'assistant', ts: curTs, text: curText, toolUses: curUses, toolResults: [], model: curModel })
    }
    curId = null
    curText = ''
    curUses = []
    curUseIds.clear()
    curTs = null
    curModel = undefined
  }

  try {
    for await (const line of rl) {
      if (line.trim() === '') continue
      let v: Record<string, unknown>
      try {
        v = JSON.parse(line)
      } catch {
        continue
      }
      if (cwd === null && typeof v.cwd === 'string') cwd = v.cwd
      if (createdAt === null) createdAt = parseTimestampToMs(v.timestamp)
      // 子代理链与命令元数据不在主上下文
      if (v.isSidechain === true || v.isMeta === true) continue
      const message = v.message as { role?: string; content?: unknown; id?: unknown; model?: unknown } | undefined
      if (!message) continue

      if (v.type === 'assistant') {
        const msgId = typeof message.id === 'string' ? message.id : null
        if (msgId === null || msgId !== curId) {
          flushAssistant()
          curId = msgId
          curTs = parseTimestampToMs(v.timestamp)
          curModel = typeof message.model === 'string' ? message.model : undefined
        } else if (curTs === null) {
          curTs = parseTimestampToMs(v.timestamp)
        }
        if (!Array.isArray(message.content)) {
          flushAssistant()
          continue
        }
        for (const raw of message.content as ClaudeBlock[]) {
          if (!raw || typeof raw !== 'object') continue
          if (raw.type === 'text' && typeof raw.text === 'string') {
            if (!curText.endsWith(raw.text)) curText += raw.text
          } else if (raw.type === 'thinking') {
            droppedThinking++
          } else if (raw.type === 'tool_use' && typeof raw.id === 'string' && typeof raw.name === 'string') {
            if (!curUseIds.has(raw.id)) {
              curUseIds.add(raw.id)
              curUses.push({ id: raw.id, name: raw.name, args: JSON.stringify(raw.input ?? {}) })
            }
          }
        }
        continue
      }

      if (v.type === 'user') {
        flushAssistant()
        const ts = parseTimestampToMs(v.timestamp)
        const content = message.content
        if (typeof content === 'string') {
          if (isRealUserText(content)) {
            rows.push({ kind: 'user', ts, text: content, toolUses: [], toolResults: [] })
          }
          continue
        }
        if (!Array.isArray(content)) continue
        const toolResults: ConvToolResult[] = []
        let text = ''
        for (const raw of content as ClaudeBlock[]) {
          if (!raw || typeof raw !== 'object') continue
          if (raw.type === 'tool_result' && typeof raw.tool_use_id === 'string') {
            toolResults.push({
              id: raw.tool_use_id,
              text: blockText(raw.content),
              isError: raw.is_error === true
            })
          } else if (raw.type === 'text' && typeof raw.text === 'string') {
            if (isRealUserText(raw.text) && !raw.text.trim().startsWith('[Request interrupted')) {
              text += raw.text
            }
          }
        }
        if (toolResults.length > 0 || text.trim() !== '') {
          rows.push({ kind: 'user', ts, text, toolUses: [], toolResults })
        }
      }
    }
  } finally {
    rl.close()
  }
  flushAssistant()

  return {
    rows,
    cwd,
    createdAt,
    model: rows.find((r) => r.model)?.model ?? null,
    droppedThinking
  }
}

// ─── 读取端：Codex rollout → ConvRow[] ──────────────────────────────────────

interface CodexPayload {
  type?: unknown
  role?: unknown
  content?: unknown
  name?: unknown
  arguments?: unknown
  input?: unknown
  output?: unknown
  call_id?: unknown
  replacement_history?: unknown
}

function appendCompactedHistory(rows: ConvRow[], history: unknown, ts: number | null): void {
  if (!Array.isArray(history)) return
  for (const item of history) {
    if (!item || typeof item !== 'object') continue
    const v = item as { role?: unknown; content?: unknown }
    const role = v.role
    const text = extractCodexText(v.content)
    if (role === 'user') {
      const candidate = codexTitleCandidate(text)
      if (candidate !== null && candidate.trim() !== '') {
        rows.push({ kind: 'user', ts, text: candidate, toolUses: [], toolResults: [] })
      }
    } else if (role === 'assistant' && text.trim() !== '') {
      rows.push({ kind: 'assistant', ts, text, toolUses: [], toolResults: [] })
    }
  }
}

async function readCodexSource(p: string): Promise<SourceData & { truncated: boolean }> {
  let text: string
  let truncated = false
  if (isCompressed(p)) {
    const r = await decompressZstCapped(p)
    text = r.text
    truncated = r.truncated
  } else {
    text = await fsp.readFile(p, 'utf8')
  }

  const rows: ConvRow[] = []
  let droppedThinking = 0
  let cwd: string | null = null
  let createdAt: number | null = null
  let model: string | null = null

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let v: Record<string, unknown>
    try {
      v = JSON.parse(line)
    } catch {
      continue
    }
    if (createdAt === null) createdAt = parseTimestampToMs(v.timestamp)
    if (v.type === 'session_meta') {
      const payload = v.payload as { cwd?: unknown } | undefined
      if (payload && typeof payload.cwd === 'string') cwd = payload.cwd
      continue
    }
    if (v.type === 'turn_context') {
      const payload = v.payload as { model?: unknown } | undefined
      if (model === null && payload && typeof payload.model === 'string') model = payload.model
      continue
    }
    if (v.type === 'compacted') {
      const payload = v.payload as CodexPayload | undefined
      appendCompactedHistory(rows, payload?.replacement_history, parseTimestampToMs(v.timestamp))
      continue
    }
    if (v.type !== 'response_item') continue
    const payload = v.payload as CodexPayload | undefined
    if (!payload || typeof payload.type !== 'string') continue
    const ts = parseTimestampToMs(v.timestamp)

    switch (payload.type) {
      case 'message': {
        const role = payload.role
        if (role === 'user') {
          // 注入上下文（environment_context / IDE setup）不进副本；IDE 上下文只取真实提问
          const candidate = codexTitleCandidate(extractCodexText(payload.content))
          if (candidate !== null && candidate.trim() !== '') {
            rows.push({ kind: 'user', ts, text: candidate, toolUses: [], toolResults: [] })
          }
        } else if (role === 'assistant') {
          const t = extractCodexText(payload.content)
          if (t.trim() !== '') {
            rows.push({ kind: 'assistant', ts, text: t, toolUses: [], toolResults: [] })
          }
        }
        // developer（base instructions 注入）跳过
        break
      }
      case 'function_call':
      case 'custom_tool_call': {
        if (typeof payload.call_id !== 'string') break
        const args =
          payload.type === 'function_call'
            ? typeof payload.arguments === 'string'
              ? payload.arguments
              : JSON.stringify(payload.arguments ?? {})
            : typeof payload.input === 'string'
              ? payload.input
              : ''
        rows.push({
          kind: 'assistant',
          ts,
          text: '',
          toolUses: [{ id: payload.call_id, name: typeof payload.name === 'string' ? payload.name : 'tool', args }],
          toolResults: []
        })
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        if (typeof payload.call_id !== 'string') break
        const outText =
          payload.type === 'function_call_output'
            ? typeof payload.output === 'string'
              ? payload.output
              : blockText(payload.output)
            : extractCodexText(payload.output)
        rows.push({
          kind: 'user',
          ts,
          text: '',
          toolUses: [],
          toolResults: [{ id: payload.call_id, text: outText, isError: false }]
        })
        break
      }
      case 'reasoning':
        droppedThinking++
        break
      case 'compacted':
        appendCompactedHistory(rows, payload.replacement_history, ts)
        break
      default:
        // web_search / ghost_snapshot 等：跳过
        break
    }
  }

  return { rows, cwd, createdAt, model, droppedThinking, truncated }
}

// ─── 写入端：ConvRow[] → Codex rollout ──────────────────────────────────────

function codexStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

const CODEX_DEFAULT_MODEL = 'gpt-6.1-sol'

async function writeCodexSession(
  rows: ConvRow[],
  meta: {
    cwd: string
    title: string
    firstUserText: string | null
    model: string | null
    createdAt: number | null
    baseline: CodexBaseline
  },
  warnings: string[]
): Promise<{ id: string; resumeCommand: string; registered: number }> {
  const id = uuid()
  const now = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const dir = path.join(codexConfigDir(), 'sessions', String(now.getFullYear()), p2(now.getMonth() + 1), p2(now.getDate()))
  const rolloutPath = path.join(dir, `rollout-${codexStamp(now)}-${id}.jsonl`)

  const out: string[] = []
  let ordinal = 0
  const tsOf = (t: number | null) => isoOrNull(t) ?? now.toISOString()
  const push = (type: string, payload: unknown, t: number | null) => {
    out.push(JSON.stringify({ timestamp: tsOf(t), ordinal: ordinal++, type, payload }))
  }

  push(
    'session_meta',
    {
      id,
      session_id: id,
      timestamp: tsOf(meta.createdAt),
      cwd: meta.cwd,
      originator: meta.baseline.originator,
      cli_version: meta.baseline.cliVersion,
      source: meta.baseline.source,
      thread_source: meta.baseline.threadSource,
      model_provider: meta.baseline.modelProvider
    },
    meta.createdAt
  )

  const model = meta.model ?? CODEX_DEFAULT_MODEL
  for (const row of rows) {
    if (row.kind === 'user') {
      if (row.toolResults.length > 0) {
        for (const tr of row.toolResults) {
          push(
            'response_item',
            {
              type: 'function_call_output',
              status: 'completed',
              id: `fco_${uuid()}`,
              call_id: tr.id,
              output: tr.text
            },
            row.ts
          )
        }
        continue
      }
      if (row.text.trim() === '') continue
      // 每个 user turn 前一条 turn_context（Codex 原生节奏）
      push(
        'turn_context',
        {
          turn_id: uuid(),
          cwd: meta.cwd,
          approval_policy: 'on-request',
          sandbox_policy: { type: 'read-only' },
          model,
          effort: 'medium'
        },
        row.ts
      )
      push(
        'response_item',
        {
          type: 'message',
          status: 'completed',
          id: `msg_${uuid()}`,
          role: 'user',
          content: [{ type: 'input_text', text: row.text, annotations: [] }]
        },
        row.ts
      )
      continue
    }
    // assistant：文本消息 + 工具调用各自成条
    if (row.text.trim() !== '') {
      push(
        'response_item',
        {
          type: 'message',
          status: 'completed',
          id: `msg_${uuid()}`,
          role: 'assistant',
          content: [{ type: 'output_text', text: row.text, annotations: [] }]
        },
        row.ts
      )
    }
    for (const tu of row.toolUses) {
      push(
        'response_item',
        {
          type: 'function_call',
          status: 'completed',
          id: `fc_${uuid()}`,
          name: tu.name,
          arguments: tu.args,
          call_id: tu.id
        },
        row.ts
      )
    }
  }

  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(rolloutPath, out.join('\n') + '\n', 'utf8')

  // 注册进 state_5.sqlite threads 表（codex resume 按 id 查这里，不扫文件）
  const nowMs = Date.now()
  const nowSec = Math.floor(nowMs / 1000)
  const firstMsg = truncateSummary(meta.firstUserText ?? '', SUMMARY_MAX_CHARS)
  const threadsRow: Record<string, unknown> = {
    id,
    rollout_path: rolloutPath,
    created_at: nowSec,
    updated_at: nowSec,
    source: meta.baseline.source,
    model_provider: meta.baseline.modelProvider,
    cwd: process.platform === 'win32' ? `\\\\?\\${meta.cwd}` : meta.cwd,
    title: meta.title,
    sandbox_policy: '{"type":"read-only"}',
    approval_mode: 'on-request',
    tokens_used: 0,
    has_user_event: 1,
    archived: 0,
    cli_version: meta.baseline.cliVersion,
    first_user_message: firstMsg,
    memory_mode: 'disabled',
    model,
    reasoning_effort: 'medium',
    created_at_ms: nowMs,
    updated_at_ms: nowMs,
    thread_source: meta.baseline.threadSource,
    preview: firstMsg,
    recency_at: nowSec,
    recency_at_ms: nowMs,
    history_mode: 'paginated',
    originator: meta.baseline.originator
  }
  let registered = 0
  try {
    registered = await registerThreadInDbs(threadsRow)
  } catch {
    registered = 0
  }
  if (registered === 0) {
    warnings.push('会话文件已生成，但 state_5.sqlite 暂时锁定未能注册，codex resume 可能找不到该会话（稍后可重试转换）')
  }

  // session_index.jsonl 追加 + 内存置顶（三处标题一致）
  try {
    const fh = await fsp.open(codexSessionIndexPath(), 'a+')
    try {
      const size = (await fh.stat()).size
      if (size > 0) {
        const buf = Buffer.alloc(1)
        const { bytesRead } = await fh.read(buf, 0, 1, size - 1)
        if (bytesRead === 1 && buf[0] !== 0x0a) await fh.write('\n')
      }
      await fh.write(JSON.stringify({ id, thread_name: meta.title, updated_at: now.toISOString() }) + '\n')
    } finally {
      await fh.close()
    }
  } catch {
    warnings.push('会话文件与数据库已就绪，但 session_index.jsonl 写入失败（不影响 resume）')
  }
  setRenameOverride(id, meta.title, false)

  return { id, resumeCommand: `codex resume ${id}`, registered }
}

// ─── 写入端：ConvRow[] → Claude JSONL ───────────────────────────────────────

const EMPTY_USAGE = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0
}

async function writeClaudeSession(
  rows: ConvRow[],
  meta: { cwd: string; title: string; firstUserText: string | null; version: string }
): Promise<string> {
  const sessionId = uuid()
  const dir = path.join(claudeProjectsDir(), escapeClaudeDir(meta.cwd))
  const file = path.join(dir, `${sessionId}.jsonl`)

  const lines: string[] = []
  let parent: string | null = null
  const base = {
    cwd: meta.cwd,
    sessionId,
    version: meta.version,
    gitBranch: 'HEAD',
    userType: 'external'
  }
  const tsOf = (t: number | null) => isoOrNull(t) ?? new Date().toISOString()

  for (const row of rows) {
    if (row.kind === 'user') {
      // 工具结果行先行（Claude 原生：tool_result 紧随对应 tool_use 的 assistant 行）
      if (row.toolResults.length > 0) {
        const u = uuid()
        lines.push(
          JSON.stringify({
            parentUuid: parent,
            isSidechain: false,
            type: 'user',
            message: {
              role: 'user',
              content: row.toolResults.map((tr) => ({
                tool_use_id: tr.id,
                type: 'tool_result',
                content: tr.text,
                is_error: tr.isError
              }))
            },
            uuid: u,
            timestamp: tsOf(row.ts),
            ...base
          })
        )
        parent = u
      }
      if (row.text.trim() !== '') {
        const u = uuid()
        lines.push(
          JSON.stringify({
            parentUuid: parent,
            isSidechain: false,
            type: 'user',
            message: { role: 'user', content: row.text },
            uuid: u,
            timestamp: tsOf(row.ts),
            ...base
          })
        )
        parent = u
      }
      continue
    }

    const blocks: Record<string, unknown>[] = []
    if (row.text.trim() !== '') blocks.push({ type: 'text', text: row.text })
    for (const tu of row.toolUses) {
      // args（JSON 字符串/裸文本）→ 对象；解析失败或非对象则包一层
      let input: unknown
      try {
        input = JSON.parse(tu.args)
      } catch {
        input = null
      }
      if (typeof input !== 'object' || input === null) input = { input: tu.args }
      blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input })
    }
    if (blocks.length === 0) continue
    const u = uuid()
    lines.push(
      JSON.stringify({
        parentUuid: parent,
        isSidechain: false,
        type: 'assistant',
        message: {
          id: `msg_${uuid().replace(/-/g, '')}`,
          type: 'message',
          role: 'assistant',
          model: row.model ?? 'claude',
          content: blocks,
          stop_reason: row.toolUses.length > 0 ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: EMPTY_USAGE
        },
        uuid: u,
        timestamp: tsOf(row.ts),
        ...base
      })
    )
    parent = u
  }

  // custom-title：Claude 界面直接显示来源标记
  lines.push(JSON.stringify({ type: 'custom-title', customTitle: meta.title, sessionId }))

  await fsp.mkdir(dir, { recursive: true })
  // 末尾必须换行，否则 resume 后首条新写入会拼坏最后一行
  await fsp.writeFile(file, lines.join('\n') + '\n', 'utf8')
  return sessionId
}

// ─── 入口 ───────────────────────────────────────────────────────────────────

function ensureToolPairs(rows: ConvRow[], warnings: string[]): ConvRow[] {
  const useIds = new Set<string>()
  for (const row of rows) {
    for (const use of row.toolUses) useIds.add(use.id)
  }

  const resultIds = new Set<string>()
  for (const row of rows) {
    for (const result of row.toolResults) resultIds.add(result.id)
  }

  let droppedOrphans = 0
  let synthesized = 0
  const out: ConvRow[] = []
  for (const row of rows) {
    if (row.kind === 'user' && row.toolResults.length > 0) {
      const paired = row.toolResults.filter((result) => useIds.has(result.id))
      droppedOrphans += row.toolResults.length - paired.length
      if (paired.length > 0 || row.text.trim() !== '') {
        out.push({ ...row, toolResults: paired })
      }
      continue
    }

    out.push(row)
    if (row.kind !== 'assistant' || row.toolUses.length === 0) continue
    const missing = row.toolUses
      .filter((use) => !resultIds.has(use.id))
      .map((use) => ({ id: use.id, text: '', isError: true }))
    if (missing.length > 0) {
      synthesized += missing.length
      out.push({ kind: 'user', ts: row.ts, text: '', toolUses: [], toolResults: missing })
    }
  }

  if (droppedOrphans > 0) warnings.push(`已丢弃 ${droppedOrphans} 条无法匹配工具调用的工具结果`)
  if (synthesized > 0) warnings.push(`已为 ${synthesized} 个缺少结果的工具调用补充空结果，保证目标 CLI 可恢复`)
  return out
}

function firstUserText(rows: ConvRow[]): string | null {
  for (const r of rows) {
    if (r.kind === 'user' && r.text.trim() !== '') return r.text
  }
  return null
}

function buildTitle(rawTitle: string, sourceLabel: 'Claude' | 'Codex'): string {
  const base = validateTitle(rawTitle) ?? '未命名会话'
  const t = validateTitle(`${base} ⟲自${sourceLabel}`)
  // 512 字节超限时退回短版
  return t ?? validateTitle(`${truncateSummary(base, 40)} ⟲自${sourceLabel}`) ?? `会话副本 ⟲自${sourceLabel}`
}

export async function convertSession(
  providerId: ProviderId,
  sourcePath: string,
  rawTitle: string
): Promise<ConvertResult> {
  const warnings: string[] = []
  try {
    if (providerId === 'claude') {
      const src = await readClaudeSource(sourcePath)
      if (src.cwd === null) return { ok: false, error: '源会话缺少 cwd 信息，无法定位项目目录', warnings }
      const rows = ensureToolPairs(src.rows, warnings)
      const title = buildTitle(rawTitle, 'Claude')
      if (src.droppedThinking > 0) {
        warnings.push(`已丢弃 ${src.droppedThinking} 条思考记录（跨 CLI 不可移植，不影响对话内容）`)
      }
      const baseline = await recentCodexBaseline()
      const { id, resumeCommand } = await writeCodexSession(
        rows,
        { cwd: src.cwd, title, firstUserText: firstUserText(rows), model: src.model, createdAt: src.createdAt, baseline },
        warnings
      )
      return { ok: true, resumeCommand, newSessionId: id, targetProvider: 'codex', warnings }
    }

    const src = await readCodexSource(sourcePath)
    if (src.cwd === null) return { ok: false, error: '源会话缺少 cwd 信息，无法定位项目目录', warnings }
    const rows = ensureToolPairs(src.rows, warnings)
    if (src.truncated) {
      warnings.push('源会话文件超出解压上限，副本可能不含全部历史')
    }
    const title = buildTitle(rawTitle, 'Codex')
    if (src.droppedThinking > 0) {
      warnings.push(`已丢弃 ${src.droppedThinking} 条加密思考记录（不可移植，不影响对话内容）`)
    }
    const newId = await writeClaudeSession(rows, {
      cwd: src.cwd,
      title,
      firstUserText: firstUserText(rows),
      version: await recentClaudeVersion()
    })
    return {
      ok: true,
      resumeCommand: `claude --resume ${newId}`,
      newSessionId: newId,
      targetProvider: 'claude',
      warnings
    }
  } catch (err) {
    return { ok: false, error: `转换失败：${String((err as Error).message ?? err)}`, warnings }
  }
}
