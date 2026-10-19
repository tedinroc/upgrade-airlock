// Shared by both self-tests: the identity scan and the files it covers.
// The blocked names are not in the repo. They are read at test time from prep/blocked-names.txt (gitignored; one
// name per line, '#' starts a comment), or from the file named by BLOCKED_NAMES_FILE. Without that file the name
// check is skipped with a note, so a fresh clone and CI still pass; the local-path check always runs.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The self-tests run from web/ (npm run selftest), so the repo root is one level up */
const NAMES_FILE = process.env.BLOCKED_NAMES_FILE || join(process.cwd(), '..', 'prep', 'blocked-names.txt')

function loadNames(): string[] {
  if (!existsSync(NAMES_FILE)) return []
  return readFileSync(NAMES_FILE, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean)
}
export const BLOCKED: readonly string[] = loadNames()
/** Says which name list the scan used; the self-tests print it next to their identity checks */
export const NAMES_NOTE = BLOCKED.length
  ? `${BLOCKED.length} ${BLOCKED.length === 1 ? 'name' : 'names'} from the local list`
  : 'name check skipped, no prep/blocked-names.txt; local paths still checked'

/** Local paths: a home directory on macOS or Linux, or a macOS temp dir (split so this file does not match itself) */
export const LOCAL_PATH = new RegExp(['/Us', 'ers/'].join('') + '|' + ['/ho', 'me/'].join('') + '|' + ['/private/', 'var/'].join('') + '|' + ['/var/', 'folders/'].join(''))

export function findBlocked(text: string): string[] {
  const low = text.toLowerCase()
  // a hit names the entry's position in the list, never the name itself, so test output stays clean too
  const hits = BLOCKED.flatMap((b, i) => (low.includes(b.toLowerCase()) ? [`blocked name #${i + 1}`] : []))
  if (LOCAL_PATH.test(text)) hits.push('local path')
  return hits
}

/** Every source file of web/ that ships or builds (not node_modules, not build output) */
export function webFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('dist') || name.startsWith('.')) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|mjs|js|json|css|html|svg)$/.test(name) && name !== 'package-lock.json') out.push(p)
    }
  }
  walk(root)
  return out
}

export function scanWeb(root: string): { file: string; hits: string[] }[] {
  return webFiles(root)
    .map((file) => ({ file: file.slice(root.length + 1), hits: findBlocked(readFileSync(file, 'utf8')) }))
    .filter((x) => x.hits.length)
}
