// Dev server and build for the Upgrade Airlock war room.
// AIRLOCK_DEPLOYMENT=<DeployEth output JSON> serves that deployment instead of src/chain-data-sepolia.json, so a local
// fork rehearsal (open with ?rpc=http://127.0.0.1:<port>) never touches the tracked data file:
//   AIRLOCK_DEPLOYMENT=$TMPDIR/deployment.json npx vite --port 5291
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import { buildChainData } from './scripts/sync-sepolia-data.mjs'

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

export default defineConfig({
  plugins: override ? [deploymentOverride(override)] : [],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
})
