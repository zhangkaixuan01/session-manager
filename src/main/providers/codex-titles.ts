import fsp from 'node:fs/promises'
import path from 'node:path'
import { codexConfigDir, codexSessionIndexPath } from '../paths'

/**
 * Codex 会话标题合并：
 *   session_index.jsonl（同 id 取 updated_at 最新）→ state_5.sqlite threads.title 覆盖
 *   → 本工具运行期内的内存改名表最后覆盖（保证 DB 更新失败时也立即显示新名）。
 */

export interface ThreadTitle {
  title: string
  /** DB 更新失败待补写 */
  pendingDbUpdate: boolean
}

/** 运行期内改名表：sessionId → 新标题 */
const renameOverrides = new Map<string, ThreadTitle>()

// ─── state DB（node:sqlite，运行时探测，不可用则降级） ─────────────────────

let databaseSyncCtor: unknown | null | undefined

async function loadDatabaseSync(): Promise<unknown | null> {
  if (databaseSyncCtor !== undefined) return databaseSyncCtor
  try {
    const mod = (await import('node:sqlite')) as { DatabaseSync?: unknown }
    databaseSyncCtor = mod.DatabaseSync ?? null
  } catch {
    databaseSyncCtor = null
  }
  return databaseSyncCtor
}

export async function sqliteAvailable(): Promise<boolean> {
  return (await loadDatabaseSync()) !== null
}

