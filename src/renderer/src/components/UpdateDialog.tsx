import { ArrowUpCircle, ExternalLink } from 'lucide-react'
import type { UpdateCheckResult } from '@shared/types'
import { Modal } from './Modal'

/** 发现新版本：显示版本号 + 更新说明，跳转 GitHub Release 下载 */
export function UpdateDialog({
  result,
  onClose,
  onDownload
}: {
  result: UpdateCheckResult
  onClose: () => void
  onDownload: (url: string) => void
}) {
  return (
    <Modal title="发现新版本" onClose={onClose} width="w-[30rem]">
      <div className="space-y-3 px-5 py-4">
        <div className="flex items-center gap-2 text-sm">
          <ArrowUpCircle className="h-5 w-5 text-emerald-500" />
          <span className="text-zinc-500 dark:text-zinc-400">
            v{result.currentVersion} → <span className="font-medium text-emerald-600 dark:text-emerald-400">v{result.latestVersion}</span>
          </span>
        </div>
        {result.notes && (
          <div className="max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-600 dark:border-zinc-700/60 dark:bg-zinc-800/70 dark:text-zinc-400">
            {result.notes}
          </div>
        )}
        <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-500">
          点击下方按钮前往 GitHub Release 页面下载新版本安装包，下载后直接运行即可覆盖安装。
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
        <button
          onClick={onClose}
          className="rounded-md px-3.5 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          暂不更新
        </button>
        <button
          onClick={() => result.releaseUrl && onDownload(result.releaseUrl)}
          className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          前往下载
        </button>
      </div>
    </Modal>
  )
}
