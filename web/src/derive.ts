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

/** The workflow id carried by a Verdict, or null when it is not a real one: the CRE CLI simulator writes a
 *  placeholder (0x1111…1111), and a zero or repeated-digit id says nothing about which workflow ran */
export function realWorkflowId(w: string | null | undefined): string | null {
  if (!w || !/^0x[0-9a-fA-F]{64}$/.test(w)) return null
  if (/^0x([0-9a-fA-F])\1{63}$/.test(w)) return null
  return w
}
