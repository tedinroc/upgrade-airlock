// Static bytecode analysis (malicious implementations are never source-verified, so only bytecode is available).
// One opcode walker (skips PUSH data and, only when it is provably not code, the solc CBOR metadata tail):
//  - extractSelectors: every PUSH1-PUSH4 that the solc dispatcher compares against calldata, left-padded to 4 bytes
//    (PUSH4 <sel> [DUPn] EQ|GT|LT; shorter pushes also need DUPn PUSHk <sel> [DUPn] EQ|GT|LT PUSHm <dest> JUMPI).
//    Over-inclusion is harmless: an extra selector is one more probe that hits the fallback.
//  - dangerousOpcodes (R9): opcodes that let code behave differently on a real block than in a simulation (block
//    and transaction context: time, number, randomness, fees, gas, blobs, origin) and external-call / create /
//    selfdestruct opcodes. An eth_simulateV1 call without validation runs with basefee and gas price 0, so code
//    that branches on them can pass every simulated invariant and still misbehave once it is live.
//
// The metadata tail. solc appends CBOR {ipfs|bzzr0|bzzr1: hash, solc: version, experimental: bool} and its 2-byte
// length. Those bytes are still code to the EVM, so skipping them is only safe when nothing can execute them. The
// walker therefore skips a tail only when all of these hold, and otherwise walks the whole code (fail closed):
//  1. the tail decodes as an exact solc CBOR map: 0xa1-0xa4, keys among ipfs, bzzr0, bzzr1, solc, experimental (each
//     at most once), each value with its exact type and length, and it ends exactly where the declared length says;
//  2. no instruction before it runs into it: the last instruction before the tail ends at the tail and halts
//     (STOP, JUMP, RETURN, REVERT, INVALID, SELFDESTRUCT), so execution cannot fall through into it;
//  3. jumps into it are followed: every JUMPDEST the EVM accepts inside the tail is an entry point, and the
//     walker scans from each one until a halting opcode. A hash that happens to contain a reachable JUMPDEST
//     followed by, say, 0x42 (TIMESTAMP) is therefore reported; approving that codehash exempts it from R9.
const PUSH1 = 0x60
const PUSH32 = 0x7f
const EQ = 0x14
const GT = 0x11
const LT = 0x10
const DUP1 = 0x80
const DUP16 = 0x8f
const JUMPI = 0x57
const JUMPDEST = 0x5b

/** Opcodes after which execution never continues with the next byte. Undefined opcodes are not listed: the set of
 *  defined opcodes grows with forks, so the walker treats every other byte as one that may fall through. */
const HALTS = new Set([0x00 /* STOP */, 0x56 /* JUMP */, 0xf3 /* RETURN */, 0xfd /* REVERT */, 0xfe /* INVALID */, 0xff /* SELFDESTRUCT */])

export const DANGEROUS_OPCODES: Record<number, string> = {
  0x32: 'ORIGIN',
  0x3a: 'GASPRICE',
  0x40: 'BLOCKHASH',
  0x41: 'COINBASE',
  0x42: 'TIMESTAMP',
  0x43: 'NUMBER',
  0x44: 'PREVRANDAO',
  0x45: 'GASLIMIT',
  0x48: 'BASEFEE',
  0x49: 'BLOBHASH',
  0x4a: 'BLOBBASEFEE',
  0x5a: 'GAS',
  0xf0: 'CREATE',
  0xf1: 'CALL',
  0xf2: 'CALLCODE',
  0xf4: 'DELEGATECALL',
  0xf5: 'CREATE2',
  0xfa: 'STATICCALL',
  0xff: 'SELFDESTRUCT',
}
/** The R9 opcode names (what `allowedOpcodes` in the config may list). */
export const DANGEROUS_OPCODE_NAMES = Object.values(DANGEROUS_OPCODES).sort() as [string, ...string[]]

export function codeBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(h.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.substr(i * 2, 2), 16)
  return out
}

const pushLen = (op: number) => (op >= PUSH1 && op <= PUSH32 ? op - PUSH1 + 1 : 0)

/** The value of one solc metadata key starting at `p`; returns the position after it, or -1 if it is malformed. */
function metadataValue(code: Uint8Array, key: string, p: number, end: number): number {
  const b = code[p]
  switch (key) {
    case 'ipfs': // bytes(34): a sha2-256 multihash
      return b === 0x58 && code[p + 1] === 0x22 ? p + 2 + 34 : -1
    case 'bzzr0':
    case 'bzzr1': // bytes(32)
      return b === 0x58 && code[p + 1] === 0x20 ? p + 2 + 32 : -1
    case 'solc': {
      if (b === 0x43) return p + 1 + 3 // release: bytes(3) major, minor, patch
      // prerelease: the full version as a text string ("0.8.31-develop.2025.1.1+commit.abcdef12")
      let len: number
      let q: number
      if (b >= 0x61 && b <= 0x77) [len, q] = [b - 0x60, p + 1]
      else if (b === 0x78 && p + 1 < end) [len, q] = [code[p + 1], p + 2]
      else return -1
      if (len < 5 || q + len > end) return -1
      for (let i = q; i < q + len; i++) if (code[i] < 0x21 || code[i] > 0x7e) return -1
      if (code[q] < 0x30 || code[q] > 0x39) return -1
      return q + len
    }
    case 'experimental': // CBOR false / true
      return b === 0xf4 || b === 0xf5 ? p + 1 : -1
    default:
      return -1
  }
}

