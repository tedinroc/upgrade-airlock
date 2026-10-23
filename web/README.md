# Upgrade Airlock war room

The live view of Upgrade Airlock on Ethereum Sepolia. The browser reads the chain directly (read-only: `eth_call`,
`eth_getLogs`, receipts and block headers; it never signs or sends) and draws every proposal as an airlock. The one
exception is [operator mode](#operator-mode-real-attacks-on-sepolia), a small backend that sends one of seven fixed
proposals for the person running a demo; the page still never holds a key.

- **Outer door**: the proposal enters the chamber.
- **Chamber**: the cooldown counts down in blocks and in minutes and seconds.
- **Inner door**: locked until a Chainlink CRE **Clear** lands on chain, then opens when the upgrade executes.
  A **Veto** ejects the proposal with its rule, the blocks and seconds it took, and the report transaction.

Beside it, the **Chainlink CRE verdict** card shows the steps the workflow ran for that proposal, the rule in plain
words and links to the proposal tx, the report tx and the evidence hash. An upgrade goes through the attack
simulation on 4 RPC providers and "all answers agree"; a change to the airlock itself (guardians, cooldown,
break-glass target) gets a config check from chain reads at the proposal block instead (R7), and an upgrade stopped by
a static rule (R5, R8) never reaches the simulation. In every case the workflow's consensus step (identical verdict
and rule), the signed report and the write on chain follow. The verdicts on Sepolia so far came from the official CRE
CLI running the workflow on a server, where the consensus step runs on one node; the same workflow and contract code
can be deployed to a DON, where every node runs these steps and the nodes must agree before a report is signed. The
strip at the bottom holds the recent proposals; click one to show it. Hashes, gas costs, the connection and the event
stream are in the **Details** drawer (`D`), hidden by default.

The cards keep the first veto of a proposal. Anyone can re-send a mined veto report until it expires (on Sepolia the
forwarder is Chainlink's permissionless test forwarder); AirlockAdmin then emits `Vetoed` again, but the proposal's
state does not change, so the re-sent copy shows up in the event stream only, never as the veto's block, transaction
or workflow id.

## Attack picker (what a visitor sees)

"Pick an attack and watch Chainlink CRE stop it": seven cards, one per demo action of `scripts/sepolia/propose.sh`
(evil-mint R1, evil-owner R2, evil-fee R3, evil-basefee R9, evil-drain R3B, remove-receiver R7, and the honest v2).
A card replays, from the very beginning, the newest **real** Sepolia proposal of that attack: it reaches the outer
door, waits in the chamber while the verdict card walks through the workflow's steps, then the Veto ejects it (or the
Clear unlocks the inner door, the rest of the cooldown is fast-forwarded and v2 executes). Each replay says it is one:
"Replay · a real Sepolia proposal · <date>", the proposal number and its transaction links; the real distance from
proposal to verdict stays on screen ("1 block · 12 s after the proposal"). A card whose attack is in its cooldown on
chain right now says "Live" and shows that proposal instead.

A first visit (not with `?clean=1` or `?p=`) shows a short intro while the chain data loads, then plays the
evil-drain replay on its own and invites the visitor to pick another card; it never shows a final verdict before the
replay that leads up to it. The page reads that proposal's logs first and starts its replay as soon as they are in,
while the other cards' history loads a few proposals at a time; if the public Sepolia RPCs do not answer for 12 s,
the intro says so and links the recorded run (`?mode=offline`). During a replay the chamber also shows the CRE
workflow step the verdict card is on (so a phone sees it without scrolling), notes that the clock is compressed, and
marks the fast-forwarded cooldown (×80). After a replay the proposal's real state stays on screen, tagged with its
date ("On-chain state · proposed <date>"), never as live. A live proposal always wins: when one arrives, any replay
stops, auto-follow shows it and it is labelled Live (the "That was a real replay…" invite above the cards goes at the
same moment); a live verdict on the newest proposal also takes the screen back from a picker replay. On a stage
screen the picker shares the bottom row with the strip of recent proposals (two tabs); on a phone it is a row of cards
to swipe, right under the top bar. `?clean=1` hides it (keys `1`-`7` still work).

