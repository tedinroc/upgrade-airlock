# Upgrade Airlock war room

The live view of Upgrade Airlock on Ethereum Sepolia. The browser reads the chain directly (read-only: `eth_call`,
`eth_getLogs`, receipts and block headers; it never signs or sends) and draws every proposal as an airlock:

- **Outer door**: the proposal enters the chamber.
- **Chamber**: the cooldown counts down in blocks and in minutes and seconds.
- **Inner door**: locked until a Chainlink CRE **Clear** lands on chain, then opens when the upgrade executes.
  A **Veto** ejects the proposal with its rule, the blocks and seconds it took, and the report transaction.

Beside it, the **Chainlink CRE verdict** card shows the steps the workflow ran for that proposal, the rule in plain
words and links to the proposal tx, the report tx and the evidence hash. An upgrade goes through the attack
simulation on 4 RPC providers and "all answers agree"; a change to the airlock itself (guardians, cooldown,
break-glass target) gets a config check from chain reads at the proposal block instead (R7), and an upgrade stopped by
a static rule (R5, R8) never reaches the simulation. DON consensus, the signed report and the write on chain follow
in every case. The strip at the bottom holds the recent proposals; click one to show it. Hashes, gas costs, the
connection and the event stream are in the **Details** drawer (`D`), hidden by default.

## Run

```bash
npm ci
npm run dev                     # http://127.0.0.1:5173/
npm run build:airlock           # syncs ../deployments/sepolia.json, builds dist-airlock/
npx vite preview --outDir dist-airlock --port 4173
npm run typecheck && npm run selftest
```

## URL parameters

| Parameter | Effect |
|---|---|
| `?mode=airlock` | Default. Live view of Ethereum Sepolia |
| `?mode=offline` | Replays the recorded Sepolia run (`src/recorded-run.json`) with no network connection at all |
| `?lang=en`, `?lang=zh-CN`, `?lang=zh-TW` | Interface language (default `zh-CN`) |
| `?p=<id>` | Opens on that proposal. Offline, the replay loop starts with it |
| `?clean=1` | Recording mode: no language switch, Details, `?` or key hints (the Chainlink CRE mark stays). Use it for the demo video |
| `?rpc=http://127.0.0.1:<port>` | Reads a local Sepolia fork instead (rehearsals) |

## Presenter controls

| Key | Action |
|---|---|
| `←` / `→` (also Page Up / Page Down, for a clicker) | Previous (older) / next (newer) proposal |
| `N` (also Home / End) | Jump to the newest proposal |
| `Space` (also Enter) | Replay the selected proposal's verdict moment: arrival, cooldown fast-forwarded, verdict, inner door |
| `F` | Auto-follow on / off (also the toggle above the strip). On (the default), each new live proposal takes over the screen and plays its arrival and verdict as they land. Offline, `F` toggles the replay loop |
| `P` | Play / pause the replay loop (offline it runs from page load; live it plays the recent proposals) |
| `D` | Details drawer |
| `L` | Switch language |
| `?` (also `H`) | On-screen help with these keys |
| `Esc` | Close the drawer and the help |

A live event always wins: when a proposal or verdict arrives, any replay stops and the real state is shown.

On a stage screen with a mouse, the presenter controls (language switch, Details, `?`, the key hints) and the cursor
fade out after 3 s without mouse movement and come back when the mouse moves; keys never bring them back, so a
clicker keeps the screen clean. Touch screens never show key hints. `?clean=1` never draws them at all.

## Layout

A landscape screen at least 960 px wide and 5:4 or wider gets a fixed 1920×1080 stage scaled to the window and
letterboxed, so a 1920×1080 or 1280×720 projector, a 4:3 or 5:4 projector and the recorded video all show the same
composition. Phones, portrait screens and narrow windows get one scrolling column (the doors become rows, the stamps
size themselves to the chamber). Fonts are system fonts only (no web fonts or CDNs), and `prefers-reduced-motion`
turns every animation off (the final state of each change is shown at once).

The moments a change of state plays: the outer door closes behind an arriving proposal; a veto shakes the capsule,
drops it out and stamps EJECTED with the rule; a clearance sweeps the chamber, stamps CLEARED for about 1.5 s and
unlocks the inner door; an execution opens the inner door and the proxy lights up. Green means a clearance only,
red a veto only; "live", the presenter toggles and every other accent are Chainlink blue.

## Files

| File | What it does |
|---|---|
| `src/ui.ts` | Every region of the screen, the state "moments" (arrive, veto, clear, execute) |
| `src/style.css` | Stage and stack layouts, the airlock picture, the animations |
| `src/controls.ts` | Key map, help rows, stepping through proposals |
| `src/i18n.ts` | All words in zh-CN, zh-TW and en |
| `src/airlock.ts` | The airlock state of one proposal (pure) |
| `src/replay.ts`, `src/playback.ts` | Replay engine on a virtual block clock, bound to the page |
| `src/chainwatch.ts`, `src/chain.ts`, `src/events.ts` | Live reads of Sepolia (WebSocket with HTTP fallback, `eth_getLogs` cursor) |
| `src/offline.ts`, `src/recorded-run.json` | Offline replay of the recorded run (`npm run record:run` writes it) |
| `test/` | Self-tests: live view against a fake Sepolia, offline replay with every network call trapped |
