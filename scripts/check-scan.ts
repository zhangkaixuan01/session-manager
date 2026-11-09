/**
 * 只读扫描验证：核对两 provider 的会话数量、标题来源分布与样例。
 * 用法：pnpm check:scan
 */
import type { SessionMeta } from '@shared/types'
import { scanClaudeSessions } from '../src/main/providers/claude'
import { scanCodexSessions } from '../src/main/providers/codex'
import { runningClaudeSessionIds } from '../src/main/live'

function fmt(ms: number | null): string {
  if (ms === null) return '—'
  const d = new Date(ms)
  const p = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function main() {
  const running = await runningClaudeSessionIds()
  console.log(`[live] 运行中的 Claude 会话：${running.size} 个`)

  const t0 = Date.now()
  const claude = await scanClaudeSessions(running)
  const t1 = Date.now()
  const codex = await scanCodexSessions()
  const t2 = Date.now()

  report('Claude Code', claude, t1 - t0)
  report('Codex', codex, t2 - t1)

  const zst = codex.filter((s) => s.sourcePath.endsWith('.zst')).length
  console.log(`  .jsonl.zst 压缩文件：${zst} 个`)
}

function report(name: string, sessions: SessionMeta[], ms: number) {
  console.log(`\n=== ${name}：${sessions.length} 个会话（扫描耗时 ${ms}ms） ===`)
  const bySource = new Map<string, number>()
  for (const s of sessions) bySource.set(s.titleSource, (bySource.get(s.titleSource) ?? 0) + 1)
  console.log(`  标题来源：${[...bySource.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
  const archived = sessions.filter((s) => s.archived).length
  const runningN = sessions.filter((s) => s.running).length
  if (archived) console.log(`  已归档：${archived}`)
  if (runningN) console.log(`  运行中：${runningN}`)
  console.log('  最新 5 条：')
  for (const s of sessions.slice(0, 5)) {
    console.log(
      `    [${s.titleSource.padEnd(13)}] ${fmt(s.lastActiveAt ?? s.createdAt)}  ${(s.title ?? '(无标题)').slice(0, 50)}`
    )
    console.log(`      ${s.projectDir ?? '—'}  ${s.sessionId}`)
  }
  const oldest = sessions[sessions.length - 1]
  if (oldest) {
    console.log('  最旧 1 条（check-rename 候选）：')
    console.log(`    ${oldest.sessionId}  ${(oldest.title ?? '').slice(0, 40)}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
