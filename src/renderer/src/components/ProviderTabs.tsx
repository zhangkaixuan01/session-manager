import type { ProviderId } from '@shared/types'

const TABS: { id: ProviderId; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' }
]

export function ProviderTabs({
  value,
  onChange,
  counts
}: {
  value: ProviderId
  onChange: (id: ProviderId) => void
  counts: Record<ProviderId, number | undefined>
}) {
  return (
    <div className="flex rounded-lg border border-zinc-300 bg-white p-0.5 dark:border-zinc-700/70 dark:bg-zinc-900">
      {TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
            value === t.id
              ? 'bg-zinc-200/80 text-zinc-900 dark:bg-zinc-700/80 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
          }`}
        >
          {t.label}
          {counts[t.id] !== undefined && (
            <span className="ml-1.5 text-xs text-zinc-500">{counts[t.id]}</span>
          )}
        </button>
      ))}
    </div>
  )
}
