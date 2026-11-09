import os from 'node:os'
import path from 'node:path'

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

export function claudeProjectsDir(): string {
  return path.join(claudeConfigDir(), 'projects')
}

/** Claude Code 运行时进程注册表目录（按 PID 命名的 json） */
export function claudeRuntimeSessionsDir(): string {
  return path.join(claudeConfigDir(), 'sessions')
}

export function codexConfigDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

export function codexSessionRoots(): string[] {
  const home = codexConfigDir()
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')]
}

export function codexSessionIndexPath(): string {
  return path.join(codexConfigDir(), 'session_index.jsonl')
}
