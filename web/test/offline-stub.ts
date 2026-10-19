// First import of offline-selftest.ts: ?mode=offline, and every way out of the machine is a trap that records the
// attempt (fetch, WebSocket, EventSource, XMLHttpRequest). Offline playback must never touch any of them.
const g = globalThis as unknown as Record<string, unknown>
g.location = { search: '?mode=offline', href: 'http://localhost/?mode=offline' }
g.window = globalThis
export const attempts: string[] = []
g.fetch = (url: unknown) => {
  attempts.push(`fetch ${String(url)}`)
  return Promise.reject(new Error('offline: no network'))
}
class Trap {
  constructor(url: unknown) {
    attempts.push(`socket ${String(url)}`)
  }
  send() {}
  close() {}
}
g.WebSocket = Trap
g.EventSource = Trap
g.XMLHttpRequest = class {
  open(_m: string, url: string) {
    attempts.push(`xhr ${url}`)
  }
  send() {}
}
