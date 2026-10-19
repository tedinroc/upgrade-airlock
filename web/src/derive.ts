// Pure helpers for numbers on screen. No DOM, no URL, so the tests run them in Node.
import { formatEther, formatGwei } from 'viem'
import type { TxCost } from './store'
import { toBig } from './types'

const HEX = /^0x[0-9a-fA-F]+$/

/** Explorer link; null without a prefix (local fork, offline) or when the value is not hex */
export function explorerUrl(base: string | null | undefined, value: string | null | undefined): string | null {
  if (!base || !value || !HEX.test(value)) return null
  return base + value
}

/** gasUsed x effectiveGasPrice from a receipt; null when a field is missing (never a made-up default) */
export function txCost(r: TxCost | undefined): { gasUsed: bigint; priceWei: bigint; costWei: bigint } | null {
  const gasUsed = toBig(r?.gasUsed)
  const priceWei = toBig(r?.effectiveGasPrice)
  if (gasUsed === null || priceWei === null) return null
  return { gasUsed, priceWei, costWei: gasUsed * priceWei }
}

/** 4 significant digits with thousands separators (12345.6 -> 12,350; 0.0001234 -> 0.0001234) */
const sig4 = (x: number): string => x.toLocaleString('en-US', { maximumSignificantDigits: 4 })

/** Fees on Ethereum: Sepolia gas prices can be a few dozen wei, so small amounts stay in wei, then gwei / ETH */
export function fmtEth(wei: bigint): string {
  if (wei < 1_000_000_000n) return `${wei.toLocaleString('en-US')} wei`
  if (wei < 1_000_000_000_000_000n) return `${sig4(Number(formatGwei(wei)))} gwei`
  return `${sig4(Number(formatEther(wei)))} ETH`
}

/** Gas price: below 0.001 gwei it is written in wei */
export function fmtGasPrice(wei: bigint): string {
  if (wei < 1_000_000n) return `${wei.toLocaleString('en-US')} wei`
  return `${sig4(Number(formatGwei(wei)))} gwei`
}

/** A measured block time is believable (a fast-mined fork measures close to 0) */
export function plausibleBlockMs(bt: number | null, minMs: number): number | null {
  return bt !== null && bt >= minMs ? bt : null
}

/** Font size of the big block counter: longer numbers get smaller so they never overflow the top-right box */
export function blockFontPx(text: string, widthPx: number, maxPx: number): number {
  const n = Math.max(1, text.length)
  // monospace digits are about 0.6em wide, plus 4% margin; letter-spacing -0.02em included
  return Math.max(28, Math.min(maxPx, Math.floor(widthPx / (n * 0.6 * 1.04 - n * 0.02))))
}
