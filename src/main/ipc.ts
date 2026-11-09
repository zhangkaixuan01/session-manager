import fsp from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, app, ipcMain, nativeTheme, shell } from 'electron'
import type { ProviderId, SessionMeta, UpdateCheckResult } from '@shared/types'
import { GITHUB_REPO } from '@shared/config'
import { scanClaudeSessions } from './providers/claude'
import { scanCodexSessions } from './providers/codex'
import { sqliteAvailable } from './providers/codex-titles'
import { runningClaudeSessionIds } from './live'
import { renameSession, isPathAllowed } from './services/rename'
import { deleteSession } from './services/delete'
import { previewSession } from './services/preview'
import { convertSession } from './services/convert'
import { readHeadTailLines } from './infra/head-tail'
import { readZstHeadLines } from './infra/zstd'

// ─── 安全校验：路径白名单 + 文件头核对 sessionId（防伪造 sourcePath） ────────

async function verifySessionFile(providerId: ProviderId, p: string, sessionId: string): Promise<boolean> {
  if (!isPathAllowed(providerId, p)) return false
  if (providerId === 'claude') {
    if (path.basename(p, '.jsonl') === sessionId) return true
    try {
      const { head } = await readHeadTailLines(p, 10, 0)
      return head.some((line) => {
        try {
          return (JSON.parse(line) as { sessionId?: unknown }).sessionId === sessionId
        } catch {
          return false
        }
      })
    } catch {
      return false
    }
  }
  // codex：文件名 UUID 兜底，session_meta 头部核对
  if (path.basename(p).includes(sessionId)) return true
  try {
    const head = p.endsWith('.zst')
      ? await readZstHeadLines(p, 5)
      : (await readHeadTailLines(p, 5, 0)).head
    return head.some((line) => {
      try {
        const v = JSON.parse(line) as { payload?: { id?: unknown } }
        return v.payload?.id === sessionId
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/** a > b（按 x.y.z 数字逐段比较） */
function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da > db
  }
  return false
}

export function registerIpc(): void {
  ipcMain.handle('sessions:list', async (_e, providerId: ProviderId): Promise<SessionMeta[]> => {
    if (providerId === 'claude') {
      const running = await runningClaudeSessionIds()
      return scanClaudeSessions(running)
    }
    return scanCodexSessions()
  })

  ipcMain.handle(
    'sessions:rename',
    async (
      _e,
      args: { providerId: ProviderId; sessionId: string; sourcePath: string; newTitle: string }
    ) => {
      const { providerId, sessionId, sourcePath, newTitle } = args
      if (typeof sessionId !== 'string' || typeof sourcePath !== 'string' || typeof newTitle !== 'string') {
        return { ok: false, error: '参数无效', warnings: [] }
      }
      if (providerId === 'claude' && !(await verifySessionFile(providerId, sourcePath, sessionId))) {
        return { ok: false, error: '会话文件校验失败（路径或 sessionId 不匹配）', warnings: [] }
      }
      return renameSession(providerId, sessionId, sourcePath, newTitle)
    }
  )

  ipcMain.handle(
    'sessions:delete',
    async (_e, args: { providerId: ProviderId; sourcePath: string }) => {
      const { providerId, sourcePath } = args
      if (providerId !== 'claude' && providerId !== 'codex') {
        return { ok: false, error: '参数无效' }
      }
      if (typeof sourcePath !== 'string' || !isPathAllowed(providerId, sourcePath)) {
        return { ok: false, error: '路径不在允许范围内' }
      }
      try {
        await fsp.access(sourcePath)
      } catch {
        return { ok: false, error: '文件不存在（可能已被删除）' }
      }
      return deleteSession(providerId, sourcePath)
    }
  )

  ipcMain.handle(
    'sessions:preview',
    async (_e, args: { providerId: ProviderId; sourcePath: string }) => {
      const { providerId, sourcePath } = args
      if (providerId !== 'claude' && providerId !== 'codex') {
        throw new Error('参数无效')
      }
      if (typeof sourcePath !== 'string' || !isPathAllowed(providerId, sourcePath)) {
        throw new Error('路径不在允许范围内')
      }
      return previewSession(providerId, sourcePath)
    }
  )

  // 跨 CLI 转换：生成对方格式的会话副本（原文件不动），返回 resume 命令
  ipcMain.handle(
    'sessions:convert',
    async (
      _e,
      args: { providerId: ProviderId; sessionId: string; sourcePath: string; title?: string }
    ) => {
      const { providerId, sessionId, sourcePath, title } = args
      if (providerId !== 'claude' && providerId !== 'codex') {
        return { ok: false, error: '参数无效', warnings: [] }
      }
      if (
        typeof sessionId !== 'string' ||
        typeof sourcePath !== 'string' ||
        !(await verifySessionFile(providerId, sourcePath, sessionId))
      ) {
        return { ok: false, error: '会话文件校验失败（路径或 sessionId 不匹配）', warnings: [] }
      }
      return convertSession(providerId, sourcePath, typeof title === 'string' ? title : '')
    }
  )

  ipcMain.handle('shell:revealPath', async (_e, p: string) => {
    if (typeof p !== 'string') return
    if (!isPathAllowed('claude', p) && !isPathAllowed('codex', p)) return
    shell.showItemInFolder(p)
  })

  // 主题同步到主进程：nativeTheme.themeSource 驱动 Windows 标题栏/边框的 DWM
  // 深浅（immersive dark mode），setBackgroundColor 避免重绘时闪错色
  ipcMain.handle('app:setTheme', (e, theme: unknown) => {
    if (theme !== 'light' && theme !== 'dark') return
    nativeTheme.themeSource = theme
    BrowserWindow.fromWebContents(e.sender)?.setBackgroundColor(
      theme === 'dark' ? '#18181b' : '#f4f4f5'
    )
  })

  // ─── 检查更新（GitHub Releases latest） ──────────────────────────────────

  ipcMain.handle('updates:check', async (): Promise<UpdateCheckResult> => {
    const currentVersion = app.getVersion()
    const base: UpdateCheckResult = {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      releaseUrl: null,
      notes: null
    }
    try {
      const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
        headers: { 'User-Agent': 'session-manager', Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(8000)
      })
      if (resp.status === 404) {
        return { ...base, error: `未找到仓库 ${GITHUB_REPO}（请修改 src/shared/config.ts 的 GITHUB_REPO 为实际仓库地址）` }
      }
      if (!resp.ok) {
        return { ...base, error: `GitHub 返回 ${resp.status}` }
      }
      const v = (await resp.json()) as {
        tag_name?: unknown
        html_url?: unknown
        body?: unknown
      }
      const tag = typeof v.tag_name === 'string' ? v.tag_name.replace(/^v/, '') : ''
      if (tag === '') return { ...base, error: 'Release 缺少版本标签' }
      const hasUpdate = isNewer(tag, currentVersion)
      return {
        ...base,
        latestVersion: tag,
        hasUpdate,
        releaseUrl: typeof v.html_url === 'string' ? v.html_url : `https://github.com/${GITHUB_REPO}/releases/latest`,
        notes: typeof v.body === 'string' && v.body.trim() !== '' ? v.body.slice(0, 2000) : null
      }
    } catch (err) {
      return { ...base, error: `网络请求失败：${String((err as Error).message ?? err)}` }
    }
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    // 只放行 GitHub 站内链接（Release 页 / 下载直链）
    if (typeof url !== 'string' || !/^https:\/\/(www\.)?github\.com\//.test(url)) return
    void shell.openExternal(url)
  })

  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    sqliteAvailable: await sqliteAvailable(),
    platform: `${process.platform} ${process.getSystemVersion?.() ?? ''}`.trim()
  }))
}
