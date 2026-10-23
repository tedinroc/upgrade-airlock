# Live run on Ethereum Sepolia

Deployed with `scripts/sepolia/deploy.sh` (13 transactions in blocks 11950684–11950699); every contract is verified on Sourcify. The owner, approver, emergency guardian and attester are four different keys. The CRE workflow runs on a small Linux server as two systemd user services (`scripts/sepolia/systemd/`): the log-trigger listener (`cre workflow simulate -T sepolia --listen --broadcast`) and the sweeper every 60 s, with the **official CRE CLI v1.37.0 release binary** (SHA-256 pinned in `cre/setup.sh`) under a logged-in CRE account. Proposals #1–#8 were sent from another machine with `scripts/sepolia/propose.sh`; #9 and #10 were launched from the war room's operator mode (the owner key held by the `/api/operator` Pages Function) on 2026-10-23.

| Contract | Address |
|---|---|
| airlockAdmin | [`0x28e7aAC40560804F480e454bF9C12F50C83b700B`](https://sepolia.etherscan.io/address/0x28e7aAC40560804F480e454bF9C12F50C83b700B) |
| receiver | [`0xE40D463116F4Aa24d5E79776a65ED0f1b088c670`](https://sepolia.etherscan.io/address/0xE40D463116F4Aa24d5E79776a65ED0f1b088c670) |
| proxy | [`0x88Cc569265faDAEAc2a16B69f35E10B2158e4b71`](https://sepolia.etherscan.io/address/0x88Cc569265faDAEAc2a16B69f35E10B2158e4b71) |
| proxyAdmin | [`0x51a3fE6AD22BF7753574B7b7FD56aE9a65bd593E`](https://sepolia.etherscan.io/address/0x51a3fE6AD22BF7753574B7b7FD56aE9a65bd593E) |
| v1 | [`0x8f7d6453d77B3f3b008CBE4A144d82c5742eB108`](https://sepolia.etherscan.io/address/0x8f7d6453d77B3f3b008CBE4A144d82c5742eB108) |
| v2 | [`0x4D959f981C01E3B81ac6C9A20E84816Fe5f6Bce3`](https://sepolia.etherscan.io/address/0x4D959f981C01E3B81ac6C9A20E84816Fe5f6Bce3) |
| evilMint | [`0x01502c4af90c27f53B2E1293941670C6B761CAAA`](https://sepolia.etherscan.io/address/0x01502c4af90c27f53B2E1293941670C6B761CAAA) |
| evilOwner | [`0xBe849DE8e0a4D9b0010ba1468f94Eeb24A42d488`](https://sepolia.etherscan.io/address/0xBe849DE8e0a4D9b0010ba1468f94Eeb24A42d488) |
| evilFee | [`0xB95Ffa7b970B1a73488e2fC32B787fA536F12AF5`](https://sepolia.etherscan.io/address/0xB95Ffa7b970B1a73488e2fC32B787fA536F12AF5) |
| evilBaseFee | [`0xE1AAa4E88DB9cc7ceCca14722eE2874D834e0310`](https://sepolia.etherscan.io/address/0xE1AAa4E88DB9cc7ceCca14722eE2874D834e0310) |
| evilDrain | [`0x1d98D64BC5204AE139B5A0747855841Fa5333b6d`](https://sepolia.etherscan.io/address/0x1d98D64BC5204AE139B5A0747855841Fa5333b6d) |
| paused | [`0xb6573006fB607E96966d0F578B96AAB25413F5BE`](https://sepolia.etherscan.io/address/0xb6573006fB607E96966d0F578B96AAB25413F5BE) |
| forwarder (Chainlink MockKeystoneForwarder) | [`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`](https://sepolia.etherscan.io/address/0x15fC6ae953E024d975e77382eEeC56A9101f9F88) |

Cooldown: 25 blocks (about 5 minutes at 12 s per block).

| # | Proposal | Proposed (block) | CRE verdict | Landed (block) | Blocks after the proposal |
|---|---|---|---|---|---|
| 1 | EvilMint: anyone can mint | [11950735](https://sepolia.etherscan.io/tx/0x862c5fdf826a8fef09fe2ff278d3e58191f93c267dbdd38ad9aaa270f39937b0) | Veto R1_TOTAL_SUPPLY | [11950736](https://sepolia.etherscan.io/tx/0xb0d74e25e2528fb9aad7d21de202dac288cd256048f2986b5214280fda4b84f6) | 1 |
| 2 | EvilDrain: anyone can move a holder's tokens | [11950737](https://sepolia.etherscan.io/tx/0x0e52369921040eb0c901ac3a077aff762d370b4efd9503a52c91360d56366b16) | Veto R3B_THIRD_PARTY_FUNDS | [11950740](https://sepolia.etherscan.io/tx/0x40bbe374a8cee47a94da977f973cf66a67573c12bc84117483fcbd11430f90cb) | 3 |
| 3 | EvilBaseFee: honest only while simulated | [11950742](https://sepolia.etherscan.io/tx/0x3c29c118ca395ca92500abcaae6126244924fbd8e14f846af57b70f113cad6e1) | Veto R9_NEW_OPCODES (BASEFEE) | [11950743](https://sepolia.etherscan.io/tx/0xb6db2d832112384287e5a7ccdd086127931360900d09c80645c21eac2bc165db) | 1 |
| 4 | DemoBTC v2: honest upgrade | [11950745](https://sepolia.etherscan.io/tx/0x3cd96ac220391e2b404d35591d1a96808b75256e7c685a414e2ca5a63bc54145) | **Clear** | [11950747](https://sepolia.etherscan.io/tx/0x2c02d2a23016a72509900eb7ce92dabc06b0dd93a2394d076a62d687ce467efb) | 2 |
| 5 | Remove the CRE receiver from the guardians | [11950749](https://sepolia.etherscan.io/tx/0xda2bd1c9dc5f7770da3926358b8da3ffe5a1cd3154b499cafae440387eebb934) | Veto R7_CONFIG_GUARD | [11950750](https://sepolia.etherscan.io/tx/0xaa2f598bdcc7f46727e5456528521e50ac5c1d8e423805042cbf2d10a4c4cdac) | 1 |
| 6 | EvilOwner: anyone can take ownership | [11950788](https://sepolia.etherscan.io/tx/0x32eb22039bd43602e0406b1a8f9a02c5cbcdb5cf2ef1c389919a45d05820da25) | Veto R2_OWNER | [11950790](https://sepolia.etherscan.io/tx/0x49451bee7a2f3351b18992d94b5f89b9ff89cf53be65a937400ab95fb79be551) | 2 |
| 7 | EvilFee: transfers skim 10% | [11950792](https://sepolia.etherscan.io/tx/0xe06924c2e3961ab27d2803c0654b783fc06e52107345bda9bfeff391053fcad3) | Veto R3_TRANSFER_CONSERVATION | [11950794](https://sepolia.etherscan.io/tx/0x01f6055a683e0dabc8f34ae094e5daa5a81ddb11c687aa9c5ac6e30c7a7f3d3b) | 2 |
| 8 | EvilDrain again (the demo video's live take) | [11959564](https://sepolia.etherscan.io/tx/0x39fb5409a55a4b7323d8ddae98c974286f690a2f3ce42c324b52e4c4b9aa632f) | Veto R3B_THIRD_PARTY_FUNDS | [11959565](https://sepolia.etherscan.io/tx/0x253894929e1921e859b49035f4d1ef2877a9a6dee20a5799f2c0a3dc51741093) | 1 |
| 9 | EvilFee: transfers skim 10% (war-room operator mode, 2026-10-23) | [11974409](https://sepolia.etherscan.io/tx/0x049f6341c65173664f4150b1132fc035f9adb1589631da2f69c6b4ad41fbdb3f) | Veto R3_TRANSFER_CONSERVATION | [11974410](https://sepolia.etherscan.io/tx/0x173589f502aeb083234093248acb8121dbc6ac343bdb9579d9420ecf186f3f73) | 1 |
| 10 | EvilMint: anyone can mint (war-room operator mode, 2026-10-23) | [11974623](https://sepolia.etherscan.io/tx/0x70df33382d80c5de1b32f9495d02362f6046752a579e1f882d4eba4709837f4a) | Veto R1_TOTAL_SUPPLY | [11974625](https://sepolia.etherscan.io/tx/0xf220b7164cfccd120434e0f70f3dd635688be31a3ec08ef0db4d825deffc4268) | 2 |

Proposal #4 then executed after the cooldown in block [11950772](https://sepolia.etherscan.io/tx/0x01913c1854b9862763af74ddacd7be23a7f55232af7334714aa8213aa7021890) and the token's `version()` returned "2". `execute` of #1, #2, #3 and #5 reverts with `ProposalVetoed`. #6 and #7 were proposed later in the same run. #8 re-ran the evil-drain card on 2026-10-21 for the demo video; all four providers answered, and the veto landed one block after the proposal. `execute` of #6 to #10 reverts with `ProposalVetoed` as well. The evidence hashes of #9 and #10 are `0x8ecf506241631324224a8781947d235a10f1fc0d87635f476484d0d954e2e905` and `0xb8e037ade33c76d72ce675cae8a10607ffa41c5136585aa0d3c038def774936c`; `cre/veto/tools/check-evidence.ts` recomputes all ten from chain data. The war room's attack picker replays the newest judged proposal of each card (for v2, the newest executed one), so its evil-fee and evil-mint cards now replay #9 and #10.

In the log lines below, 1rpc, the fourth provider, returned errors for #1, #3 and #4 (a remote error, HTTP 429): the other three agreed, the quorum of two held and the verdicts landed; it answered for #8. Proposals after #10 come from later demos (the operator mode or `propose.sh`); `scripts/sepolia/status.sh` or the war room reads them from the chain.

## Workflow log lines (CRE listener on the server)

Lines for #3 and #4 end in `not-accepted (status Pending)`: the workflow's read-back ran before the node it read from showed the report transaction (and a Clear does not change the status). The table above is read from the chain. The workflow now logs this case as `unconfirmed`, and the sweeper re-checks it.

On the `report` lines, `digest` is the EIP-712 verdict digest the attester signed (`AirlockReceiver.verdictDigest`), not the proposal digest. The proposal digest is the `proposalDigest` field of the evidence JSON (shown in full for #8, cut off in the earlier lines) and can be read on chain with `AirlockAdmin.proposalDigest(id)`.

```
Proposed #1 kind 0 target 0x01502c4af90c27f53b2e1293941670c6b761caaa in block 11950735 (tx 0x862c5fdf826a8fef09fe2ff278d3e58191f93c267dbdd38ad9aaa270f39937b0)
#1 providers: publicnode=veto:R1_TOTAL_SUPPLY drpc=veto:R1_TOTAL_SUPPLY thirdweb=veto:R1_TOTAL_SUPPLY 1rpc=error(eth_simulateV1: Remote Error)
#1 simulation veto R1_TOTAL_SUPPLY (quorum of 2; 101 probes over 15 selectors in 2 request(s); R9 opcodes: none) | R1_TOTAL_SUPPLY: 17500000000 -> 680564733841876926926749214881036422912 | R3B_THIRD_PARTY_FUNDS: transferFrom(holde
#1 culprits: 0x40c10f19(addr,big):supply 0x40c10f19(wide):supply
#1 verdict veto R1_TOTAL_SUPPLY (attack simulation, quorum of 2 (provider detail in the node logs))
#1 evidence {"airlockAdmin":"0x28e7aac40560804f480e454bf9c12f50c83b700b","chainId":"11155111","codehash":"0xcfbe77b285f6d2d913d017dfcc2cd18590b9b2ddbd4ab77ab339e4defd701f68","dataHash":"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca
#1 report Veto evidenceHash 0x45243c58d9d1942b28e7330d6e862bbf89439472aa528b9f8719d87f2408609d validUntilBlock 11950810 digest 0x2ad53bbd04aa086f8434ab20c9664384a67f207e90ec1dd3ce3e69c1977096e0
#1 Veto tx 0xb0d74e25e2528fb9aad7d21de202dac288cd256048f2986b5214280fda4b84f6 -> vetoed (status Vetoed)
#2 simulation veto R3B_THIRD_PARTY_FUNDS (quorum of 2; 130 probes over 16 selectors in 2 request(s); R9 opcodes: none) | R3B_THIRD_PARTY_FUNDS: transferFrom(holder, stranger) without allowance; funded-stranger probes -> 3 probe(s)
#2 culprits: 0x20ff430b(h0,a2,s):drained-holder+moved-others-funds 0x20ff430b(h0,a2,p):drained-holder+moved-others-funds 0x20ff430b(h1,a2,s):drained-holder 0x20ff430b(h1,a2,p):moved-others-funds
#2 verdict veto R3B_THIRD_PARTY_FUNDS (attack simulation, quorum of 2 (provider detail in the node logs))
#2 evidence {"airlockAdmin":"0x28e7aac40560804f480e454bf9c12f50c83b700b","chainId":"11155111","codehash":"0x1b3aa02b98d3f818aee0a71e824869c24821e144e016f39ead4d16285f870dd4","dataHash":"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca
#2 report Veto evidenceHash 0x87bee9f177b9b1aad09bd30072ee96b61a324ff76d4b8f69b821611a65945880 validUntilBlock 11950812 digest 0x22c9dfec174f9cf04c251f1c037e6c5ae704e0e26bc6f110de78b92af5d2f102
#2 Veto tx 0x40bbe374a8cee47a94da977f973cf66a67573c12bc84117483fcbd11430f90cb -> vetoed (status Vetoed)
Proposed #3 kind 0 target 0xe1aaa4e88db9cc7cecca14722ee2874d834e0310 in block 11950742 (tx 0x3c29c118ca395ca92500abcaae6126244924fbd8e14f846af57b70f113cad6e1)
#3 providers: publicnode=veto:R9_NEW_OPCODES drpc=veto:R9_NEW_OPCODES thirdweb=veto:R9_NEW_OPCODES 1rpc=error(HTTP 429)
#3 simulation veto R9_NEW_OPCODES (quorum of 2; 101 probes over 15 selectors in 2 request(s); R9 opcodes: BASEFEE) | R9_NEW_OPCODES: allowed: none -> found: BASEFEE
#3 verdict veto R9_NEW_OPCODES (attack simulation, quorum of 2 (provider detail in the node logs))
#3 evidence {"airlockAdmin":"0x28e7aac40560804f480e454bf9c12f50c83b700b","chainId":"11155111","codehash":"0xda10846bb7ef8afea0838c4bdeca3b5a300daeb7566531fbad738e3d8b6c047a","dataHash":"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca
#3 report Veto evidenceHash 0xc738e53302978e8cfeb72d921f8ce832da262d7ed3daf3c78798f3be0b839f38 validUntilBlock 11950817 digest 0x0f3bc5e0b674ae2d753383a360947036c81e727faf65b78a8d406f76fb204af8
#3 Veto tx 0xb6db2d832112384287e5a7ccdd086127931360900d09c80645c21eac2bc165db -> not-accepted (status Pending)
Proposed #4 kind 0 target 0x4d959f981c01e3b81ac6c9a20e84816fe5f6bce3 in block 11950745 (tx 0x3cd96ac220391e2b404d35591d1a96808b75256e7c685a414e2ca5a63bc54145)
#4 providers: publicnode=pass drpc=pass thirdweb=pass 1rpc=error(HTTP 429)
#4 simulation pass (quorum of 2; 130 probes over 16 selectors in 2 request(s); R9 opcodes: none)
#4 verdict pass (attack simulation, quorum of 2 (provider detail in the node logs))
#4 evidence {"airlockAdmin":"0x28e7aac40560804f480e454bf9c12f50c83b700b","chainId":"11155111","codehash":"0xa82c68dea44388a1285d4f08bf1675b4af8571f4cf95a010ca852a5c1f5ff464","dataHash":"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca
#4 report Clear evidenceHash 0xa5927f7593e4c741137809729188b52e9038b45e1e2322357d3619036e569853 validUntilBlock 11950820 digest 0x8c9e231d76834ea081f316c73136e43a93b3b88bc23a5ee118225dc08bd76c4e
#4 Clear tx 0x2c02d2a23016a72509900eb7ce92dabc06b0dd93a2394d076a62d687ce467efb -> not-accepted (status Pending)
Proposed #5 kind 1 target 0xe40d463116f4aa24d5e79776a65ed0f1b088c670 in block 11950749 (tx 0xda2bd1c9dc5f7770da3926358b8da3ffe5a1cd3154b499cafae440387eebb934)
#5 verdict veto R7_CONFIG_GUARD (config change without approval: remove guardian 0xe40d463116f4aa24d5e79776a65ed0f1b088c670)
#5 evidence {"airlockAdmin":"0x28e7aac40560804f480e454bf9c12f50c83b700b","chainId":"11155111","codehash":"0x0000000000000000000000000000000000000000000000000000000000000000","dataHash":"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca
#5 report Veto evidenceHash 0xbd5c85f25ebff132efcb69893adc4819fcdf5cf18d7c5b3608c9cac49cbbbda7 validUntilBlock 11950824 digest 0xad269add9d5d6c528a17ac8b596ede226d03c6be8198f41f0127d818aa3ef65a
Proposed #8 kind 0 target 0x1d98d64bc5204ae139b5a0747855841fa5333b6d in block 11959564 (tx 0x39fb5409a55a4b7323d8ddae98c974286f690a2f3ce42c324b52e4c4b9aa632f)
#8 providers: publicnode=veto:R3B_THIRD_PARTY_FUNDS drpc=veto:R3B_THIRD_PARTY_FUNDS thirdweb=veto:R3B_THIRD_PARTY_FUNDS 1rpc=veto:R3B_THIRD_PARTY_FUNDS
#8 simulation veto R3B_THIRD_PARTY_FUNDS (quorum of 2; 130 probes over 16 selectors in 2 request(s); R9 opcodes: none) | R3B_THIRD_PARTY_FUNDS: transferFrom(holder, stranger) without allowance; funded-stranger probes -> 3 probe(s) with effects, 3 probe(s) drained the holder with no event
#8 culprits: 0x20ff430b(h0,a2,s):drained-holder+moved-others-funds 0x20ff430b(h0,a2,p):drained-holder+moved-others-funds 0x20ff430b(h1,a2,s):drained-holder 0x20ff430b(h1,a2,p):moved-others-funds
#8 verdict veto R3B_THIRD_PARTY_FUNDS (attack simulation, quorum of 2 (provider detail in the node logs))
#8 evidence {"airlockAdmin":"0x28e7aac40560804f480e454bf9c12f50c83b700b","chainId":"11155111","codehash":"0x1b3aa02b98d3f818aee0a71e824869c24821e144e016f39ead4d16285f870dd4","dataHash":"0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470","kind":0,"proposalDigest":"0x12fd30de10c4c9ed4aef94e396973aad47cc94bb4d6bcf24bd67a627aa6c495f","proposalId":"8","proposedBlock":"11959564","proposer":"0x89758238ebc730028017f35360feab0d2abcc2dd","readyBlock":"11959589","rule":"R3B_THIRD_PARTY_FUNDS","schema":"upgrade-airlock/evidence-v2","target":"0x1d98d64bc5204ae139b5a0747855841fa5333b6d","value":"0","verdict":"veto"}
#8 report Veto evidenceHash 0xa6227d0374f1dc56563c753fe277fdf4a60fecc872d5b9a08eb531a5471d0b21 validUntilBlock 11959639 digest 0xee323b95dbd8e1c2dd8a6ad3a29bb4e206f6dedacb960abd8a3860a0f32bdfd2
#8 Veto tx 0x253894929e1921e859b49035f4d1ef2877a9a6dee20a5799f2c0a3dc51741093 -> vetoed (status Vetoed)
```
