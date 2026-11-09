export const TITLE_MAX_CHARS = 80
export const SUMMARY_MAX_CHARS = 160

/** 兼容毫秒/秒级数字与 RFC3339 字符串的时间戳解析，失败返回 null */
export function parseTimestampToMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v > 1e12) return v // 毫秒
    if (v > 1e9) return v * 1000 // 秒
    return null
  }
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

export function truncateSummary(s: string, max: number): string {
  const t = s.trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + '…'
}

/** 兼容 Windows / POSIX 分隔符的 basename */
export function pathBasename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}
