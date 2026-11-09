import { useCallback, useRef, useState } from 'react'
import { CheckCircle2, AlertCircle, Info } from 'lucide-react'

export interface ToastItem {
  id: number
  kind: 'success' | 'error' | 'info'
  text: string
}

let nextId = 1

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const push = useCallback(
    (kind: ToastItem['kind'], text: string) => {
      const id = nextId++
      setToasts((ts) => [...ts.slice(-3), { id, kind, text }])
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3000)
      )
    },
    [dismiss]
  )

  return { toasts, push, dismiss }
}

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info
}
const CLS = {
  success: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-300',
  error: 'border-red-500/40 text-red-600 dark:text-red-300',
  info: 'border-sky-500/40 text-sky-600 dark:text-sky-300'
}

export function ToastStack({ toasts, dismiss }: { toasts: ToastItem[]; dismiss: (id: number) => void }) {
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind]
        return (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto flex max-w-xl items-center gap-2 rounded-lg border bg-white/95 px-4 py-2.5 text-sm shadow-lg backdrop-blur dark:bg-zinc-900/95 ${CLS[t.kind]}`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="text-zinc-800 dark:text-zinc-200">{t.text}</span>
          </button>
        )
      })}
    </div>
  )
}
