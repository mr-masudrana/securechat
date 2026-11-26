export type Theme = 'system' | 'dark' | 'light'
export const getThemePref = (): Theme => {
  const v = localStorage.getItem('pref:theme')
  return v === 'system' || v === 'light' ? v : 'dark'
}
const mq = window.matchMedia('(prefers-color-scheme: light)')
export function applyTheme() {
  const p = getThemePref()
  const light = p === 'light' || (p === 'system' && mq.matches)
  document.documentElement.classList.toggle('light', light)
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', light ? '#f1f5f9' : '#0f172a')
}
export function setThemePref(t: Theme) {
  localStorage.setItem('pref:theme', t)
  applyTheme()
}
mq.addEventListener('change', applyTheme)
