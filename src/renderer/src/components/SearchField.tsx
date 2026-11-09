import { Search, X } from 'lucide-react'

export function SearchField({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 focus-within:border-sky-500/50 dark:border-zinc-700/70 dark:bg-zinc-900">
      <Search className="h-4 w-4 shrink-0 text-zinc-500" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-600"
      />
      {value !== '' && (
        <button onClick={() => onChange('')} className="shrink-0 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
