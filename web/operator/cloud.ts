// The Cloudflare Pages Functions side of the operator (functions/api/operator/): Web Request in, Response out.
// Plain Web APIs only, so the Node tests call these handlers directly with real Request objects.
// The operator is on only when both secrets exist (`wrangler pages secret put`, see web/README.md):
//   OWNER_KEY       the AirlockAdmin owner's private key (hex)
//   OPERATOR_TOKEN  the operator's Bearer token (64 hex characters)
import { JSON_HEADERS, MAX_BODY_BYTES, operatorInfo, propose, type ApiResult, type OperatorConfig } from './operator.ts'

export interface CloudEnv {
  OWNER_KEY?: string
  OPERATOR_TOKEN?: string
}

export function cloudConfig(env: CloudEnv): OperatorConfig | null {
  const key = env.OWNER_KEY
  const token = env.OPERATOR_TOKEN
  if (!key || !token) return null
  return { auth: 'token', token, ownerKey: () => key }
}

export function toResponse(r: ApiResult, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...JSON_HEADERS, ...extra } })
}

const methodNotAllowed = (allow: string) => toResponse({ status: 405, body: { ok: false, error: 'method' } }, { allow })

/** Reads at most `max` bytes of the body; null when there is more (the rest is never read) */
export async function readCapped(request: Request, max = MAX_BODY_BYTES): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? '0') > max) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.byteLength
  }
  return new TextDecoder().decode(all)
}

/** GET /api/operator */
export async function handleInfoRequest(request: Request, env: CloudEnv): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET')
  return toResponse({ status: 200, body: { ...operatorInfo(cloudConfig(env)) } })
}

/** POST /api/operator/propose */
export async function handleProposeRequest(request: Request, env: CloudEnv): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST')
  // the Bearer token already stops cross-site requests; a foreign Origin is refused on top of it
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== new URL(request.url).origin) return toResponse({ status: 403, body: { ok: false, error: 'forbidden' } })
  const body = await readCapped(request)
  return toResponse(await propose({ authorization: request.headers.get('authorization'), body }, cloudConfig(env)))
}
