import fsp from 'node:fs/promises'

interface Entry {
  mtimeMs: number
  size: number
  meta: unknown | null
}

const cache = new Map<string, Entry>()

/**
 * 按 (mtime, size) 缓存文件解析结果（翻译自 cc-switch FileParseCache）。
 * parse 抛错（占用/权限）不缓存、下轮重试；返回 null（非会话）可缓存。
 */
export async function cachedParse<T>(p: string, parse: () => Promise<T | null>): Promise<T | null> {
  const st = await fsp.stat(p)
  const prev = cache.get(p)
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
    return prev.meta as T | null
  }
  const meta = await parse()
  cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, meta })
  return meta
}

/** 重命名等写操作后，把新结果写入缓存（避免下一轮重复解析） */
export async function updateCache(p: string, meta: unknown | null): Promise<void> {
  try {
    const st = await fsp.stat(p)
    cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, meta })
  } catch {
    cache.delete(p)
  }
}

export function forgetCache(p: string): void {
  cache.delete(p)
}
