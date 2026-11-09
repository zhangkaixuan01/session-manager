import { useQuery } from '@tanstack/react-query'
import { Loader2, TriangleAlert, X } from 'lucide-react'
import type { SessionMeta } from '@shared/types'
import { api } from '../api'
import { formatTime } from '../utils'

/** 会话内容预览抽屉（只读，500 条 / 1MB 截断） */
export function PreviewDrawer({ session, onClose }: { session: SessionMeta | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['preview', session?.providerId, session?.sourcePath],
    queryFn: () => api.previewSession({ providerId: session!.providerId, sourcePath: session!.sourcePath }),
    enabled: session !== null,
    staleTime: 60 * 1000
  })

  if (session === null) return null

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/40" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose()
    }}>
      <div className="flex h-full w-[30rem] max-w-[80vw] flex-col border-l border-zinc-300 bg-white shadow-2xl dark:border-zinc-700/60 dark:bg-zinc-900">
        <header className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100"
              title={session.title ?? undefined}
            >
              {session.title ?? '(无标题)'}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
              <span className="truncate font-mono" title={session.sessionId}>
                {session.sessionId.slice(0, 13)}…
              </span>
              <span>·</span>
              <span className="shrink-0">{formatTime(session.lastActiveAt ?? session.createdAt)}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {q.isLoading && (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在读取会话内容…
            </div>
          )}
          {q.isError && (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-red-400">
              <TriangleAlert className="h-4 w-4" /> 读取失败：{String(q.error)}
            </div>
          )}
          {q.data?.messages.length === 0 && !q.isLoading && (
            <div className="p-8 text-center text-sm text-zinc-500">没有可显示的消息</div>
          )}
          {q.data?.messages.map((m, i) => (
            <Bubble key={i} role={m.role} text={m.text} ts={m.ts} />
          ))}
          {q.data?.truncated && (
            <div className="rounded-md border border-zinc-200 bg-zinc-100 px-3 py-2 text-center text-xs text-zinc-500 dark:border-zinc-700/60 dark:bg-zinc-800/50">
              内容过长，仅显示最近 500 条 / 1MB 内的消息
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Bubble({ role, text, ts }: { role: 'user' | 'assistant'; text: string; ts: number | null }) {
  const isUser = role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[92%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
          isUser
            ? 'bg-sky-600/90 text-sky-50'
            : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200'
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{renderMarkdown(text)}</div>
        {ts !== null && (
          <div className={`mt-1 text-right text-[10px] ${isUser ? 'text-sky-200/70' : 'text-zinc-500'}`}>
            {formatTime(ts)}
          </div>
        )}
      </div>
    </div>
  )
}

/** 轻量渲染：``` 代码块 → pre；**粗体** 与 `行内代码` */
function renderMarkdown(text: string): React.ReactNode[] {
  return text.split(/```/).map((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[a-zA-Z0-9_+-]*\n?/, '')
      return (
        <pre
          key={i}
          className="my-1 overflow-x-auto rounded-md bg-black/5 p-2.5 font-mono text-xs text-zinc-700 dark:bg-zinc-950/70 dark:text-zinc-300"
        >
          {body.replace(/\n$/, '')}
        </pre>
      )
    }
    return <span key={i}>{renderInline(part)}</span>
  })
}

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    if (m[1] !== undefined) nodes.push(<strong key={key++}>{m[1]}</strong>)
    else nodes.push(
      <code key={key++} className="rounded bg-black/5 px-1 py-px font-mono text-xs text-sky-700 dark:bg-zinc-950/70 dark:text-sky-300">
        {m[2]}
      </code>
    )
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}