/** Start of the CBOR metadata tail if the code ends in an exact solc metadata map and its declared length; else -1. */
export function solcMetadataStart(code: Uint8Array): number {
  const n = code.length
  if (n < 3) return -1
  const len = (code[n - 2] << 8) | code[n - 1]
  const start = n - 2 - len
  const end = n - 2
  if (len < 1 || start < 1) return -1 // a tail at offset 0 would be the first code the EVM runs
  const head = code[start]
  if (head < 0xa1 || head > 0xa4) return -1
  const seen = new Set<string>()
  let p = start + 1
  for (let i = 0; i < head - 0xa0; i++) {
    const kh = code[p]
    if (kh === undefined || kh < 0x61 || kh > 0x77) return -1 // keys are short text strings
    const klen = kh - 0x60
    if (p + 1 + klen > end) return -1
    let key = ''
    for (let k = p + 1; k < p + 1 + klen; k++) key += String.fromCharCode(code[k])
    if (seen.has(key)) return -1
    seen.add(key)
    p = metadataValue(code, key, p + 1 + klen, end)
    if (p < 0 || p > end) return -1
  }
  return p === end ? start : -1
}

/**
 * How the walker sees `code`: the executable part [0, end) and, when a metadata tail is skipped, the entry points
 * into it (JUMPDESTs the EVM accepts there). end === code.length means nothing is skipped.
 */
export function codeLayout(code: Uint8Array): { end: number; tailEntries: number[] } {
  const whole = { end: code.length, tailEntries: [] }
  const start = solcMetadataStart(code)
  if (start < 0) return whole
  let pc = 0
  let last = -1
  while (pc < start) {
    last = code[pc]
    pc += 1 + pushLen(last)
  }
  // a PUSH whose data runs into the tail, or an instruction that falls through into it: the tail is code
  if (pc !== start || !HALTS.has(last)) return whole
  // the EVM's JUMPDEST analysis continues through the tail from the same instruction boundary
  const tailEntries: number[] = []
  for (pc = start; pc < code.length; pc += 1 + pushLen(code[pc])) if (code[pc] === JUMPDEST) tailEntries.push(pc)
  return { end: start, tailEntries }
}

function walkOpcodes(code: Uint8Array, cb: (op: number, pc: number, pushLen: number, end: number) => void) {
  const { end, tailEntries } = codeLayout(code)
  for (let pc = 0; pc < end; pc++) {
    const op = code[pc]
    const n = pushLen(op)
    cb(op, pc, n, end)
    pc += n
  }
  // reachable parts of a skipped tail: from each entry until execution halts
  for (const entry of tailEntries) {
    for (let pc = entry; pc < code.length; pc++) {
      const op = code[pc]
      const n = pushLen(op)
      cb(op, pc, n, code.length)
      if (HALTS.has(op)) break
      pc += n
    }
  }
}

const isDup = (b: number) => b >= DUP1 && b <= DUP16
const isCmp = (b: number) => b === EQ || b === GT || b === LT

export function extractSelectors(codeHex: string): string[] {
  const code = codeBytes(codeHex)
  const found = new Set<string>()
  let prevOp = -1
  walkOpcodes(code, (op, pc, n, end) => {
    const before = prevOp
    prevOp = op
    if (n < 1 || n > 4 || pc + n + 1 >= end) return
    let k = pc + n + 1
    if (isDup(code[k]) && k + 1 < end) k++
    if (!isCmp(code[k])) return
    if (n < 4) {
      if (!isDup(before)) return
      const j = code[k + 1]
      if (!(j >= PUSH1 && j <= PUSH1 + 2)) return
      if (code[k + 1 + (j - PUSH1 + 1) + 1] !== JUMPI) return
    }
    let bytes = ''
    for (let i = pc + 1; i < pc + 1 + n; i++) bytes += code[i].toString(16).padStart(2, '0')
    const sel = bytes.padStart(8, '0')
    if (sel !== 'ffffffff' && sel !== '00000000') found.add(`0x${sel}`)
  })
  return [...found].sort()
}

export function dangerousOpcodes(codeHex: string): string[] {
  if (!codeHex || codeHex === '0x') return []
  const found = new Set<string>()
  walkOpcodes(codeBytes(codeHex), (op) => {
    const name = DANGEROUS_OPCODES[op]
    if (name) found.add(name)
  })
  return [...found].sort()
}