## Run

```bash
npm ci
npm run dev                     # http://127.0.0.1:5173/
npm run build:airlock           # syncs ../deployments/sepolia.json, builds dist-airlock/
npx vite preview --outDir dist-airlock --port 4173
npm run typecheck && npm run selftest   # 394 checks: 282 live view and attack picker, 33 offline replay, 79 operator API
```

394 includes 7 checks that run only when the contracts' forge build output (`../out/`, from
`FOUNDRY_PROFILE=eth forge build` at the repo root) and `cast` are there: they compare the app's ABIs with the forge
artifacts and its calldata with `cast calldata`. Without them those 7 are skipped and the run prints 387 `ok` lines
(277 + 33 + 77). The CI web job has neither, so CI runs 387.

The proposals' history (`eth_getLogs` from each proposal's block) is read from drpc first, then tenderly and thirdweb,
with publicnode last (it prunes logs older than about a day); a failed call moves on to the next endpoint.

## URL parameters

| Parameter | Effect |
|---|---|
| `?mode=airlock` | Default. Live view of Ethereum Sepolia |
| `?mode=offline` | Replays the recorded Sepolia run (`src/recorded-run.json`) with no network connection at all |
| `?lang=en`, `?lang=zh-CN`, `?lang=zh-TW` | Interface language (default `zh-CN`) |
| `?p=<id>` | Opens on that proposal, also one older than the recent ones (it is read too); an id the chain does not have yet says "No proposal #id". Offline, the replay loop starts with it |
| `?clean=1` | Recording mode: no language switch, Details, `?` or key hints (the Chainlink CRE mark stays). Use it for the demo video |
| `?rpc=http://127.0.0.1:<port>` | Reads a local Sepolia fork instead (rehearsals), labelled "local fork". Loopback addresses only (`127.x`, `localhost`, `[::1]`); any other host is ignored |
| `?op=1` | Operator mode: asks for the operator token (recommended on a stage machine: the token never sits in an address) |
| `#op=<token>` / `?op=<token>` | Operator mode: stores the operator token in this browser and removes it from the address bar (a `#` fragment never reaches the server) |

## Presenter controls

