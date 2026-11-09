import fsp from 'node:fs/promises'
import path from 'node:path'
import { claudeRuntimeSessionsDir } from './paths'

interface LiveRecord {
  pid?: unknown
  sessionId?: unknown
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 运行中的 Claude 会话（~/.claude/sessions/<pid>.json 按 PID 注册表；崩溃残留文件按 PID 存活过滤） */
export async function runningClaudeSessionIds(): Promise<Set<string>> {
  const running = new Set<string>()
  const dir = claudeRuntimeSessionsDir()
  let entries
  try {
    entries = await fsp.readdir(dir)
  } catch {
    return running
  }
  await Promise.all(
    entries
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const text = await fsp.readFile(path.join(dir, name), 'utf8')
          const v = JSON.parse(text) as LiveRecord
          if (typeof v.sessionId !== 'string' || !v.sessionId) return
          const pid = typeof v.pid === 'number' ? v.pid : NaN
          if (Number.isInteger(pid) && !isPidAlive(pid)) return
          running.add(v.sessionId)
        } catch {
          // 坏文件跳过
        }
      })
  )
  return running
}
