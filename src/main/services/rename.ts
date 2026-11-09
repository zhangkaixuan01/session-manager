import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ProviderId, RenameResult } from '@shared/types'
import { TITLE_MAX_CHARS, truncateSummary } from '../infra/time'
import { forgetCache } from '../infra/parse-cache'
import { forgetClaudeCache } from '../providers/claude'
import {
  codexSessionIndexPath,
  codexSessionRoots,
  claudeProjectsDir
} from '../paths'
import {
  setRenameOverride,
  updateThreadTitleInDbs
} from '../providers/codex-titles'

const MAX_TITLE_BYTES = 512

export function validateTitle(raw: string): string | null {
  const t = raw.replace(/[\r\n\t]+/g, ' ').trim()
  if (t === '') return null
  if (Buffer.byteLength(t, 'utf8') > MAX_TITLE_BYTES) return null
  return t
}

/** 确保文件末尾有换行，再追加一行（并发追加安全：O_APPEND 单次 write） */
async function appendLine(p: string, line: string): Promise<void> {
  const fh = await fsp.open(p, 'a+')
  try {
    const size = (await fh.stat()).size
    if (size > 0) {
      const buf = Buffer.alloc(1)
      const { bytesRead } = await fh.read(buf, 0, 1, size - 1)
      if (bytesRead === 1 && buf[0] !== 0x0a) await fh.write('\n')
    }
    await fh.write(line + '\n')
  } finally {
    await fh.close()
  }
}

// ─── Claude：向会话 JSONL 追加 custom-title 行（官方 /rename 同款机制） ─────

async function renameClaude(sessionId: string, sourcePath: string, title: string): Promise<RenameResult> {
  const warnings: string[] = []
  const line = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })
  try {
    await appendLine(sourcePath, line)
  } catch (err) {
    return { ok: false, error: `写入会话文件失败：${String((err as Error).message ?? err)}`, warnings }
  }
  forgetClaudeCache(sourcePath)
  return { ok: true, warnings }
}

// ─── Codex：session_index.jsonl + state_5.sqlite 双写 ──────────────────────

async function renameCodex(sessionId: string, title: string): Promise<RenameResult> {
  const warnings: string[] = []
  let dbUpdated = false

  // ① session_index.jsonl 追加（主存储）
  const indexPath = codexSessionIndexPath()
  try {
    await appendLine(
      indexPath,
      JSON.stringify({ id: sessionId, thread_name: title, updated_at: new Date().toISOString() })
    )
  } catch (err) {
    return { ok: false, error: `写入 session_index.jsonl 失败：${String((err as Error).message ?? err)}`, warnings }
  }

  // ② state_5.sqlite UPDATE（锁库容错；失败进内存改名表 + pending 重试）
  try {
    dbUpdated = await updateThreadTitleInDbs(sessionId, title)
  } catch {
    dbUpdated = false
  }
  setRenameOverride(sessionId, title, !dbUpdated)
  if (!dbUpdated) {
    warnings.push('会话索引已更新；state_5.sqlite 暂时锁定未能写入，将在下次刷新时自动重试')
  }
  return { ok: true, warnings, dbUpdated }
}

export async function renameSession(
  providerId: ProviderId,
  sessionId: string,
  sourcePath: string,
  newTitle: string
): Promise<RenameResult> {
  const title = validateTitle(newTitle)
  if (title === null) {
    return { ok: false, error: '标题不能为空，且不超过 500 字节、不含换行', warnings: [] }
  }
  const trimmed = truncateSummary(title, TITLE_MAX_CHARS)
  let result: RenameResult
  if (providerId === 'claude') {
    result = await renameClaude(sessionId, sourcePath, trimmed)
  } else {
    result = await renameCodex(sessionId, trimmed)
    // Codex 改名不改 rollout 文件（只写 index/db），(mtime,size) 缓存不会自然失效，需显式清除
    if (result.ok) forgetCache(sourcePath)
  }
  return result
}

// ─── 路径安全白名单（IPC 层调用） ───────────────────────────────────────────

export function isPathAllowed(providerId: ProviderId, p: string): boolean {
  const normalized = path.resolve(p)
  if (providerId === 'claude') {
    return isUnderRoot(normalized, claudeProjectsDir())
  }
  return codexSessionRoots().some((root) => isUnderRoot(normalized, root))
}

function isUnderRoot(p: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), p)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
