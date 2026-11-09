import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpCircle, Moon, RefreshCw, Sun } from 'lucide-react'
import type { ProviderId, SessionMeta, UpdateCheckResult } from '@shared/types'
import { api } from './api'
import { applyTheme, loadTheme, saveTheme, type Theme } from './theme'
import { filterSessions, groupByProject } from './utils'
import { ProviderTabs } from './components/ProviderTabs'
import { SearchField } from './components/SearchField'
import { ProjectSidebar } from './components/ProjectSidebar'
import { SessionList, type SessionActions } from './components/SessionList'
import { RenameDialog } from './components/RenameDialog'
import { ConfirmDialog, DeleteConfirmDialog } from './components/ConfirmDialog'
import { PreviewDrawer } from './components/PreviewDrawer'
import { UpdateDialog } from './components/UpdateDialog'
import { ToastStack, useToasts } from './components/Toast'

export default function App() {
  const [providerId, setProviderId] = useState<ProviderId>('claude')
  const [theme, setTheme] = useState<Theme>(() => loadTheme())
  const [keyword, setKeyword] = useState('')
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<SessionMeta | null>(null)
  const [deleting, setDeleting] = useState<SessionMeta | null>(null)
  const [converting, setConverting] = useState<SessionMeta | null>(null)
  const [previewing, setPreviewing] = useState<SessionMeta | null>(null)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)

  const appInfoQuery = useQuery({ queryKey: ['appInfo'], queryFn: () => api.appInfo(), staleTime: Infinity })

  const { toasts, push, dismiss } = useToasts()
  const queryClient = useQueryClient()

  const sessionsQuery = useQuery({
    queryKey: ['sessions', providerId],
    queryFn: () => api.listSessions(providerId),
    refetchInterval: providerId === 'claude' ? 10_000 : false
  })
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data])
  const groups = useMemo(() => groupByProject(sessions), [sessions])

  const visible = useMemo(() => {
    let list = filterSessions(sessions, keyword)
    if (selectedProject !== null) list = list.filter((s) => (s.projectDir ?? '') === selectedProject)
    return list
  }, [sessions, keyword, selectedProject])

  const renameMutation = useMutation({
    mutationFn: (args: { session: SessionMeta; title: string }) =>
      api.renameSession({
        providerId: args.session.providerId,
        sessionId: args.session.sessionId,
        sourcePath: args.session.sourcePath,
        newTitle: args.title
      }),
    onSuccess: (result, { session, title }) => {
      if (result.ok) {
        push('success', `已重命名：${session.title ?? session.sessionId} → ${title}`)
        for (const w of result.warnings) push('info', w)
      } else {
        push('error', result.error ?? '重命名失败')
      }
      setRenaming(null)
      void queryClient.invalidateQueries({ queryKey: ['sessions', session.providerId] })
    }
  })

  const deleteMutation = useMutation({
    mutationFn: (args: { session: SessionMeta }) =>
      api.deleteSession({ providerId: args.session.providerId, sourcePath: args.session.sourcePath }),
    onSuccess: (result, { session }) => {
      if (result.ok) {
        push('success', `已移入回收站：${session.title ?? session.sessionId}`)
      } else {
        push('error', result.error ?? '删除失败')
      }
      setDeleting(null)
      void queryClient.invalidateQueries({ queryKey: ['sessions', session.providerId] })
    }
  })

  const convertMutation = useMutation({
    mutationFn: (args: { session: SessionMeta }) =>
      api.convertSession({
        providerId: args.session.providerId,
        sessionId: args.session.sessionId,
        sourcePath: args.session.sourcePath,
        title: args.session.title ?? undefined
      }),
    onSuccess: (result) => {
      if (result.ok && result.resumeCommand) {
        navigator.clipboard
          .writeText(result.resumeCommand)
          .then(() => {
            push(
              'success',
              `已生成 ${result.targetProvider === 'codex' ? 'Codex' : 'Claude Code'} 副本，命令已复制：${result.resumeCommand}`
            )
          })
          .catch(() => {
            push('info', `副本已生成，请手动复制命令：${result.resumeCommand}`)
          })
        for (const w of result.warnings) push('info', w)
        // 对方列表立即可见新副本
        void queryClient.invalidateQueries({ queryKey: ['sessions'] })
      } else {
        push('error', result.error ?? '转换失败')
        for (const w of result.warnings) push('info', w)
      }
      setConverting(null)
    }
  })

  const checkUpdates = async () => {
    setChecking(true)
    try {
      const r = await api.checkUpdates()
      if (r.error) {
        push('error', r.error)
      } else if (r.hasUpdate) {
        setUpdateResult(r)
      } else {
        push('success', `已是最新版本 v${r.currentVersion}`)
      }
    } catch {
      push('error', '检查更新失败')
    } finally {
      setChecking(false)
    }
  }

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    applyTheme(next)
    saveTheme(next)
  }

  const actions: SessionActions = {
    onRename: (s) => setRenaming(s),
    onPreview: (s) => setPreviewing(s),
    onCopy: (s) => {
      navigator.clipboard
        .writeText(s.resumeCommand)
        .then(() => push('success', `已复制：${s.resumeCommand}`))
        .catch(() => push('error', '复制失败'))
    },
    onReveal: (s) => {
      void api.revealPath(s.sourcePath)
    },
    onDelete: (s) => setDeleting(s),
    onConvert: (s) => setConverting(s)
  }

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800/80 dark:bg-zinc-900">
        <ProviderTabs
          value={providerId}
          onChange={(id) => {
            setProviderId(id)
            setSelectedProject(null)
          }}
          counts={{
            claude: providerId === 'claude' ? sessions.length : undefined,
            codex: providerId === 'codex' ? sessions.length : undefined
          }}
        />
        <SearchField value={keyword} onChange={setKeyword} placeholder="搜索标题" />
        <button
          title={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
          onClick={toggleTheme}
          className="flex shrink-0 items-center rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-zinc-500 hover:text-zinc-800 dark:border-zinc-700/70 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <button
          title="刷新列表"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ['sessions', providerId] })}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:border-zinc-700/70 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          <RefreshCw className={`h-4 w-4 ${sessionsQuery.isFetching ? 'animate-spin' : ''}`} />
          刷新
        </button>
        <button
          title="检查 GitHub 上的新版本"
          onClick={() => void checkUpdates()}
          disabled={checking}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-500 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700/70 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          <ArrowUpCircle className={`h-4 w-4 ${checking ? 'animate-pulse' : ''}`} />
          {checking ? '检查中…' : '检查更新'}
          <span className="font-mono text-xs opacity-60">
            v{appInfoQuery.data?.version ?? '…'}
          </span>
        </button>
      </header>

      {/* 主体 */}
      <div className="flex min-h-0 flex-1">
        <ProjectSidebar
          groups={groups}
          total={sessions.length}
          selected={selectedProject}
          onSelect={setSelectedProject}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800/80">
            <span>{selectedProject === null ? '全部项目' : groups.find((g) => g.dir === selectedProject)?.label}</span>
            <span className="text-zinc-300 dark:text-zinc-700">|</span>
            <span>{visible.length} 个会话</span>
            {sessionsQuery.isError && <span className="text-red-400">读取失败，请重试</span>}
          </div>
          <div className="min-h-0 flex-1">
            <SessionList
              sessions={visible}
              loading={sessionsQuery.isLoading}
              keyword={keyword}
              actions={actions}
            />
          </div>
        </main>
      </div>

      {/* 弹层 */}
      <PreviewDrawer session={previewing} onClose={() => setPreviewing(null)} />
      {renaming !== null && (
        <RenameDialog
          session={renaming}
          running={renaming.running}
          onClose={() => setRenaming(null)}
          onSubmit={(title) => renameMutation.mutate({ session: renaming, title })}
        />
      )}
      {deleting !== null && (
        <DeleteConfirmDialog
          session={deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => deleteMutation.mutate({ session: deleting })}
        />
      )}
      {converting !== null && (
        <ConfirmDialog
          title={`转到 ${converting.providerId === 'claude' ? 'Codex' : 'Claude Code'}`}
          confirmText="生成副本并复制命令"
          onClose={() => setConverting(null)}
          onConfirm={() => convertMutation.mutate({ session: converting })}
          busy={convertMutation.isPending}
        >
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
            将会话{' '}
            <span className="font-medium text-zinc-900 dark:text-zinc-100">
              「{converting.title ?? converting.sessionId}」
            </span>{' '}
            的完整对话历史转换为{' '}
            {converting.providerId === 'claude' ? 'Codex' : 'Claude Code'} 原生会话副本，然后自动复制 resume 命令。
          </p>
          <p className="text-xs leading-relaxed text-zinc-500">
            原会话不做任何修改；思考记录（thinking/reasoning）因跨 CLI 不可移植会丢弃，不影响对话内容；上下文过长时由目标
            CLI 自动压缩。
          </p>
        </ConfirmDialog>
      )}
      {updateResult !== null && (
        <UpdateDialog
          result={updateResult}
          onClose={() => setUpdateResult(null)}
          onDownload={(url) => {
            void api.openExternal(url)
            setUpdateResult(null)
          }}
        />
      )}
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  )
}
