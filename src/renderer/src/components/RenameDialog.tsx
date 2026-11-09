import { useEffect, useState } from 'react'
import type { SessionMeta } from '@shared/types'
import { Modal } from './Modal'

/** 重命名对话框：预填当前生效标题，Enter 提交 */
export function RenameDialog({
  session,
  running,
  onClose,
  onSubmit
}: {
  session: SessionMeta
  running: boolean
  onClose: () => void
  onSubmit: (title: string) => void
}) {
  const [title, setTitle] = useState(session.title ?? '')

  useEffect(() => {
    setTitle(session.title ?? '')
  }, [session])

  const submit = () => {
    if (title.trim() === '') return
    onSubmit(title)
  }

  return (
    <Modal title="重命名会话" onClose={onClose}>
      <div className="space-y-4 px-5 py-4">
        {running && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
            该会话正在运行，CLI 退出时可能写入新内容；建议先退出会话再重命名。
          </div>
        )}
        <div className="space-y-1.5">
          <label className="text-xs text-zinc-400">新标题</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
            maxLength={200}
            placeholder="输入会话标题"
            className="w-full rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-500/60 focus:ring-1 focus:ring-sky-500/40 dark:border-zinc-700 dark:bg-zinc-800/80 dark:text-zinc-100"
          />
        </div>
        <div className="truncate text-xs text-zinc-500" title={session.sourcePath}>
          {session.sourcePath}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
        <button
          onClick={onClose}
          className="rounded-md px-3.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          取消
        </button>
        <button
          onClick={submit}
          disabled={title.trim() === ''}
          className="rounded-md bg-sky-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          重命名
        </button>
      </div>
    </Modal>
  )
}
