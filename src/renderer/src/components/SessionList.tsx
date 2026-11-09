import { Fragment } from 'react'
import { Loader2 } from 'lucide-react'
import type { SessionMeta } from '@shared/types'
import { SessionItem, type SessionActions } from './SessionItem'
export type { SessionActions }

export function SessionList({
  sessions,
  loading,
  keyword,
  actions
}: {
  sessions: SessionMeta[]
  loading: boolean
  keyword: string
  actions: SessionActions
}) {
  if (loading && sessions.length === 0) {
    return (
      <Center>
        <Loader2 className="mb-2 h-5 w-5 animate-spin text-zinc-500" />
        正在扫描会话…
      </Center>
    )
  }
  if (sessions.length === 0) {
    return (
      <Center>
        {keyword !== ''
          ? '没有匹配的会话'
          : '未发现会话文件。请确认已安装并使用过 Claude Code / Codex CLI。'}
      </Center>
    )
  }
  const pinnedCount = sessions.filter((s) => s.providerId === 'claude' && s.running).length
  return (
    <div className="h-full overflow-y-auto">
      {sessions.map((s, index) => (
        <Fragment key={`${s.providerId}:${s.sessionId}:${s.sourcePath}`}>
          {pinnedCount > 0 && (index === 0 || index === pinnedCount) && (
            <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 text-xs font-medium text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900">
              {index === 0 ? `正在进行 · ${pinnedCount}` : `其他会话 · ${sessions.length - pinnedCount}`}
            </div>
          )}
          <SessionItem session={s} actions={actions} />
        </Fragment>
      ))}
    </div>
  )
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-sm text-zinc-500">
      {children}
    </div>
  )
}
