// Offline-mode self-test (?mode=offline): plays the shipped src/recorded-run.json with a fake clock and checks that
// nothing ever tries to reach the network (fetch, WebSocket, EventSource and XHR are traps).   npm run selftest
import { attempts } from './offline-stub'
import { installDom } from './domstub'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { airlockView, startTitle, type AirlockPhase } from '../src/airlock'
import { PENDING, RECORDING } from '../src/chaindata'
import { CONFIG } from '../src/config'
import { blockTs } from '../src/events'
import { setLang } from '../src/i18n'
import { startOffline } from '../src/offline'
import { replayFrame, tickReplay } from '../src/playback'
import { CHAIN, MODE, OFFLINE } from '../src/runtime'
import { store } from '../src/store'
import { render, ui } from '../src/ui'
import { findBlocked, NAMES_NOTE } from './scan'

let fails = 0
function ok(cond: unknown, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`)
  if (!cond) fails++
}
const CJK = /[㐀-鿿　-〿＀-￯]/
const plain = (h: string) => h.replace(/<button data-lang[^>]*>[\s\S]*?<\/button>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ')

ok(MODE === 'offline' && OFFLINE, '?mode=offline selects offline playback')
ok(CHAIN.http.length === 0 && CHAIN.ws.length === 0 && CHAIN.explorerTx === null && CHAIN.sourcifyApi === null, 'offline: no RPC endpoint, no explorer, no Sourcify')
const raw = readFileSync(join(process.cwd(), 'src', 'recorded-run.json'), 'utf8')
ok(findBlocked(raw).length === 0, `recording has no blocked names or local paths (${NAMES_NOTE})${findBlocked(raw).length ? ': ' + findBlocked(raw).join(', ') : ''}`)
ok(RECORDING.v === 1 && RECORDING.deployment.chainId === 11155111, `recording format v1 on Sepolia (source: ${RECORDING.source})`)

const dom = installDom()
let NOW = Date.now()
Date.now = () => NOW
startTitle()

if (RECORDING.source === 'none') {
  ok(PENDING, 'no recording yet: the page says so')
  render()
  ok(plain(dom.html()).includes('还没有录制资料'), 'empty recording: "no recording yet" message')
} else {
  const R = RECORDING
  startOffline()
  const ids = Object.keys(R.proposals)
  ok(ids.length >= 2 && ids.every((id) => store.proposals.has(id)), `${ids.length} recorded proposals loaded`)
  ok(Object.keys(R.blocks).every((n) => blockTs.get(Number(n)) === R.blocks[n]) && Object.keys(R.receipts).every((tx) => store.receipts.has(tx.toLowerCase())), 'block timestamps and receipts come from the recording')
  // every proposal's final state at the end of the recording agrees with getProposal + clearanceOf
  const finals = new Map<string, AirlockPhase>()
  for (const id of ids) {
    const p = store.proposals.get(id)!
    const v = airlockView(p, R.head, (n) => blockTs.get(n))
    finals.set(id, v.phase)
    const st = R.proposals[id].status
    const want = st === 2 ? ['ejected'] : st === 3 ? ['executed'] : !/^0x0*$/.test(R.proposals[id].clearanceOf) ? ['cleared', 'ready'] : ['chamber', 'waiting']
    ok(want.includes(v.phase), `#${id} ${p.card ?? p.target}: final phase ${v.phase} matches status ${st}${st === 3 ? ` (cleared at ${v.clear?.block}, executed at ${p.execute?.block})` : ''}${st === 2 ? ` (${v.veto?.rule} by ${v.veto?.by})` : ''}`)
  }
  ok([...finals.values()].includes('ejected') && [...finals.values()].includes('executed'), 'the recording holds at least one ejected and one executed upgrade')

  // play the whole loop on a fake clock; render each phase the first time it shows up
  const seen = new Map<string, Set<AirlockPhase>>()
  const rendered = new Map<AirlockPhase, { zh: string; tw?: string; en?: string; id: string; strip: string; final: AirlockPhase }>()
  const t0 = NOW
  const limit = t0 + ids.length * 120_000
  const played = new Set<string>()
  for (NOW = t0; NOW < limit; NOW += 100) {
    tickReplay(NOW)
    const f = replayFrame(NOW)
    if (!f) continue
    played.add(f.tl.id)
    const ph = airlockView(f.p, f.vblock, (n) => blockTs.get(n)).phase
    if (!seen.has(f.tl.id)) seen.set(f.tl.id, new Set())
    seen.get(f.tl.id)!.add(ph)
    if (!rendered.has(ph)) {
      ui.details = false
      setLang('zh-CN', false)
      render()
      const shot: { zh: string; tw?: string; en?: string; id: string; strip: string; final: AirlockPhase } = { zh: dom.html(), id: f.tl.id, strip: dom.els.get('strip')?.innerHTML ?? '', final: finals.get(f.tl.id)! }
      if (ph === 'ejected') {
        setLang('zh-TW', false)
        render()
        shot.tw = dom.html()
        setLang('en', false)
        render()
        shot.en = dom.html()
        setLang('zh-CN', false)
      }
      rendered.set(ph, shot)
    }
    if (played.size === ids.length && f.tl.id === [...played][0] && NOW - t0 > 5000) break
  }
  const playable = ids.filter((id) => ['ejected', 'executed', 'cleared', 'ready'].includes(finals.get(id)!))
  ok(playable.every((id) => played.has(id)), `the loop plays every finished proposal (${[...played].join(', ')})`)
  for (const [id, phases] of seen) console.log(`     #${id}: ${[...phases].join(' → ')}`)
  const all = new Set([...seen.values()].flatMap((s) => [...s]))
  ok(['chamber', 'ejected', 'executed'].every((p) => all.has(p as AirlockPhase)) && (all.has('cleared') || all.has('ready')), `playback walks through chamber, cleared/ready, executed and ejected (${[...all].join(', ')})`)
  const badge = R.source === 'sepolia' ? '回放 · 录制自 Ethereum Sepolia' : '回放 · 录制自 Sepolia 分叉'
  for (const [ph, shot] of rendered) {
    if (ph === 'idle') continue
    ok(shot.zh.includes(`class="lk ph-${ph}`) && plain(shot.zh).includes(badge) && plain(shot.zh).includes('回放 · 冷静期快进'), `zh-CN playback frame: ${ph}, with the replay badge and the fast-forward tag`)
  }
  // the card being replayed shows "Replaying" in its status chip until the replay reaches its final state
  {
    const mid = rendered.get('chamber')!
    const card = mid.strip.split('<button').find((b) => b.includes(`data-act="sel:${mid.id}"`)) ?? ''
    ok(mid.final !== 'chamber' && card.includes('pc-chip rp') && plain(card).includes('回放中') && !plain(card).includes(mid.final === 'executed' ? '已执行 ' : '已否决'), `strip during the replay of #${mid.id}: the chip says replaying, not its final state (${mid.final})`)
  }
  const c = rendered.get('cleared') ?? rendered.get('ready')
  if (c) ok(plain(c.zh).includes('Chainlink CRE 已放行') && plain(c.zh).includes('证据哈希') && plain(c.zh).includes('报告交易') && c.zh.includes('pipe st-done k-clear'), 'cleared frame: "cleared by Chainlink CRE" with the evidence hash and the report tx')
  const x = rendered.get('executed')
  if (x) ok(plain(x.zh).includes('升级已生效') && plain(x.zh).includes('已换上 DemoBTC v2'), 'executed frame: the upgrade is live, the proxy runs v2')
  const w = rendered.get('waiting')
  if (w) ok(plain(w.zh).includes('冷静期已满') && plain(w.zh).includes('锁住 · 没有放行'), 'waiting frame: cooldown over without a clearance, the inner door stays locked')
  const e = rendered.get('ejected')!
  ok(plain(e.zh).includes('已弹出') && e.zh.includes('class="cn-stamp"') && e.zh.includes('pipe st-done k-veto'), 'zh-CN ejected frame: stamp and the CRE pipeline done as a veto')
  ok(plain(e.tw!).includes(R.source === 'sepolia' ? '回放 · 錄製自 Ethereum Sepolia' : '回放 · 錄製自 Sepolia 分叉') && plain(e.tw!).includes('已彈出'), 'zh-TW ejected frame')
  const en = plain(e.en!)
  ok(en.includes(R.source === 'sepolia' ? 'Replay · recorded on Ethereum Sepolia' : 'Replay · recorded on a Sepolia fork') && en.includes('Ejected') && en.includes('Replay · cooldown fast-forwarded') && !CJK.test(en), 'en ejected frame, no Chinese characters')
  // the drawer says when and from which blocks the run was recorded
  setLang('en', false)
  ui.details = true
  render()
  const dr = plain(dom.els.get('details')?.innerHTML ?? '')
  ok(dr.includes(`recorded ${R.recordedOn}`) && dr.includes(`#${R.head.toLocaleString('en-US')}`) && dr.includes('no network at all'), 'details drawer: recording source, block range and date; no network')
  ui.details = false
  // every recorded proposal has a card; a guardian change is named for what it does
  render()
  const strip = dom.els.get('strip')?.innerHTML ?? ''
  ok(ids.every((id) => strip.includes(`data-act="sel:${id}"`)), `strip: a card for each of the ${ids.length} recorded proposals`)
  const guard = ids.find((id) => R.proposals[id].kind === 1 && R.proposals[id].target.toLowerCase() === R.deployment.receiver.toLowerCase())
  if (guard) ok(plain(strip).includes('Remove CRE'), `#${guard}: "remove the CRE receiver" is named as such`)
  setLang('zh-CN', false)
  const every = [...rendered.values()].map((x) => x.zh + (x.tw ?? '') + (x.en ?? '')).join('')
  ok(findBlocked(every).length === 0, 'rendered offline page is clean of blocked names and local paths')
  ok(!every.includes('href="http'), 'offline page has no outbound links')
}

ok(attempts.length === 0, `no network attempt at all (${attempts.length}${attempts.length ? ': ' + attempts.slice(0, 3).join(', ') : ''})`)
console.log(`     (playback speed ${CONFIG.replay.msPerBlock} ms/block)`)
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
