// Bundles the two self-tests for Node. The live-mode test reads a fixed fake deployment (test/fixtures/chain-data.json,
// written by scripts/sync-sepolia-data.mjs from test/fixtures/deployment.json) instead of the shipped
// src/chain-data-sepolia.json, which may still be a placeholder. The offline test uses the shipped recording.
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./fixtures/chain-data.json', import.meta.url))
const swapDeployment = {
  name: 'swap-deployment',
  resolveId(source) {
    return source.endsWith('/chain-data-sepolia.json') ? fixture : null
  },
}

export default [
  {
    input: 'test/airlock-selftest.ts',
    platform: 'node',
    plugins: [swapDeployment],
    output: { file: 'node_modules/.cache/airlock-selftest.mjs', format: 'esm' },
  },
  {
    input: 'test/offline-selftest.ts',
    platform: 'node',
    output: { file: 'node_modules/.cache/offline-selftest.mjs', format: 'esm' },
  },
]
