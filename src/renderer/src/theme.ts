import { api } from './api'

export type Theme = 'light' | 'dark'

const KEY = 'sm-theme'

/** 默认深色（应用原有基调）；保存过则用用户选择 */
export function loadTheme(): Theme {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'dark'
}

export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle('dark', t === 'dark')
  document.documentElement.style.colorScheme = t
  // 同步主进程：标题栏/边框深浅（DWM）+ 原生窗口背景色
  void api.setTheme(t).catch(() => {})
}

export function saveTheme(t: Theme): void {
  localStorage.setItem(KEY, t)
}
