// Small view helpers shared by ui.ts (the war room) and lab-ui.ts (attack picker and operator panel): region patching,
// escaping, the inline icons and explorer links. No state of its own besides the last HTML written per region.
import { explorerUrl } from './derive'
import { CHAIN } from './runtime'
import { short } from './store'

export const $ = (id: string) => document.getElementById(id)!

const prev = new Map<string, string>()
/** Rewrite a region only when its HTML changed (keeps CSS animations and focus alive between frames) */
export function patch(id: string, html: string): boolean {
  if (prev.get(id) === html) return false
  prev.set(id, html)
  $(id).innerHTML = html
  return true
}

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}
export const num = (n: number) => n.toLocaleString('en-US')

// ---------- icons (inline, stroke = currentColor) ----------
const svg = (body: string, cls = '', vb = '0 0 24 24') =>
  `<svg class="ic ${cls}" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
export const I = {
  mark: `<svg class="mark" viewBox="0 0 40 40" aria-hidden="true"><rect x="1" y="1" width="38" height="38" rx="11" fill="#0f1834" stroke="#375BD2" stroke-opacity=".75"/><rect x="8" y="10" width="5" height="20" rx="1.6" fill="#8ea6ff"/><rect x="27" y="10" width="5" height="20" rx="1.6" fill="#35d49b"/><rect x="15.5" y="15.5" width="9" height="9" rx="2.6" fill="#ffffff"/></svg>`,
  hex: svg('<path d="M12 2.6l8.2 4.7v9.4L12 21.4l-8.2-4.7V7.3z"/><path d="M12 7.6l4.1 2.35v4.7L12 17l-4.1-2.35v-4.7z" stroke-width="1.6"/>', 'hex'),
  key: svg('<circle cx="7.5" cy="15.5" r="4"/><path d="M10.4 12.6L19 4M15.5 7.5l2.5 2.5M13.3 9.7l2 2"/>'),
  proxy: svg('<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M4 7.4l8 4.6 8-4.6M12 12v9.2"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="10.5" rx="2.6" fill="currentColor" fill-opacity=".16"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>', 'lock'),
  unlock: svg('<rect x="5" y="10.5" width="14" height="10.5" rx="2.6" fill="currentColor" fill-opacity=".16"/><path d="M8 10.5V7.8a4 4 0 0 1 7.7-1.6"/>', 'lock'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  eject: svg('<path d="M12 4.5l7.5 8.5h-15z" fill="currentColor" fill-opacity=".2"/><path d="M4.5 18.5h15"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>'),
  pause: svg('<path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="3"/>'),
  ext: svg('<path d="M14 5h5v5M19 5l-8 8M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18.5v-9A1.5 1.5 0 0 1 6.5 8H10"/>', 'ext'),
  bolt: svg('<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" fill="currentColor" fill-opacity=".2"/>', 'bolt'),
  again: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>'),
  ff: svg('<path d="M4 6.5v11l7.5-5.5zM12.5 6.5v11l7.5-5.5z" fill="currentColor" fill-opacity=".25"/>'),
}

// ---------- links ----------
function linkTo(base: string | null, v: string | undefined | null, n: number, cls = ''): string {
  if (!v) return '<span class="dim">—</span>'
  const url = explorerUrl(base, v)
  if (url) return `<a class="mono xl ${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(v)}">${esc(short(v, n))}${I.ext}</a>`
  return `<span class="mono ${cls}" title="${esc(v)}">${esc(short(v, n))}</span>`
}
export const txLink = (h: string | undefined | null, n = 4, cls = '') => linkTo(CHAIN.explorerTx, h, n, cls)
export const addrLink = (a: string | undefined | null, n = 4) => linkTo(CHAIN.explorerAddr, a, n)
export const hashSpan = (h: string | undefined | null, n = 4) => (h ? `<span class="mono" title="${esc(h)}">${esc(short(h, n))}</span>` : '<span class="dim">—</span>')
export const fullHash = (h: string | undefined | null) => (h ? `<span class="mono wrap">${esc(h)}</span>` : '<span class="dim">—</span>')
