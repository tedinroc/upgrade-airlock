// Cloudflare Pages Function: POST /api/operator/propose {"card": "<id>"} with Authorization: Bearer <token>.
// Launches one of the seven fixed cards on Ethereum Sepolia (operator/cards.ts); see operator/operator.ts.
import { handleProposeRequest, type CloudEnv } from '../../../operator/cloud.ts'

export const onRequest = (ctx: { request: Request; env: CloudEnv }): Promise<Response> => handleProposeRequest(ctx.request, ctx.env)
