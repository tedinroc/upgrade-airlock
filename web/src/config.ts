// Every setting of the Upgrade Airlock war room lives in this file. Plain data only (no browser APIs), so tests can
// import it in Node.
//
// URL parameters (switch at the venue without rebuilding):
//   ?mode=airlock (default)  live: the browser reads Ethereum Sepolia directly (read only, never signs or sends)
//   ?mode=offline            plays back the recorded run in src/recorded-run.json; opens no network connection at all
//   ?rpc=http://127.0.0.1:19621   airlock only: read this JSON-RPC instead (a local Sepolia fork; WS on the same port)
//   ?lang=zh-CN | zh-TW | en

export type AppMode = 'airlock' | 'offline'

export interface ChainConfig {
  chainId: number
  /** WebSocket endpoints, tried in turn; on a drop the page polls over HTTP and reconnects in the background */
  ws: string[]
  /** HTTP JSON-RPC endpoints, rotated on failure */
  http: string[]
  /** Explorer prefixes; null on a local fork (its hashes are not on the real chain) */
  explorerTx: string | null
  explorerAddr: string | null
  /** Sourcify lookup prefix (GET <prefix><address> -> { match }); null on a local fork */
  sourcifyApi: string | null
  /** eth_blockNumber polling interval while the WS is down (ms) */
  pollMs: number
  /** Largest eth_getLogs block range one call may ask for */
  logRange: number
  /** On page load, how many blocks after each recent proposal's block are searched for its logs */
  historySpan: number
}

export const CONFIG = {
  defaultMode: 'airlock' as AppMode,

  /** Ethereum Sepolia. The three HTTP endpoints were checked with real browser-origin requests: they answer CORS
   *  preflights. publicnode and drpc also serve WS (newHeads and logs subscriptions); 1rpc has no WS and caps
   *  eth_getLogs at 50 blocks, so every getLogs call stays within 50 blocks. */
  sepolia: {
    chainId: 11155111,
    ws: ['wss://ethereum-sepolia-rpc.publicnode.com', 'wss://sepolia.drpc.org'],
    http: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org', 'https://1rpc.io/sepolia'],
    explorerTx: 'https://sepolia.etherscan.io/tx/',
    explorerAddr: 'https://sepolia.etherscan.io/address/',
    sourcifyApi: 'https://sourcify.dev/server/v2/contract/11155111/',
    pollMs: 3000,
    logRange: 50,
    historySpan: 150,
  } satisfies ChainConfig,

  /** Sepolia block time (s/block): turns blocks into seconds when no block timestamp is at hand */
  blockSec: 12,
  /** Cooldown shown before a deployment file exists (DeployEth.s.sol's default DELAY_BLOCKS) */
  delayBlocks: 25,
  /** Recent proposals listed in the toolbar and loaded on page open */
  recentProposals: 5,
  /** Sliding window (blocks) for the measured block time */
  blockTimeWindow: 60,
  /** A measured block time below this is a fast-mined fork, not a real s/block */
  minPlausibleBlockMs: 50,

  /** Playback of recorded proposals (offline mode, and the P key in live mode) */
  replay: {
    /** Virtual clock speed: ms per block (a 25-block cooldown plays in about 15 s) */
    msPerBlock: 600,
    /** Live mode: replay starts only after this long without a live event */
    idleMs: 60000,
    /** Offline mode: after the viewer picks a proposal by hand, playback resumes after this long */
    offlineIdleMs: 20000,
    /** Hold the final state of each proposal this long before the next one */
    gapMs: 4000,
    /** prefers-reduced-motion: show the final state only, hold it this long */
    reducedHoldMs: 8000,
  },
}