| Key | Action |
|---|---|
| `←` / `→` (also Page Up / Page Down, for a clicker) | Previous (older) / next (newer) proposal |
| `N` (also Home / End) | Jump to the newest proposal |
| `Space` (also Enter) | Replay the selected proposal's verdict moment: arrival, cooldown fast-forwarded, verdict, inner door (pressed while its history still loads, it plays as soon as it is in) |
| `F` | Auto-follow on / off (also the toggle above the strip). On (the default), each new live proposal takes over the screen and plays its arrival and verdict as they land. Offline, `F` toggles the replay loop |
| `P` | Play / pause the replay loop (offline it runs from page load; live it plays the recent proposals) |
| `D` | Details drawer |
| `L` | Switch language |
| `?` (also `H`) | On-screen help with these keys |
| `1` - `7` | Replay attack card 1-7 of the picker (left to right), also with `?clean=1` |
| `O` | Operator panel (only where [operator mode](#operator-mode-real-attacks-on-sepolia) is on for this browser) |
| `Esc` | Close the drawer, the help and the operator panel |

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
| `src/lab.ts`, `src/lab-ui.ts` | Attack picker: card -> proposal, first-visit intro and autoplay, the picker and the operator panel drawn |
| `src/operator-client.ts` | Operator mode in the page: `GET /api/operator`, the token (`?op=1`, `#op=`), launches and their status |
| `src/view.ts` | Small shared drawing helpers (links, hashes, icons) |
| `src/replay.ts`, `src/playback.ts` | Replay engine on a virtual block clock, bound to the page |
| `src/chainwatch.ts`, `src/chain.ts`, `src/events.ts` | Live reads of Sepolia (WebSocket with HTTP fallback, `eth_getLogs` cursor) |
| `src/offline.ts`, `src/recorded-run.json` | Offline replay of the recorded run (`npm run record:run` writes it) |
| `operator/` | Operator backend shared by the dev server and the Pages Functions: the seven cards (`cards.ts`), checks, signing and sending (`operator.ts`), Request/Response handlers (`cloud.ts`), the deployment data (`deployment.generated.ts`, written by `npm run sync:sepolia`) |
| `functions/api/operator/` | Cloudflare Pages Functions: `GET /api/operator`, `POST /api/operator/propose` |
| `test/` | Self-tests (`npm run selftest`, 394 checks; 387 without the forge build output in `../out/` and `cast`, as in CI): live view and attack picker against a fake Sepolia (282), offline replay with every network call trapped (33), the operator API against a fake Sepolia (79) |

## Operator mode (real attacks on Sepolia)

For the person running a demo only. The page gets an operator panel that launches one of the seven cards as a real
proposal on Ethereum Sepolia; the live war room then picks up the proposal and its Chainlink CRE verdict like any
other. Visitors never see it: the page only asks `GET /api/operator` on a loopback host (local dev), when this browser
already holds the operator token, or with `?op=1`, so a public visitor's page never calls the API at all. The panel
appears only when the API says `enabled` and either it needs no token (the local dev server) or this browser holds the
token. A static deploy has no API at all (`vite preview` answers `enabled: false`). The API itself is public, though:
`GET /api/operator` tells anyone who asks whether operator mode is on, its auth kind, the card ids and the cooldown
(nothing else); only `POST /api/operator/propose` needs the token.

### Local

```bash
AIRLOCK_OPERATOR=1 AIRLOCK_KEYS_DIR=<folder with owner.key> npm run dev     # http://127.0.0.1:5173/
```

- The owner key is read from `AIRLOCK_OWNER_KEY_FILE` (default: `owner.key` in `AIRLOCK_KEYS_DIR`) on every request;
  it is never cached, printed or logged. The startup line says whether the file is readable.
- No token (auth `none`), loopback only: the connecting peer address must itself be loopback (127/8, `::1`), so
  another device on the same Wi-Fi gets 403 even if it sends `Host: 127.0.0.1`. The request must also carry Host
  `127.0.0.1:<port>` or `localhost:<port>` and, when the browser sends one, the same Origin, so other sites and
  DNS-rebound names get 403. With a non-loopback `server.host` (`vite --host`, `0.0.0.0`, a LAN address) the operator
  stays off and the startup line says why.
- `AIRLOCK_OPERATOR_RPC=<url>[,<url>]` replaces the Sepolia RPCs (a local fork). With `AIRLOCK_DEPLOYMENT` it is
  required, so fork addresses are never sent to Sepolia.
- Without `AIRLOCK_OPERATOR=1` both routes say `enabled: false`. `vite preview` and the static build have no API.

### Cloud (Cloudflare Pages Functions)

`functions/api/operator/` serves the same API from the Pages project, with token auth. It reads two secrets and is
off unless both exist: `OWNER_KEY` (the owner's key, hex) and `OPERATOR_TOKEN` (32 characters or more; use 64 hex).
Give them to wrangler on stdin, never on the command line:

```bash
tr -d ' \n' < "$AIRLOCK_KEYS_DIR/owner.key" | npx wrangler@3 pages secret put OWNER_KEY --project-name <project>
(umask 077; openssl rand -hex 32 > "$AIRLOCK_KEYS_DIR/operator.token")
tr -d '\n' < "$AIRLOCK_KEYS_DIR/operator.token" | npx wrangler@3 pages secret put OPERATOR_TOKEN --project-name <project>
```

Secrets apply from the next deployment. Deploy with `wrangler pages deploy <static dir>` run from a folder that holds
`functions/`, `operator/` and a `node_modules` with viem, so wrangler compiles the Functions into the Worker; check
that `GET /api/operator` answers JSON. Then open the page once with `?op=1` and paste the token (safest on a
projector: no address-bar suggestion can show it), or with `#op=<token>`, which never reaches the server's request log
(`?op=<token>` works too, but does).

Deleting either secret and deploying turns the operator off on the production URL only. Cloudflare keeps every
deployment with the secrets it was deployed with, so each older deployment's own `https://<hash>.<project>.pages.dev`
URL keeps a working operator API with the old key and token (and a rollback to one turns it back on) until that
deployment is deleted; a new token is no different. After the event: delete both secrets, deploy, delete every
deployment made while the secrets were set (Cloudflare dashboard, or `wrangler pages deployment delete` in wrangler 4),
then check that `GET https://<hash>.<project>.pages.dev/api/operator` answers 404 or `enabled: false` for each. The
owner key itself cannot be rotated on chain (`AirlockAdmin.owner` is immutable), which is why the old deployments must
go.

### API

| Request | Answers |
|---|---|
| `GET /api/operator` | `200 {enabled, auth: "none" \| "token", cards, cooldownBlocks}`; off: `{enabled: false, auth: "token", cards: [], cooldownBlocks: 0}` |
| `POST /api/operator/propose` with `{"card": "<id>"}` and, for auth `token`, `Authorization: Bearer <token>` | `200 {ok: true, card, txHash}` · `400 unknown card` · `401 unauthorized` · `409 cooldown` with `retryAfterBlocks` · `502 rpc` |

Cards: `evil-mint`, `evil-owner`, `evil-fee`, `evil-basefee`, `evil-drain`, `remove-receiver`, `v2`. Three more answers
only a setup problem or the chain itself causes: `403 disabled` (operator off), `422 reverted` (the dry run reverted,
nothing was sent), `500 misconfigured` (the key is not the owner's). Errors are `{ok: false, error}` with a fixed word.
`200` means sent, not mined: the page shows the transaction as pending until the war room sees the proposal.
The page gives every answer its own sentence (a refused origin `403 forbidden`, a switched-off operator `403 disabled`,
`422`, `500 misconfigured` and so on) and never shows the server's own words. A `401` forgets the stored token and
hides the operator UI; `403 disabled` hides it too.

In the page, the bolt button in the top bar (or `O`) opens the launch panel; each card also gets a "Launch" button.
Every launch has a confirm step. After the server answers with a transaction hash, auto-follow is turned on, the
airlock shows the launch as pending (with its Etherscan link) and the live war room takes over as soon as the proposal
is on chain, then shows its Chainlink CRE verdict. With `?clean=1` only `O` opens the panel.

### Safety limits

- Seven fixed actions only, the same as `scripts/sepolia/propose.sh`: `proposeUpgrade(<impl>, 0x)` for the six upgrade
  cards and `proposeSetGuardian(<receiver>, false)` for `remove-receiver`. The client sends a card id, never an address
  or calldata; the addresses are bundled at build time (`operator/deployment.generated.ts`).
- Before anything is sent: the key must belong to the AirlockAdmin owner (checked before any network call); the RPC
  must be Sepolia; the newest proposal must be at least 3 blocks old and the owner must have nothing pending (409); a
  dry run as the owner must not revert (422).
- One transaction per request: EIP-1559, gas limit 1,000,000 (`proposeUpgrade` used 594,008 on Sepolia), nonce and
  fees from the node (max fee 2 x base fee + tip, tip at least 1.5 gwei, never above 500 gwei). If publicnode fails,
  drpc gets the same signed bytes, so a retry cannot send twice.
- No response or log line carries the key, the token or a node's error text. The token check is constant-time (both
  sides are hashed first). Responses are JSON with `Cache-Control: no-store`.
