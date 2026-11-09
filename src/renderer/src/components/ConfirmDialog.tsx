import type { ReactNode } from 'react'
import { Modal } from './Modal'

/** 通用确认弹窗：删除（danger）/ 跨 CLI 转换等破坏性或写操作前的最后确认 */
export function ConfirmDialog({
  title,
  children,
  confirmText,
  danger = false,
  busy = false,
  onClose,
  onConfirm
}: {
  title: string
  children: ReactNode
  confirmText: string
  danger?: boolean
  busy?: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3 px-5 py-4">{children}</div>
      <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
        <button
          onClick={onClose}
          disabled={busy}
          className="rounded-md px-3.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          disabled={busy}
          className={
            danger
              ? 'rounded-md bg-red-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50'
              : 'rounded-md bg-emerald-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50'
          }
        >
          {busy ? '处理中…' : confirmText}
        </button>
      </div>
    </Modal>
  )
}

/** 删除确认：移入回收站（可恢复） */
export function DeleteConfirmDialog({
  session,
  onClose,
  onConfirm,
  busy
}: {
  session: { title: string | null; sessionId: string; sourcePath: string }
  onClose: () => void
  onConfirm: () => void
  busy?: boolean
}) {
  return (
    <ConfirmDialog title="删除会话" confirmText="移入回收站" danger onClose={onClose} onConfirm={onConfirm} busy={busy}>
      <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
        确定删除会话{' '}
        <span className="font-medium text-zinc-900 dark:text-zinc-100">「{session.title ?? session.sessionId}」</span>{' '}
        吗？
      </p>
      <p className="break-all rounded-md bg-zinc-100 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-800/70">
        {session.sourcePath}
      </p>
      <p className="text-xs leading-relaxed text-zinc-500">
        文件将移入系统回收站，可随时恢复；同名关联文件（如有）将一并移入。
      </p>
    </ConfirmDialog>
  )
}
