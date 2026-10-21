// Presenter controls: keyboard shortcuts (and a clicker's Page Up / Page Down) -> page actions. Pure, so the self-test
// checks the whole map. The on-screen help (?) and web/README.md list the same keys.
//
//   ← / PageUp        previous (older) proposal
//   → / PageDown      next (newer) proposal
//   N / Home / End    newest proposal
//   Space / Enter     replay the selected proposal's verdict moment
//   F                 auto-follow on / off (offline: the replay loop)
//   P                 play / pause the replay loop
//   D                 details drawer
//   L                 language
//   ? / H             help
//   Esc               close the drawer and the help

export type Action = 'prev' | 'next' | 'newest' | 'replay' | 'follow' | 'loop' | 'details' | 'lang' | 'help' | 'close'

const KEYS: Record<string, Action> = {
  arrowleft: 'prev',
  pageup: 'prev',
  arrowright: 'next',
  pagedown: 'next',
  n: 'newest',
  home: 'newest',
  end: 'newest',
  ' ': 'replay',
  spacebar: 'replay',
  enter: 'replay',
  f: 'follow',
  p: 'loop',
  d: 'details',
  l: 'lang',
  '?': 'help',
  h: 'help',
  escape: 'close',
}

/** KeyboardEvent.key -> action; null for keys the page leaves alone (and for any key with Ctrl, Alt or Meta held) */
export function keyAction(key: string, mods: { ctrl?: boolean; alt?: boolean; meta?: boolean } = {}): Action | null {
  if (mods.ctrl || mods.alt || mods.meta) return null
  return KEYS[key.toLowerCase()] ?? null
}

/** The help overlay's rows: the keys shown for each action, in this order */
export const HELP_ROWS: { keys: string[]; action: Action }[] = [
  { keys: ['←', '→'], action: 'prev' },
  { keys: ['N'], action: 'newest' },
  { keys: ['Space'], action: 'replay' },
  { keys: ['F'], action: 'follow' },
  { keys: ['P'], action: 'loop' },
  { keys: ['D'], action: 'details' },
  { keys: ['L'], action: 'lang' },
  { keys: ['?'], action: 'help' },
  { keys: ['Esc'], action: 'close' },
]

/** Step through ids (sorted oldest to newest) from the current one; stays at either end */
export function stepId(ids: string[], cur: string | null, dir: -1 | 1): string | null {
  if (!ids.length) return null
  const sorted = [...ids].sort((a, b) => Number(a) - Number(b))
  const i = cur === null ? -1 : sorted.indexOf(cur)
  if (i < 0) return sorted[sorted.length - 1]
  return sorted[Math.max(0, Math.min(sorted.length - 1, i + dir))]
}
