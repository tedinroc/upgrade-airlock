// Cloudflare Pages Function: GET /api/operator. Says whether the operator panel is on for this deployment (both
// secrets set) and which cards it can launch. Everything else is in operator/cloud.ts and operator/operator.ts.
import { handleInfoRequest, type CloudEnv } from '../../../operator/cloud.ts'

export const onRequest = (ctx: { request: Request; env: CloudEnv }): Promise<Response> => handleInfoRequest(ctx.request, ctx.env)
