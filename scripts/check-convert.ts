/**
 * 真机跨 CLI 转换验证：
 *   Codex → Claude：选一个含工具调用的 Codex 会话转换，核对生成的 JSONL
 *                   （parentUuid 链、tool_use/tool_result 配对、尾换行、custom-title）
 *   Claude → Codex：选一个含工具调用的 Claude 会话转换，核对生成的 rollout
 *                   （session_meta、ordinal 连续、call_id 配对、threads 表注册行）
 * 转换生成的是全新副本，本脚本不删除产物（可在界面里手动清理）。
 * 用法：pnpm check:convert
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionMeta } from '@shared/types'
import { claudeProjectsDir, codexConfigDir } from '../src/main/paths'
import { stateDbPaths } from '../src/main/providers/codex-titles'
import { scanClaudeSessions } from '../src/main/providers/claude'
import { scanCodexSessions } from '../src/main/providers/codex'
import { convertSession } from '../src/main/services/convert'

async function main() {
  // ── Codex → Claude ──
  console.log('========== Codex → Claude ==========')
  const codexList = await scanCodexSessions()
  // 优先挑带工具调用痕迹（文件较大）且最近的会话
  const codexTarget =
    codexList.find((s) => s.summary !== null && s.summary.length > 50) ?? codexList[0] ?? null
  if (!codexTarget) {
    console.log('没有 Codex 会话，跳过')
  } else {
    await checkCodexToClaude(codexTarget)
  }

  // ── Claude → Codex ──
  console.log('\n========== Claude → Codex ==========')
  const claudeList = await scanClaudeSessions(new Set())
  const claudeTarget = claudeList.find((s) => !s.title?.includes('⟲自')) ?? claudeList[0] ?? null
  if (!claudeTarget) {
    console.log('没有 Claude 会话，跳过')
  } else {
    await checkClaudeToCodex(claudeTarget)
  }

  console.log('\n全部验证通过（产物副本保留，可在界面删除）')
}

async function checkCodexToClaude(s: SessionMeta): Promise<void> {
  console.log(`源会话：${s.sessionId}`)
  console.log(`  标题：${JSON.stringify(s.title)}`)
  console.log(`  文件：${s.sourcePath}`)
  const sourceBefore = await fsp.stat(s.sourcePath)
  const r = await convertSession('codex', s.sourcePath, s.title ?? '')
  console.log(`[1] convertSession → ok=${r.ok} warnings=${JSON.stringify(r.warnings)}`)
  if (!r.ok || !r.newSessionId || !r.resumeCommand) {
    console.log(`  ✗ 失败：${r.error}`)
    process.exit(1)
  }
  console.log(`  命令：${r.resumeCommand}`)

  // 核对生成的 JSONL（在转义 cwd 对应的项目子目录下）
  const escaped = (s.projectDir ?? '').replace(/[^a-zA-Z0-9]/g, '-')
  const file = path.join(claudeProjectsDir(), escaped, `${r.newSessionId}.jsonl`)
  const text = await fsp.readFile(file, 'utf8')
  const lines = text.split('\n').filter((l) => l.length > 0)
  console.log(`[2] 副本文件：${file}（${lines.length} 行）`)

  let prevUuid: string | null = null
  let users = 0
  let assistants = 0
  let toolUses = 0
  let toolResults = 0
  const useIds = new Set<string>()
  const resultIds = new Set<string>()
  let chainOk = true
  let customTitle = false
  for (const line of lines) {
    const v = JSON.parse(line) as Record<string, unknown>
    if (v.type === 'custom-title') {
      customTitle = true
      continue
    }
    if (v.type !== 'user' && v.type !== 'assistant') continue
    if (v.parentUuid !== prevUuid) chainOk = false
    prevUuid = typeof v.uuid === 'string' ? v.uuid : null
    if (v.type === 'user') {
      const content = (v.message as { content?: unknown }).content
      if (Array.isArray(content)) {
        for (const b of content as { type?: string; tool_use_id?: string }[]) {
          if (b.type === 'tool_result' && b.tool_use_id) {
            toolResults++
            resultIds.add(b.tool_use_id)
          }
        }
        users++
      } else {
        users++
      }
    } else {
      const msg = v.message as { content?: unknown; id?: unknown; stop_reason?: unknown }
      if (typeof msg.id !== 'string' || !msg.id.startsWith('msg_')) {
        console.log('  ✗ assistant 行缺少 msg_ 前缀的 message.id')
        process.exit(1)
      }
      if (typeof msg.stop_reason !== 'string') {
        console.log('  ✗ assistant 行缺少 stop_reason')
        process.exit(1)
      }
      for (const b of (msg.content as { type?: string; id?: string }[] | undefined) ?? []) {
        if (b.type === 'tool_use' && b.id) {
          toolUses++
          useIds.add(b.id)
        }
      }
      assistants++
    }
  }
  const orphans = [...resultIds].filter((id) => !useIds.has(id))
  const missingResults = [...useIds].filter((id) => !resultIds.has(id))
  const endsWithNewline = text.endsWith('\n')
  console.log(
    `[3] 结构：user=${users} assistant=${assistants} tool_use=${toolUses} tool_result=${toolResults} 链完整=${chainOk} 尾换行=${endsWithNewline} custom-title=${customTitle}`
  )
  if (!chainOk) {
    console.log('  ✗ parentUuid 链断裂')
    process.exit(1)
  }
  if (!endsWithNewline) {
    console.log('  ✗ 文件末尾缺换行')
    process.exit(1)
  }
  if (!customTitle) {
    console.log('  ✗ 缺 custom-title 行')
    process.exit(1)
  }
  if (orphans.length > 0 || missingResults.length > 0) {
    console.log(`  ✗ 工具调用配对不完整：孤立结果=${orphans.length}，缺少结果=${missingResults.length}`)
    process.exit(1)
  }
  const sourceAfter = await fsp.stat(s.sourcePath)
  if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) {
    console.log('  ✗ 源 Codex 文件在转换前后发生变化')
    process.exit(1)
  }
  const repeat = await convertSession('codex', s.sourcePath, s.title ?? '')
  if (!repeat.ok || repeat.newSessionId === r.newSessionId) {
    console.log('  ✗ 重复转换没有生成新的 sessionId')
    process.exit(1)
  }
  console.log('  ✓ 结构校验通过')
  console.log(`  手动验收：${r.resumeCommand}`)
}

async function checkClaudeToCodex(s: SessionMeta): Promise<void> {
  console.log(`源会话：${s.sessionId}`)
  console.log(`  标题：${JSON.stringify(s.title)}`)
  console.log(`  文件：${s.sourcePath}`)
  const sourceBefore = await fsp.stat(s.sourcePath)
  const r = await convertSession('claude', s.sourcePath, s.title ?? '')
  console.log(`[1] convertSession → ok=${r.ok} warnings=${JSON.stringify(r.warnings)}`)
  if (!r.ok || !r.newSessionId || !r.resumeCommand) {
    console.log(`  ✗ 失败：${r.error}`)
    process.exit(1)
  }
  console.log(`  命令：${r.resumeCommand}`)

  // 核对生成的 rollout
  const file = await findRollout(r.newSessionId)
  if (!file) {
    console.log('  ✗ 找不到生成的 rollout 文件')
    process.exit(1)
  }
  const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter((l) => l.length > 0)
  console.log(`[2] 副本文件：${file}（${lines.length} 行）`)

  let metaOk = false
  let ordinalOk = true
  let users = 0
  let assistants = 0
  let calls = 0
  let outputs = 0
  const callIds = new Set<string>()
  const outputIds = new Set<string>()
  lines.forEach((line, i) => {
    const v = JSON.parse(line) as Record<string, unknown>
    if (v.ordinal !== i) ordinalOk = false
    if (v.type === 'session_meta') {
      const payload = v.payload as { id?: unknown; cwd?: unknown } | undefined
      metaOk = payload?.id === r.newSessionId && typeof payload?.cwd === 'string'
      return
    }
    if (v.type !== 'response_item') return
    const payload = v.payload as { type?: string; role?: string; call_id?: string } | undefined
    if (payload?.type === 'message') {
      if (payload.role === 'user') users++
      else if (payload.role === 'assistant') assistants++
    } else if (payload?.type === 'function_call' && payload.call_id) {
      calls++
      callIds.add(payload.call_id)
    } else if (payload?.type === 'function_call_output' && payload.call_id) {
      outputs++
      outputIds.add(payload.call_id)
    }
  })
  const orphans = [...outputIds].filter((id) => !callIds.has(id))
  const missingOutputs = [...callIds].filter((id) => !outputIds.has(id))
  console.log(
    `[3] 结构：session_meta=${metaOk} ordinal连续=${ordinalOk} user=${users} assistant=${assistants} call=${calls} output=${outputs}`
  )
  if (!metaOk || !ordinalOk || orphans.length > 0 || missingOutputs.length > 0) {
    console.log(`  ✗ 结构校验失败（孤立 output=${orphans.length}，缺少 output=${missingOutputs.length}）`)
    process.exit(1)
  }

  // 核对 threads 注册
  let registered = false
  for (const dbPath of await stateDbPaths()) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = db.prepare('SELECT id, title, rollout_path FROM threads WHERE id = ?').get(r.newSessionId) as
          | { id?: string; title?: string; rollout_path?: string }
          | undefined
        if (row) {
          console.log(`[4] threads 注册：${dbPath} title=${JSON.stringify(row.title)}`)
          if (!row.rollout_path || row.rollout_path !== file || !row.title?.includes('⟲自Claude')) {
            console.log('  ✗ threads 表注册内容不完整或 rollout_path 不匹配')
            process.exit(1)
          }
          registered = true
        }
      } finally {
        db.close()
      }
    } catch {
      // 某个候选库不存在或被锁，继续检查其它库
    }
  }
  if (!registered) {
    console.log('  ✗ 所有 state_5.sqlite 都缺少注册行')
    process.exit(1)
  }
  const sourceAfter = await fsp.stat(s.sourcePath)
  if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) {
    console.log('  ✗ 源 Claude 文件在转换前后发生变化')
    process.exit(1)
  }
  const repeat = await convertSession('claude', s.sourcePath, s.title ?? '')
  if (!repeat.ok || repeat.newSessionId === r.newSessionId) {
    console.log('  ✗ 重复转换没有生成新的 sessionId')
    process.exit(1)
  }
  console.log('  ✓ 结构校验通过')
  console.log(`  手动验收：${r.resumeCommand}`)
}

async function findRollout(sessionId: string): Promise<string | null> {
  const today = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const dir = path.join(
    codexConfigDir(), 'sessions',
    String(today.getFullYear()), p2(today.getMonth() + 1), p2(today.getDate())
  )
  try {
    for (const f of await fsp.readdir(dir)) {
      if (f.endsWith(`-${sessionId}.jsonl`)) return path.join(dir, f)
    }
  } catch {
    // 目录不存在
  }
  return null
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
