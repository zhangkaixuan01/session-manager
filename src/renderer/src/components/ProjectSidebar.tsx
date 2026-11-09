import { FolderOpen, Inbox } from 'lucide-react'
import type { ProjectGroup } from '../utils'

export function ProjectSidebar({
  groups,
  total,
  selected,
  onSelect
}: {
  groups: ProjectGroup[]
  total: number
  selected: string | null
  onSelect: (dir: string | null) => void
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800/80 dark:bg-zinc-900/40">
      <nav className="flex-1 overflow-y-auto p-2">
        <SidebarItem
          icon={<Inbox className="h-4 w-4" />}
          label="全部会话"
          count={total}
          active={selected === null}
          onClick={() => onSelect(null)}
        />
        <div className="mt-2 mb-1 px-2 text-xs font-medium text-zinc-500 dark:text-zinc-600">按项目（{groups.length}）</div>
        {groups.map((g) => (
          <SidebarItem
            key={g.dir}
            icon={<FolderOpen className="h-4 w-4" />}
            label={g.label}
            title={g.dir === '' ? undefined : g.dir}
            count={g.count}
            active={selected === g.dir}
            onClick={() => onSelect(g.dir)}
          />
        ))}
      </nav>
    </aside>
  )
}

function SidebarItem({
  icon,
  label,
  title,
  count,
  active,
  onClick
}: {
  icon: React.ReactNode
  label: string
  title?: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
        active
          ? 'bg-sky-500/15 text-sky-700 dark:text-sky-200'
          : 'text-zinc-600 hover:bg-zinc-200/70 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/70 dark:hover:text-zinc-200'
      }`}
    >
      <span className={active ? 'text-sky-600 dark:text-sky-300' : 'text-zinc-400 dark:text-zinc-600'}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-xs text-zinc-500">{count}</span>
    </button>
  )
}
