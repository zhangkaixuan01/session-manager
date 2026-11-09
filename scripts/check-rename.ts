/**
 * 真机重命名验证：选最旧会话 改名 → 重扫核对 → 改回原标题 → 再核对。
 * 用法：pnpm check:rename            （默认验证两个 provider 各一个会话）
 *       pnpm check:rename claude     （只验 Claude）
 */
import fsp from 'node:fs/promises'
import type { ProviderId, SessionMeta } from '@shared/types'
import { claudeProjectsDir, codexSessionIndexPath } from '../src/main/paths'
import { scanClaudeSessions, forgetClaudeCache } from '../src/main/providers/claude'
import { scanCodexSessions } from '../src/main/providers/codex'
import { renameSession } from '../src/main/services/rename'

async function pickOldest(providerId: ProviderId): Promise<SessionMeta | null> {
  const list = providerId === 'claude' ? await scanClaudeSessions(new Set()) : await scanCodexSessions()
  if (list.length === 0) return null
  return list[list.length - 1]
}

async function verify(providerId: ProviderId, sessionId: string): Promise<SessionMeta | undefined> {
  const list = providerId === 'claude' ? await scanClaudeSessions(new Set()) : await scanCodexSessions()
  return list.find((s) => s.sessionId === sessionId)
}

async function tailLines(p: string, n: number): Promise<string[]> {
  const text = await fsp.readFile(p, 'utf8')
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  return lines.slice(-n)
}

async function checkProvider(providerId: ProviderId): Promise<void> {
  console.log(`\n========== ${providerId} ==========`)
  const target = await pickOldest(providerId)
  if (!target) {
    console.log('没有会话，跳过')
    return
  }
  const originalTitle = target.title ?? ''
  console.log(`目标会话：${target.sessionId}`)
  console.log(`  原标题：${JSON.stringify(originalTitle)}（source=${target.titleSource}）`)
  console.log(`  文件：${target.sourcePath}`)

  // ── 改名 ──
  const tempTitle = `SM验证-${Date.now().toString(36)}`
  console.log(`\n[1] 改名为：${tempTitle}`)
  const r1 = await renameSession(providerId, target.sessionId, target.sourcePath, tempTitle)
  console.log(`  renameSession → ${JSON.stringify(r1)}`)
  if (!r1.ok) process.exit(1)

  if (providerId === 'claude') forgetClaudeCache(target.sourcePath)

  // 写入痕迹核对
  if (providerId === 'claude') {
    console.log(`  JSONL 末行：${(await tailLines(target.sourcePath, 1))[0]?.slice(0, 200)}`)
  } else {
    console.log(`  session_index 末行：${(await tailLines(codexSessionIndexPath(), 1))[0]?.slice(0, 200)}`)
  }

  // ── 重扫核对 ──
  const after = await verify(providerId, target.sessionId)
  console.log(`[2] 重扫：title=${JSON.stringify(after?.title)} source=${after?.titleSource}`)
  if (after?.title !== tempTitle || after.titleSource !== 'custom') {
    console.log('  ✗ 验证失败：标题未生效或来源不对')
    process.exit(1)
  }
  console.log('  ✓ 改名生效')

  // ── 改回 ──
  console.log(`[3] 改回原标题：${JSON.stringify(originalTitle)}`)
  const r2 = await renameSession(providerId, target.sessionId, target.sourcePath, originalTitle || '未命名会话')
  console.log(`  renameSession → ok=${r2.ok} warnings=${r2.warnings.length}`)
  if (providerId === 'claude') forgetClaudeCache(target.sourcePath)

  const restored = await verify(providerId, target.sessionId)
  console.log(`[4] 重扫：title=${JSON.stringify(restored?.title)}`)
  if (restored?.title !== (originalTitle || '未命名会话')) {
    console.log('  ✗ 恢复失败')
    process.exit(1)
  }
  console.log('  ✓ 已恢复原标题')
}

async function main() {
  const which = process.argv[2] as ProviderId | undefined
  console.log(`Claude 项目目录：${claudeProjectsDir()}`)
  console.log(`Codex 索引文件：${codexSessionIndexPath()}`)
  if (which === 'claude' || which === undefined) await checkProvider('claude')
  if (which === 'codex' || which === undefined) await checkProvider('codex')
  console.log('\n全部验证通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