/** state_5.sqlite 候选路径：配置目录 + sqlite/ 子目录 + config.toml/env 覆盖 */
export async function stateDbPaths(): Promise<string[]> {
  const dir = codexConfigDir()
  const list = [path.join(dir, 'state_5.sqlite'), path.join(dir, 'sqlite', 'state_5.sqlite')]
  try {
    const toml = await fsp.readFile(path.join(dir, 'config.toml'), 'utf8')
    const m = toml.match(/^\s*sqlite_home\s*=\s*['"](.+?)['"]\s*$/m)
    if (m) list.push(path.join(m[1], 'state_5.sqlite'))
  } catch {
    // 无 config.toml
  }
  const envHome = process.env.CODEX_SQLITE_HOME?.trim()
  if (envHome) list.push(path.join(envHome, 'state_5.sqlite'))
  return [...new Set(list)]
}

interface DbTitleRow {
  id: string
  title: string
  updatedAt: number | null
}

/** 只读查询 threads 表的有效标题（镜像 Codex distinct_thread_metadata_title 过滤，避免 SELECT 大字段） */
async function readTitlesFromDb(
  DatabaseSync: unknown,
  dbPath: string,
  timeoutMs = 2000
): Promise<DbTitleRow[]> {
  type Db = {
    prepare: (sql: string) => { all: () => unknown[] }
    exec: (sql: string) => void
    close: () => void
  }
  let db: Db | null = null
  try {
    db = new (DatabaseSync as new (p: string, o?: object) => Db)(dbPath, {
      readOnly: true,
      timeout: timeoutMs
    })
    db.exec('PRAGMA busy_timeout = 2000')
    const rows = db
      .prepare(
        `SELECT id, title, updated_at FROM threads
         WHERE title <> ''
           AND (first_user_message IS NULL OR TRIM(title) <> TRIM(first_user_message))`
      )
      .all() as { id?: unknown; title?: unknown; updated_at?: unknown }[]
    return rows
      .filter((r) => typeof r.id === 'string' && typeof r.title === 'string' && r.title.trim() !== '')
      .map((r) => {
        const ts = typeof r.updated_at === 'string' ? Date.parse(r.updated_at) : Number(r.updated_at)
        return {
          id: r.id as string,
          title: (r.title as string).trim(),
          updatedAt: Number.isFinite(ts) ? ts : null
        }
      })
  } finally {
    try {
      db?.close()
    } catch {
      // 忽略关闭错误
    }
  }
}

/** 合并读取全部标题源；失败源静默跳过（Codex 运行中锁库等） */
export async function loadThreadTitles(): Promise<Map<string, string>> {
  const titles = new Map<string, string>()

  // 1) session_index.jsonl（同 id 取 updated_at 最新，文件顺序为 tie-break）
  try {
    const text = await fsp.readFile(codexSessionIndexPath(), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue
      try {
        const v = JSON.parse(line) as {
          id?: unknown
          thread_name?: unknown
          updated_at?: unknown
        }
        if (typeof v.id !== 'string' || !v.id) continue
        const name = typeof v.thread_name === 'string' ? v.thread_name.trim() : ''
        if (!name) continue
        const ts = typeof v.updated_at === 'string' ? Date.parse(v.updated_at) : NaN
        const updatedAt = Number.isNaN(ts) ? null : ts
        const prevTs = titleTs.get(v.id)
        if (prevTs === undefined || (updatedAt ?? -Infinity) >= prevTs) {
          titles.set(v.id, name)
          titleTs.set(v.id, updatedAt ?? -Infinity)
        }
      } catch {
        // 坏行跳过
      }
    }
  } catch {
    // 无索引文件
  }

  // 2) state DB（优先级更高，按 updated_at 新者优先合并多库）
  const DatabaseSync = await loadDatabaseSync()
  if (DatabaseSync) {
    for (const dbPath of await stateDbPaths()) {
      try {
        await fsp.access(dbPath)
      } catch {
        continue
      }
      try {
        const rows = await readTitlesFromDb(DatabaseSync, dbPath)
        for (const row of rows) {
          const prevTs = titleTs.get(row.id)
          if (prevTs === undefined || (row.updatedAt ?? -Infinity) >= prevTs) {
            titles.set(row.id, row.title)
            titleTs.set(row.id, row.updatedAt ?? -Infinity)
          }
        }
      } catch {
        // 打不开（锁忙/WAL 无 -shm）：跳过该库
      }
    }
  }

  // 3) 内存改名表置顶
  for (const [id, override] of renameOverrides) {
    titles.set(id, override.title)
  }
  return titles
}

// updated_at 记录表（模块级，避免每次合并重复解析）
const titleTs = new Map<string, number>()

/** UPDATE threads SET title WHERE id；返回是否至少一个库更新成功 */
export async function updateThreadTitleInDbs(sessionId: string, title: string): Promise<boolean> {
  const DatabaseSync = await loadDatabaseSync()
  if (!DatabaseSync) return false
  type Db = {
    prepare: (sql: string) => { run: (...args: unknown[]) => { changes: number } }
    close: () => void
  }
  let anyUpdated = false
  for (const dbPath of await stateDbPaths()) {
    let db: Db | null = null
    try {
      db = new (DatabaseSync as new (p: string, o?: object) => Db)(dbPath, { timeout: 2000 })
      const info = db
        .prepare('UPDATE threads SET title = ? WHERE id = ?')
        .run(title, sessionId)
      if (info.changes > 0) anyUpdated = true
    } catch {
      // 锁库/无该行：跳过
    } finally {
      try {
        db?.close()
      } catch {
        // 忽略
      }
    }
  }
  return anyUpdated
}

/**
 * 转换注册：INSERT OR REPLACE threads 新行（codex resume 按 id 查此表定位 rollout）。
 * 只写各库实际存在的列（不同版本库列集不同）；返回注册成功的库数。
 */
export async function registerThreadInDbs(row: Record<string, unknown>): Promise<number> {
  const DatabaseSync = await loadDatabaseSync()
  if (!DatabaseSync) return 0
  type Db = {
    prepare: (sql: string) => { all: () => unknown[]; run: (...args: unknown[]) => { changes: number } }
    exec: (sql: string) => void
    close: () => void
  }
  let registered = 0
  for (const dbPath of await stateDbPaths()) {
    let db: Db | null = null
    try {
      await fsp.access(dbPath)
      db = new (DatabaseSync as new (p: string, o?: object) => Db)(dbPath, { timeout: 2000 })
      db.exec('PRAGMA busy_timeout = 2000')
      const cols = (db.prepare('PRAGMA table_info(threads)').all() as { name?: unknown }[])
        .map((c) => (typeof c.name === 'string' ? c.name : ''))
        .filter((name) => name !== '' && name in row)
      if (cols.length === 0) continue
      const placeholders = cols.map(() => '?').join(', ')
      db.prepare(
        `INSERT OR REPLACE INTO threads (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`
      ).run(...cols.map((c) => row[c]))
      registered++
    } catch {
      // 锁库/列不匹配：跳过该库
    } finally {
      try {
        db?.close()
      } catch {
        // 忽略
      }
    }
  }
  return registered
}

/** 记录一次改名；DB 未写成功时标记 pending，扫描时自动重试补写 */
export function setRenameOverride(sessionId: string, title: string, pendingDbUpdate: boolean): void {
  renameOverrides.set(sessionId, { title, pendingDbUpdate })
}

/** 扫描时调用：补写仍 pending 的 DB 更新 */
export async function retryPendingDbUpdates(): Promise<void> {
  const pending = [...renameOverrides.entries()].filter(([, v]) => v.pendingDbUpdate)
  if (pending.length === 0) return
  for (const [id, v] of pending) {
    const ok = await updateThreadTitleInDbs(id, v.title)
    if (ok) renameOverrides.set(id, { ...v, pendingDbUpdate: false })
  }
}

export function getRenameOverride(sessionId: string): ThreadTitle | undefined {
  return renameOverrides.get(sessionId)
}
