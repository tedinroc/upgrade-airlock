// First import of airlock-selftest.ts: sets the URL to the live mode (no ?rpc=, so the real Sepolia settings are
// tested) before runtime.ts reads it, and swaps WebSocket for a stand-in that never connects. The test answers
// JSON-RPC with its own fake fetch, so nothing leaves the machine.
const g = globalThis as unknown as Record<string, unknown>
g.location = { search: '?mode=airlock', href: 'http://localhost/?mode=airlock' }
g.window = globalThis
class NoSocket {
  static opened: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    NoSocket.opened.push(url)
  }
  send() {}
  close() {}
}
g.WebSocket = NoSocket
export { NoSocket }
