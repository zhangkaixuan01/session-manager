import { memo } from 'react'
import { ArrowRightLeft, Copy, FolderOpen, Pencil, Trash2 } from 'lucide-react'
import type { SessionMeta } from '@shared/types'
import { formatTime, sourceBadge } from '../utils'

export interface SessionActions {
  onRename: (s: SessionMeta) => void
  onPreview: (s: SessionMeta) => void
  onCopy: (s: SessionMeta) => void
  onReveal: (s: SessionMeta) => void
  onDelete: (s: SessionMeta) => void
  onConvert: (s: SessionMeta) => void
}

export const SessionItem = memo(function SessionItem({
  session,
  actions
}: {
  session: SessionMeta
  actions: SessionActions
}) {
  const badge = sourceBadge(session.titleSource)
  return (
    <div
      className="group flex cursor-pointer items-center gap-3 border-b border-zinc-100 px-4 py-2.5 hover:bg-zinc-200/50 dark:border-zinc-900 dark:hover:bg-zinc-800/50"
      onClick={() => actions.onPreview(session)}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {session.running && (
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" title="会话正在运行" />
          )}
          <span
            className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100"
            title={session.title ?? undefined}
          >
            {session.title ?? '(无标题)'}
          </span>
          {session.archived && (
            <span className="shrink-0 rounded border border-zinc-400/50 bg-zinc-400/20 px-1 py-px text-[10px] text-zinc-500 dark:border-zinc-600/50 dark:bg-zinc-600/20 dark:text-zinc-400">
              已归档
            </span>
          )}
          {badge && (
            <span className={`shrink-0 rounded border px-1 py-px text-[10px] ${badge.cls}`}>{badge.label}</span>
          )}
        </div>
        {session.summary && (
          <div className="truncate text-xs text-zinc-500" title={session.summary}>
            {session.summary}
          </div>
        )}
      </div>

      <div className="w-40 shrink-0 truncate text-right text-xs text-zinc-500" title={session.projectDir ?? ''}>
        {session.projectDir ?? '—'}
      </div>
      <div className="w-24 shrink-0 text-right text-xs tabular-nums text-zinc-500">
        {formatTime(session.lastActiveAt ?? session.createdAt)}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <IconBtn title="重命名" onClick={() => actions.onRename(session)}>
          <Pencil className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn
          title={`转为 ${session.providerId === 'claude' ? 'Codex' : 'Claude Code'} 会话（生成副本并复制 resume 命令）`}
          onClick={() => actions.onConvert(session)}
        >
          <ArrowRightLeft className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn title={`复制命令：${session.resumeCommand}`} onClick={() => actions.onCopy(session)}>
          <Copy className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn title="打开文件位置" onClick={() => actions.onReveal(session)}>
          <FolderOpen className="h-3.5 w-3.5" />
        </IconBtn>
        <IconBtn title="删除（移入回收站）" danger onClick={() => actions.onDelete(session)}>
          <Trash2 className="h-3.5 w-3.5" />
        </IconBtn>
      </div>
    </div>
  )
})

function IconBtn({
  title,
  danger,
  onClick,
  children
}: {
  title: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      // 阻止冒泡：点按钮不应同时触发行的单击预览
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`rounded p-1.5 ${
        danger
          ? 'text-zinc-500 hover:bg-red-500/15 hover:text-red-500 dark:hover:text-red-400'
          : 'text-zinc-500 hover:bg-zinc-300/70 hover:text-zinc-900 dark:hover:bg-zinc-700/70 dark:hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  )
}
