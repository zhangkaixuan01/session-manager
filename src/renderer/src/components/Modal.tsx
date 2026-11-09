import { useEffect, useRef, type ReactNode } from 'react'

/** 模态框外壳：遮罩点击关闭、Esc 关闭、打开时焦点入框 */
export function Modal({
  title,
  onClose,
  children,
  width = 'w-[28rem]'
}: {
  title: string
  onClose: () => void
  children: ReactNode
  width?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, button')
    first?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div ref={ref} className={`${width} rounded-xl border border-zinc-300 bg-white shadow-2xl dark:border-zinc-700/60 dark:bg-zinc-900`}>
        <div className="border-b border-zinc-200 px-5 py-3.5 text-sm font-medium text-zinc-900 dark:border-zinc-800 dark:text-zinc-200">
          {title}
        </div>
        {children}
      </div>
    </div>
  )
}
