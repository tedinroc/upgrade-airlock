// Dev server and build for the Upgrade Airlock war room.
// AIRLOCK_DEPLOYMENT=<DeployEth output JSON> serves that deployment instead of src/chain-data-sepolia.json, so a local
// fork rehearsal (open with ?rpc=http://127.0.0.1:<port>) never touches the tracked data file:
//   AIRLOCK_DEPLOYMENT=$TMPDIR/deployment.json npx vite --port 5291
//
// Operator mode (web/README.md): with AIRLOCK_OPERATOR=1 the dev server also answers GET /api/operator and
// POST /api/operator/propose, so this page can launch a real attack card on Ethereum Sepolia as the AirlockAdmin owner.
//   AIRLOCK_OPERATOR=1 AIRLOCK_KEYS_DIR=<folder with owner.key> npm run dev
// The key is read from AIRLOCK_OWNER_KEY_FILE (default: owner.key in AIRLOCK_KEYS_DIR) on each request, never
// printed and never cached. Only loopback requests are answered (the peer address must be loopback, Host
// 127.0.0.1:<port> or localhost:<port>, and a matching Origin), so neither another device on the network, another site
// nor a DNS-rebound name can reach it; with a non-loopback server.host (`vite --host`) the operator stays off. AIRLOCK_OPERATOR_RPC=<url>[,<url>]
// replaces the Sepolia RPCs (a local fork); with AIRLOCK_DEPLOYMENT it is required, so fork addresses never go to
// Sepolia. Without AIRLOCK_OPERATOR=1 both routes say {enabled: false}. `vite build` / `vite preview` have no API.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import { defineConfig, type Connect, type Plugin } from 'vite'
import { localRequestAllowed, loopbackBind, JSON_HEADERS, MAX_BODY_BYTES, operatorInfo, propose, type ApiResult, type OperatorConfig } from './operator/operator.ts'
import { buildChainData, operatorDeployment } from './scripts/sync-sepolia-data.mjs'

function deploymentOverride(file: string): Plugin {
  return {
    name: 'airlock-deployment-override',
    enforce: 'pre',
    load(id) {
      if (!id.split('?')[0].endsWith('/src/chain-data-sepolia.json')) return null
      return JSON.stringify(buildChainData(JSON.parse(readFileSync(file, 'utf8'))))
    },
  }
}

const override = process.env.AIRLOCK_DEPLOYMENT

/** The local operator's settings, read from the environment on every request (null = off) */
function localOperator(): OperatorConfig | null {
  const env = process.env
  if (env.AIRLOCK_OPERATOR !== '1') return null
  const keyFile = env.AIRLOCK_OWNER_KEY_FILE || (env.AIRLOCK_KEYS_DIR ? join(env.AIRLOCK_KEYS_DIR, 'owner.key') : '')
  const rpcUrls = (env.AIRLOCK_OPERATOR_RPC ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\/\S+$/.test(s))
  if (override && !rpcUrls.length) return null
  return {
    auth: 'none',
    ownerKey: () => {
      if (!keyFile) return undefined
      try {
        return readFileSync(keyFile, 'utf8')
      } catch {
        return undefined
      }
    },
    rpcUrls: rpcUrls.length ? rpcUrls : undefined,
    deployment: override ? operatorDeployment(buildChainData(JSON.parse(readFileSync(override, 'utf8')))) : undefined,
  }
}

function sendJson(res: ServerResponse, r: ApiResult, extra: Record<string, string> = {}) {
  if (res.headersSent) return void res.end()
  res.writeHead(r.status, { ...JSON_HEADERS, ...extra })
  res.end(JSON.stringify(r.body))
}

/** The request body, or null when it is over MAX_BODY_BYTES (the rest is not kept) */
function readBody(req: Connect.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) over = true
      else parts.push(c)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(parts).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

function operatorApi(): Plugin {
  return {
    name: 'airlock-operator-api',
    apply: 'serve',
    configureServer(server) {
      const log = server.config.logger
      // a dev server reachable from the network never signs: the operator API needs a loopback-only bind
      const bindOk = loopbackBind(server.config.server.host)
      const config = (): OperatorConfig | null => (bindOk ? localOperator() : null)
      const cfg = config()
      log.info(
        !bindOk && process.env.AIRLOCK_OPERATOR === '1'
          ? '  operator: off (server.host is not loopback, e.g. --host; the operator API only runs on a 127.0.0.1 bind)'
          : cfg
            ? `  operator: ON, local only (${operatorInfo(cfg).enabled ? 'owner key file readable' : 'owner key file missing or not a 32-byte hex key: AIRLOCK_OWNER_KEY_FILE or AIRLOCK_KEYS_DIR'})`
            : process.env.AIRLOCK_OPERATOR === '1'
              ? '  operator: off (AIRLOCK_DEPLOYMENT is set without AIRLOCK_OPERATOR_RPC)'
              : '  operator: off (AIRLOCK_OPERATOR=1 turns it on)',
      )
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (path !== '/api/operator' && path !== '/api/operator/propose') return next()
        const allowed = localRequestAllowed(
          {
            remote: req.socket.remoteAddress,
            host: one(req.headers.host),
            origin: one(req.headers.origin),
            secFetchSite: one(req.headers['sec-fetch-site']),
          },
          req.socket.localPort ?? 0,
        )
        if (!allowed) return sendJson(res, { status: 403, body: { ok: false, error: 'forbidden' } })
        const run = async () => {
          if (path === '/api/operator') {
            if (req.method !== 'GET') return sendJson(res, { status: 405, body: { ok: false, error: 'method' } }, { allow: 'GET' })
            return sendJson(res, { status: 200, body: { ...operatorInfo(config()) } })
          }
          if (req.method !== 'POST') return sendJson(res, { status: 405, body: { ok: false, error: 'method' } }, { allow: 'POST' })
          const r = await propose({ authorization: one(req.headers.authorization), body: await readBody(req) }, config())
          if (r.body.ok) log.info(`  operator: proposed ${String(r.body.card)}, tx ${String(r.body.txHash)}`)
          else log.info(`  operator: refused (${r.status} ${String(r.body.error)})`)
          sendJson(res, r)
        }
        run().catch(() => sendJson(res, { status: 500, body: { ok: false, error: 'internal' } }))
      })
    },
    // `vite preview` of a static build has no operator: answer "disabled" instead of a 404 the console would show
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]
        if (path === '/api/operator' && req.method === 'GET') return sendJson(res, { status: 200, body: { ...operatorInfo(null) } })
        if (path === '/api/operator' || path === '/api/operator/propose') return sendJson(res, { status: 403, body: { ok: false, enabled: false, error: 'disabled' } })
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [...(override ? [deploymentOverride(override)] : []), operatorApi()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
})
