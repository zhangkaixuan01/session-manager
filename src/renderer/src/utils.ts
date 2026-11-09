import type { SessionMeta, TitleSource } from '@shared/types'

/** 今天 HH:mm / 昨天 HH:mm / 今年 M月d日 / 往年 yyyy-M-d */
export function formatTime(ms: number | null): string {
  if (ms === null) return '—'
  const d = new Date(ms)
  const now = new Date()
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ms >= todayStart) return `今天 ${hhmm}`
  if (ms >= todayStart - 86400000) return `昨天 ${hhmm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function baseName(dir: string): string {
  const t = dir.replace(/[\\/]+$/, '')
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'))
  return i === -1 ? t : t.slice(i + 1)
}

/** 标题来源徽标：custom=已命名 / auto=AI 摘要 / dir=目录名兜底（深浅双色） */
export function sourceBadge(s: TitleSource): { label: string; cls: string } | null {
  switch (s) {
    case 'custom':
      return { label: '已命名', cls: 'bg-sky-500/15 text-sky-700 border-sky-500/30 dark:text-sky-300' }
    case 'auto':
      return { label: 'AI', cls: 'bg-violet-500/15 text-violet-700 border-violet-500/30 dark:text-violet-300' }
    case 'dir':
      return { label: '目录名', cls: 'bg-zinc-500/15 text-zinc-500 border-zinc-500/30 dark:text-zinc-400' }
    default:
      return null
  }
}

export interface ProjectGroup {
  dir: string
  label: string
  count: number
  lastActive: number | null
}

export function groupByProject(sessions: SessionMeta[]): ProjectGroup[] {
  const map = new Map<string, ProjectGroup>()
  for (const s of sessions) {
    const dir = s.projectDir ?? ''
    let g = map.get(dir)
    if (!g) {
      g = { dir, label: dir === '' ? '未知项目' : baseName(dir), count: 0, lastActive: null }
      map.set(dir, g)
    }
    g.count++
    const t = s.lastActiveAt ?? s.createdAt
    if (t !== null && (g.lastActive === null || t > g.lastActive)) g.lastActive = t
  }
  return [...map.values()].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
}

/** 只按标题搜索 */
export function filterSessions(sessions: SessionMeta[], keyword: string): SessionMeta[] {
  const q = keyword.trim().toLowerCase()
  if (q === '') return sessions
  return sessions.filter((s) => s.title?.toLowerCase().includes(q) ?? false)
}
