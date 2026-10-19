# Live run on Ethereum Sepolia, 2026-10-19

Deployment from commit `6c3ad22` (`script/DeployEth.s.sol`, `FOUNDRY_PROFILE=eth`, `--skip-simulation`), all contracts verified on Sourcify with `exact_match`. The CRE workflow ran with `cre workflow simulate -T sepolia --broadcast` (`--evm-tx-hash` replay for #1, `--listen` for #2-#4), built from the MIT-licensed CRE CLI v1.37.0 with the login check removed (development build); the workflow code, engine and on-chain path are the same as with the official binary.

| Contract | Address |
|---|---|
| guardedAdmin | [`0x1FCb12d8E6e62C18F591f8e713287d47A0B1481B`](https://sepolia.etherscan.io/address/0x1FCb12d8E6e62C18F591f8e713287d47A0B1481B) |
| receiver | [`0x56bf513101B2f9Be8e5196Ee59a3a28fc1B8EA3c`](https://sepolia.etherscan.io/address/0x56bf513101B2f9Be8e5196Ee59a3a28fc1B8EA3c) |
| proxy | [`0xAf214cd9d7b2DC4E63132C9Cc7D557dE1f2F63C6`](https://sepolia.etherscan.io/address/0xAf214cd9d7b2DC4E63132C9Cc7D557dE1f2F63C6) |
| proxyAdmin | [`0xC62B1F2347376a5dE339079dB7C9433179C35775`](https://sepolia.etherscan.io/address/0xC62B1F2347376a5dE339079dB7C9433179C35775) |
| v1 | [`0xD178E0e314102A15E404A16117E102449eba6799`](https://sepolia.etherscan.io/address/0xD178E0e314102A15E404A16117E102449eba6799) |
| v2 | [`0x2C6a6b1f477c1e11fD0C9F1B2573c845a6d95810`](https://sepolia.etherscan.io/address/0x2C6a6b1f477c1e11fD0C9F1B2573c845a6d95810) |
| evilMint | [`0x41b4fbc0431331932eBf2fB399a1C02d3eAb3d7d`](https://sepolia.etherscan.io/address/0x41b4fbc0431331932eBf2fB399a1C02d3eAb3d7d) |
| evilOwner | [`0x660b20d54BeE87C81FbD4E83f3333b5B827ECAEA`](https://sepolia.etherscan.io/address/0x660b20d54BeE87C81FbD4E83f3333b5B827ECAEA) |
| evilFee | [`0x5bD86b6E400eE6a0fB48e0c52604DB84C6A2F535`](https://sepolia.etherscan.io/address/0x5bD86b6E400eE6a0fB48e0c52604DB84C6A2F535) |
| paused | [`0xF853eFAD7Aa26AEF9C19Df8e10344130e4144e21`](https://sepolia.etherscan.io/address/0xF853eFAD7Aa26AEF9C19Df8e10344130e4144e21) |
| forwarder (Chainlink MockKeystoneForwarder) | [`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`](https://sepolia.etherscan.io/address/0x15fC6ae953E024d975e77382eEeC56A9101f9F88) |

Cooldown: 25 blocks (about 5 minutes at 12 s per block).

| # | Upgrade | Proposed (block) | CRE verdict | Providers | Outcome (block) | Blocks after proposal |
|---|---|---|---|---|---|---|
| 1 | EvilMint: anyone can mint | [11945711](https://sepolia.etherscan.io/tx/0x2d278b0e6803f8e1db3f4ba89095fef0611b242fee27b8ddceeef964f2d2fde0) | veto R1_TOTAL_SUPPLY | publicnode veto, drpc veto, 1rpc HTTP 429 | [vetoed 11945713](https://sepolia.etherscan.io/tx/0x870d5238252d139a107a03c9136422d277714e7340dd6249e709ac19253bfc80) | 2 |
| 2 | EvilFee: transfer skims 10% | [11945716](https://sepolia.etherscan.io/tx/0x929c7594cf34c264c4ab0653ff3b94c0596d84148e290fc5f1b1bfb0f1680720) | veto R3_TRANSFER_CONSERVATION | publicnode veto, drpc veto, 1rpc timeout | [vetoed 11945719](https://sepolia.etherscan.io/tx/0xc7928dbad5ab365e4c9b1ce3525d17b95150f581d2db633a6a4c0f7c3f71ce83) | 3 |
| 3 | DemoBTC v2: honest | [11945720](https://sepolia.etherscan.io/tx/0x318492bc5918da1a7953a129a41263ee772f0934425457a80aebc5fc5dded530) | pass | publicnode pass, drpc pass, 1rpc HTTP 429 | [executed 11945746](https://sepolia.etherscan.io/tx/0x56f5a59c3d5ec3f462b8347331ff5af75287a0892386ba65c361279d94c872e9), `version()` = "2" | 26 |
| 4 | EvilOwner: anyone can take ownership | [11945752](https://sepolia.etherscan.io/tx/0xf5c4122437765d94f7143aecf690fc49ce66a16912c33c98871a0f0bac06bd7f) | veto R2_OWNER | publicnode, drpc, thirdweb, 1rpc: all veto | [vetoed 11945754](https://sepolia.etherscan.io/tx/0x7f3ed1e53436c6c34c3505813081bdbe58729c7111e9ea47a5ba78cdc76bd2dc) | 2 |

After the run, `execute(1)` and `execute(2)` revert with `ProposalVetoed`, and `totalSupply()` is unchanged at 175 dBTC.

Gas on Sepolia (Amsterdam rules): `proposeUpgrade` 593,654; a CRE veto through the forwarder (`onReport` -> `veto` + `attachReason`) about 400,300; `execute` 65,728. Gas price was 15-17 wei.

1rpc failed three times out of three in the first runs (HTTP 429 or timeout). Proposals #1-#3 still reached the quorum with two providers; from #4 on, the provider set is publicnode, drpc, thirdweb and 1rpc, and every answering provider must agree (`cre/veto/judge.ts`).

## Official CRE CLI run (2026-10-19 14:46 UTC)

The same workflow, run with the **official** CRE CLI v1.37.0 (release binary, SHA-256 pinned in `cre/setup.sh`) under a
logged-in CRE account, on a small Linux server:

```bash
cre workflow simulate ./veto -T sepolia --non-interactive --trigger-index 0 \
  --evm-tx-hash 0xd7ce10b4303f41704ac5c68bd41ecdee035c4bd1876c238dbdad336fc8accb67 --evm-event-index 0 --broadcast
```

| # | Upgrade | Proposed (block) | CRE verdict | Providers | Outcome (block) |
|---|---|---|---|---|---|
| 5 | EvilMint | [11948854](https://sepolia.etherscan.io/tx/0xd7ce10b4303f41704ac5c68bd41ecdee035c4bd1876c238dbdad336fc8accb67) | veto R1_TOTAL_SUPPLY | publicnode, drpc, thirdweb veto; 1rpc HTTP 429 | [vetoed 11948857](https://sepolia.etherscan.io/tx/0x5b13abc4b8d6673ab5462cde529607917e3ab03df6d2efeceab427cfe82e69dc) |

Full output: [`official-cli-sepolia-2026-10-19.log`](official-cli-sepolia-2026-10-19.log) (workflow binary hash
`d1a5e3ef…784a`). The simulator ends with `context canceled` before it prints the workflow's last log line (the
veto transaction); the result JSON and the on-chain `Vetoed` event show the veto.

## Workflow log lines

```
#1 providers: publicnode=veto:R1_TOTAL_SUPPLY drpc=veto:R1_TOTAL_SUPPLY 1rpc=error(HTTP 429)
#1 verdict veto R1_TOTAL_SUPPLY (quorum of 2; 77 probes over 15 selectors) | R1_TOTAL_SUPPLY: 17500000000 -> 680564733841876926926749214881036422912
#1 evidence 0x46eb2f1e8f7405403039de603b28f835c9f3add04e66c631e75b8ce238d72ad1 validUntilBlock 11945786 digest 0x2be5f38eaf358ac5469244141e9778d02356f86a9cb23ca5fa531bd95f4bafe0
#1 veto tx 0x870d5238252d139a107a03c9136422d277714e7340dd6249e709ac19253bfc80 -> status 2 (vetoed)
#2 providers: publicnode=veto:R3_TRANSFER_CONSERVATION drpc=veto:R3_TRANSFER_CONSERVATION 1rpc=error([2]Unknown: Post "https://1rpc.io/sepolia": context deadline exceeded)
#2 verdict veto R3_TRANSFER_CONSERVATION (quorum of 2; 77 probes over 15 selectors) | R3_TRANSFER_CONSERVATION: receiver+100000000 -> receiver+90000000
#2 evidence 0x6e308d2afb67887ad90bd595104205230a184f164620dfbb9fd7b49a32487402 validUntilBlock 11945791 digest 0x174b3b868f5ce1d446666bc18b9fd73f42571371b02a6e2f8212a52b87adee5b
#2 veto tx 0xc7928dbad5ab365e4c9b1ce3525d17b95150f581d2db633a6a4c0f7c3f71ce83 -> status 2 (vetoed)
#3 providers: publicnode=pass drpc=pass 1rpc=error(HTTP 429)
#3 verdict pass (quorum of 2; 82 probes over 16 selectors)
#4 providers: publicnode=veto:R2_OWNER drpc=veto:R2_OWNER thirdweb=veto:R2_OWNER 1rpc=veto:R2_OWNER
#4 verdict veto R2_OWNER (quorum of 2; 82 probes over 16 selectors) | R1_TOTAL_SUPPLY: 17500000000 -> 680564733841876926926749214881036422912 | R2_OWNER: 0x1fcb12d8e6e62c18f591f8e713287d47a0b1481b -> 0x0000000000000000000000000000000000000000
#4 evidence 0xcaa69cc00d2724b903fed0a8c0e6e9ce99acc2d009bb80b22b1ab441280bb7a7 validUntilBlock 11945827 digest 0xe0db02231d8252354e38a8070d2042ea731a21b98711f7bb8e9e41f7629d648e
#4 veto tx 0x7f3ed1e53436c6c34c3505813081bdbe58729c7111e9ea47a5ba78cdc76bd2dc -> status 2 (vetoed)
```
