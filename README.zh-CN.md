[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文**

# Upgrade Airlock 升级气闸

**Upgrade Airlock 让每一次合约升级都要过两道门。** 外门是按区块计算的冷静期；内门只有在 Chainlink CRE 工作流把新实现放进模拟器、在四家独立的 RPC 服务商上当成攻击者打过一遍，所有结果一致、DON 对判决达成共识，并且一份带签名的**放行（Clear）**报告已经上链之后才会打开。恶意实现拿到的则是一份带签名的**否决（Veto）**，永远无法执行，哪怕攻击者手里握着升级私钥。为 ETH Shenzhen 2026 打造，部署在 Ethereum Sepolia。

## 问题

可升级的代理合约把整个协议押在一把升级私钥上。私钥一旦泄露，攻击步骤很短：部署恶意实现、把代理合约指过去、增发或者掏空资金。这种事已经发生过很多次：

- **PAID Network，2021 年 3 月。** 代理合约所有者的私钥把经过审计的代币代码换成带销毁和铸造函数的版本，攻击者铸出约 5950 万枚 PAID。（[CertiK 事后复盘](https://www.certik.com/blog/paid-network-post-mortem)）
- **Ankr，2022 年 12 月。** 攻击者用泄露的部署者私钥，把 aBNBc 的实现换成不检查权限就能铸币的版本，铸出 60 万亿枚 aBNBc。（[Ankr 官方报告](https://www.ankr.com/blog/the-abnbc-token-report/)）
- **Radiant Capital，2024 年 10 月。** 攻击者控制了 11 个多签签名人中的 3 个，接管借贷池的 provider 合约，并升级借贷池的实现，卷走 5300 多万美元。（[rekt.news](https://rekt.news/radiant-capital-rekt2)）

时间锁只是让攻击者多等一会儿，等待期间没有人有义务去看；把延迟拉长又会挡住紧急修复。Upgrade Airlock 让这段等待真正干活：升级在通过一个独立、去中心化的检查之前不能执行，而这个检查会在每一个提案上自动运行。

## 工作原理

```
 owner 私钥（假设已经泄露）
   │ proposeUpgrade(newImpl, data)
   ▼
 AirlockAdmin ── 发出 Proposed(id, kind, target, codehash, readyBlock) 事件
   │  外门：冷静期 delayBlocks（25 个区块，在 Sepolia 上约 5 分钟）
   │  内门：clearanceOf[id] != 0
   │
   │    Chainlink CRE 工作流（cre/veto）
   │      ├ EVM log trigger 监听 Proposed（另有 cron 定时扫描，每 60 秒）
   │      ├ EVM 读取：提案、审批记录、余额、区块头
   │      ├ node mode，每个 DON 节点：在 4 家 RPC 服务商上做攻击模拟（eth_simulateV1）
   │      ├ 所有结果必须一致，否则从严否决（R6）
   │      ├ DON 对 {verdict, rule} 达成共识
   │      └ 证据哈希 + EIP-712 签名 → report → writeReport → KeystoneForwarder → AirlockReceiver.onReport
   │
   │◄── 放行：clear(id, evidenceHash)　或　否决：veto(id, ruleHash) + attachReason
   ▼
 execute(id)：冷静期已过 且 已放行 且 未被否决 → ProxyAdmin.upgradeAndCall(proxy, newImpl, data)
```

1. **提案。** `AirlockAdmin` 持有 OpenZeppelin `ProxyAdmin` 和代币的 `Ownable`。owner 私钥只能提案：它永远不会是 guardian（守护者）、approver（审批人）或放行预言机。每个提案（升级，或者对气闸本身的修改：guardian、冷静期、紧急暂停目标）都会得到 `readyBlock = block.number + delayBlocks`。升级和紧急暂停的目标必须是普通的合约代码：EIP-7702 委托账户的私钥可以在判决之后把它改指到别处，因此一律拒绝（`DelegatedAccount`）。
2. **判定。** CRE 的 log trigger 在 `Proposed` 时触发。对气闸本身的修改只靠链上读取判定（R7）。升级先过静态规则（R5、R8），再做固定在提案区块的攻击模拟：把代理合约的 ERC-1967 实现槽覆盖成新代码，并让一个全新的陌生地址（由提案区块的哈希推导）看起来像真实用户：它从第二个持有者那里拿到代币，也有 ETH。持有者做一笔转账，陌生地址在没有授权额度的情况下调用 `transferFrom`，然后用五种参数形态调用新字节码里找到的每一个函数选择器。不属于标准代币接口的选择器，还会再用持有者形态的参数调用：有余额的持有者轮流放进前四个参数位置，测试金额放进另一个位置，其余位置填陌生地址或代理合约地址。前后读取总供应量、owner 和每个受监控的余额，每次持有者形态的调用之后立即读取持有者的余额，并检查每一次探测自己发出的事件（R1 到 R4、R3B）。最后扫描新字节码，找出在真实区块和模拟中行为不同的操作码（R9）。
3. **一致。** 每个 DON 节点都在四家服务商上跑模拟。至少两家要返回结果，而且所有结果必须是同一个判决；其他情况一律否决（R6）。随后 DON 对完全相同的 `{verdict, rule}` 达成共识。
4. **报告。** 工作流对规范化的证据 JSON 做哈希，用 attester 私钥（CRE secret）签一份 EIP-712 判决，再通过 forwarder 写入报告。`AirlockReceiver` 检查发送方、时效、签名，以及判决是否绑定到这个提案本身（`proposalDigest`），然后在 `AirlockAdmin` 上调用 `clear`，或者 `veto` + `attachReason`。
5. **执行。** 冷静期结束后任何人都可以调用 `execute(id)`。冷静期内会 revert `TooEarly`，没有放行会 revert `NotCleared`，被否决则 revert `ProposalVetoed`；目标上的代码如果已经不是提案时、也就是被判定的那一份，会 revert `CodehashChanged`。否决永远优先于放行。
6. **定时扫描。** cron trigger 每 60 秒重新检查最新的提案，凡是仍在等待、CRE 还没有判定过的（`oracleJudged`）都会被判定：log trigger 漏掉的事件、大到无法投递的 `Proposed` 事件，或者 approver 手动放行的升级。它的否决优先于那次放行。

所有失败都指向同一个方向。漏掉事件、RPC 宕机、服务商结果不一致或者运行失败，结果都是提案没有放行或者被否决：只会推迟升级，绝不会放升级过去。CRE 完全无法给出结果时，approver 私钥可以附上留存的证据手动放行；CRE 恢复之后，定时扫描仍会判定这个升级，CRE 或 guardian 的否决依然优先。`breakGlass()` 让 owner 或任一 guardian 立刻把代理合约切到事先登记的暂停实现；退出暂停状态则是一次普通升级，同样要过两道门。

**两种模式。** 自动模式是默认值：CRE 用有界的攻击搜索自行放行或否决每一次升级，覆盖有资金的外部调用者、新代码里的每一个选择器，以及把持有者放进每个新函数前四个参数位置的调用。严格模式（R5）再加一道人工审查：每个新实现的 codehash 都必须先经 approver 私钥审批，攻击模拟照样运行（见[两种模式](docs/design.md#two-modes-automatic-and-strict)）。

更多细节：[docs/design.md](docs/design.md)（威胁模型、放行状态机、报告绑定、预算），以及 [cre/README.md](cre/README.md)（工作流本身）。

## Chainlink CRE

CRE 是 Upgrade Airlock 的编排层：工作流是通过内门唯一的自动化途径，从链上触发到链上判决的每一步都由它负责。它用 CRE TypeScript SDK（`@chainlink/cre-sdk` 1.23.0）编写，并用 CRE CLI v1.37.0 编译成 WASM。

| Chainlink 技术 | 位置 | 在这里的作用 |
|---|---|---|
| CRE 工作流 runner | [`cre/veto/main.ts#L1-L9`](cre/veto/main.ts#L1-L9)、[`cre/veto/workflow.yaml`](cre/veto/workflow.yaml)、[`cre/project.yaml`](cre/project.yaml) | 两个 handler，target 为 `sepolia` 和 `sepolia-fork` |
| EVM log trigger | [`cre/veto/workflow.ts#L202-L211`](cre/veto/workflow.ts#L202-L211)、[`#L193-L198`](cre/veto/workflow.ts#L193-L198)、[`#L54-L65`](cre/veto/workflow.ts#L54-L65) | 以 `LATEST` 监听 `AirlockAdmin.Proposed`：提案一出现就判定，比它最早可执行的时间早了整整一个冷静期 |
| Cron trigger | [`cre/veto/workflow.ts#L200`](cre/veto/workflow.ts#L200)、[`#L209`](cre/veto/workflow.ts#L209)、[`cre/veto/airlock.ts#L321-L387`](cre/veto/airlock.ts#L321-L387) | 定时扫描：最新 20 个提案，每分钟一次 |
| EVM 读取（`callContract`） | [`cre/veto/workflow.ts#L114-L122`](cre/veto/workflow.ts#L114-L122)、[`#L137-L142`](cre/veto/workflow.ts#L137-L142)、[`cre/veto/chain.ts`](cre/veto/chain.ts) | 提案、放行、`oracleJudged`、审批记录和余额，通过 Multicall3 批量读取，指定提案区块或 `LATEST` |
| EVM 读取（`headerByNumber`） | [`cre/veto/workflow.ts#L125-L136`](cre/veto/workflow.ts#L125-L136) | 最新区块，以及用来推导模拟陌生地址的提案区块哈希 |
| node mode 下的 HTTP capability | [`cre/veto/workflow.ts#L167-L189`](cre/veto/workflow.ts#L167-L189)、[`#L80-L94`](cre/veto/workflow.ts#L80-L94)、[`cre/veto/judge.ts#L157-L220`](cre/veto/judge.ts#L157-L220) | 每个节点对每家服务商先发 `eth_getCode`，再发一到两个 `eth_simulateV1` 请求（每个都在 120 kb 的请求上限内） |
| `consensusIdenticalAggregation` | [`cre/veto/workflow.ts#L184-L188`](cre/veto/workflow.ts#L184-L188)，quorum 检查在 [`cre/veto/judge.ts#L244-L277`](cre/veto/judge.ts#L244-L277) | DON 对 `{verdict, rule}` 达成共识（最多 52 字节） |
| Secrets | [`cre/veto/workflow.ts#L160-L166`](cre/veto/workflow.ts#L160-L166)、[`cre/secrets.yaml`](cre/secrets.yaml) | EIP-712 attester 私钥，每次运行只取一次 |
| Report + `writeReport` | [`cre/veto/workflow.ts#L143-L149`](cre/veto/workflow.ts#L143-L149)、[`cre/veto/airlock.ts#L229-L280`](cre/veto/airlock.ts#L229-L280)、[`cre/veto/report.ts`](cre/veto/report.ts) | `runtime.report`（ECDSA、keccak256）和 `evm.writeReport`，之后再读回提案确认结果 |
| Forwarder + `IReceiver` | [`src/cre/AirlockReceiver.sol#L88-L120`](src/cre/AirlockReceiver.sol#L88-L120)、[`#L156-L169`](src/cre/AirlockReceiver.sol#L156-L169)、[`src/cre/IReceiver.sol`](src/cre/IReceiver.sol)、[`script/DeployEth.s.sol#L35`](script/DeployEth.s.sol#L35) | `onReport` 只接受配置好的 forwarder，配置了的话还会检查 workflow id 和 owner |
| Chain selectors | [`cre/veto/workflow.ts#L100-L104`](cre/veto/workflow.ts#L100-L104) | `ethereum-testnet-sepolia` |
| CRE CLI | [`cre/setup.sh`](cre/setup.sh)、[`cre/scripts/fork-e2e.sh`](cre/scripts/fork-e2e.sh)、[`scripts/sepolia/airlock.sh`](scripts/sepolia/airlock.sh)、[`scripts/sepolia/sweep.sh`](scripts/sepolia/sweep.sh) | `cre workflow build`、`cre workflow simulate --broadcast` |

**工作流现在的运行方式。** 工作流通过 CRE CLI 的 `cre workflow simulate --broadcast` 对 Ethereum Sepolia 运行。监听器（[`scripts/sepolia/airlock.sh`](scripts/sepolia/airlock.sh)）让 log trigger 保持在 listen 模式，定时扫描（[`scripts/sepolia/sweep.sh`](scripts/sepolia/sweep.sh)）每分钟运行一次 cron handler，每一笔放行和否决都是一笔真实的 Sepolia 交易，经过 Chainlink 在 Sepolia 上的 MockKeystoneForwarder [`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts)。`AirlockReceiver` 不用改就能接上 DON 部署：部署时把 `FORWARDER` 设为正式的 KeystoneForwarder，并设置 `WORKFLOW_ID` / `WORKFLOW_OWNER`，`onReport` 就会同时检查 DON 签名的工作流 metadata。除非这两项都已设置，或者用 `ALLOW_MOCK_FORWARDER=1` 明确允许，`DeployEth` 会拒绝没有权限控制的 MockKeystoneForwarder（[`script/DeployEth.s.sol#L98`](script/DeployEth.s.sol#L98)）。

工作流在设计上就待在 CRE 每次运行的限额之内：最多 15 次链上读取（Multicall3 批量，低于 5 kb 的 payload 上限）、四家服务商用掉 15 次 HTTP 调用中的 12 次、每次运行最多一次攻击模拟、共识值最多 52 字节。完整预算见 [docs/design.md](docs/design.md#budgets)。

## 规则

`ruleHash = keccak256("GUARD/<ID>")`，每次否决都会记录在链上。

| 规则 | 何时否决 | 判定方式 |
|---|---|---|
| R1 `TOTAL_SUPPLY` | 陌生地址的调用改变了 `totalSupply` | 攻击模拟 |
| R2 `OWNER` | 陌生地址的调用改变了 `owner()` | 攻击模拟 |
| R3 `TRANSFER_CONSERVATION` | 持有者转出 X 时，实际转走的不是正好 X，或者动了其他人的余额 | 攻击模拟 |
| R3B `THIRD_PARTY_FUNDS` | 外人动了任何持有者的代币：有资金的陌生地址无需授权就能用 `transferFrom` 转走持有者的资金，或者它的某次探测动了别人的代币、铸币、销毁、转移所有权，或让持有者的余额变少；即使没有发出事件、或之后的调用又改回来也一样 | 攻击模拟 |
| R4 `TRANSFER_LIVENESS` | 持有者的普通转账失败 | 攻击模拟 |
| R5 `STRICT_CODEHASH` | 开启严格模式，且 approver 没有审批这个 codehash | 链上读取 |
| R6 `SIM_FAILURE` | 模拟无法下结论：服务商结果不一致、返回太少、代码不匹配、view 调用或陌生地址的注资转账 revert，或者探测塞不进配置的请求数 | 模拟与 quorum 检查 |
| R7 `CONFIG_GUARD` | 修改 guardian、缩短冷静期或更换紧急暂停目标，却没有 approver 的事先审批 | 链上读取 |
| R8 `INIT_DATA` | 升级带有初始化数据，而 approver 没有连同 codehash 一起审批 | 链上读取 |
| R9 `NEW_OPCODES` | 新代码含有配置中固定允许清单（默认为空）没有覆盖的区块或交易上下文操作码（BASEFEE、TIMESTAMP、NUMBER、ORIGIN、GAS 等）、外部调用、create 或 selfdestruct，除非 approver 审批了这个 codehash 本身 | 字节码 |

R9 堵住的是模拟规避。`EvilBaseFeeImpl` 在 `block.basefee == 0`（也就是 `eth_simulateV1` 看到的情况）时表现得和 v1 一模一样，到了真实区块却让任何人都能铸币。所有模拟中的不变量都会通过，而它的 `BASEFEE` 操作码让它被否决。允许清单从不取决于代理合约当前运行的代码，所以一次审批只覆盖一个 codehash，不会延伸到之后的升级。扫描只在编译器的 metadata 尾段是完全符合 solc 格式的 CBOR、而且没有任何指令能执行到它时才跳过；其他情况一律当作代码扫描。审批 codehash 只让它免于 R9、并容许探测被截断（R6），仅此而已：其他规则照常执行。

R3B 堵住的是悄悄掏空。`EvilDrainImpl` 就是 v1 加上一个没有权限控制的 `rescue(from, to, amount)`。总供应量、owner、转账和操作码都和 v1 相同，所以 R1 到 R4 和 R9 全部通过。`rescue` 不是标准的代币函数，所以陌生地址还会用持有者形态的参数调用它；把持有者当作 `from` 的那次调用转走了持有者的代币，R3B 因此否决它。只对“持有代币或 ETH 的调用者”开放的掏空也躲不掉，因为陌生地址两样都有。

## Sepolia 部署

Ethereum Sepolia，chain id 11155111。用 [`script/DeployEth.s.sol`](script/DeployEth.s.sol) 部署于区块 PENDING。

| 合约 | 地址 |
|---|---|
| AirlockAdmin | PENDING |
| AirlockReceiver | PENDING |
| DemoBTC 代理合约（dBTC） | PENDING |
| ProxyAdmin | PENDING |
| DemoBTC v1 | PENDING |
| DemoBTC v2（正常升级） | PENDING |
| EvilMintImpl | PENDING |
| EvilOwnerImpl | PENDING |
| EvilFeeImpl | PENDING |
| EvilBaseFeeImpl | PENDING |
| EvilDrainImpl | PENDING |
| PausedImpl（紧急暂停目标） | PENDING |
| Chainlink MockKeystoneForwarder | [`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`](https://sepolia.etherscan.io/address/0x15fC6ae953E024d975e77382eEeC56A9101f9F88) |

| 卡片 | 提案 | CRE 判决 | 提案交易 | 报告交易 | 之后 |
|---|---|---|---|---|---|
| `v2`：正常升级 | PENDING | 放行 | PENDING | PENDING | `execute` PENDING，`version()` = "2" |
| `evil-mint`：任何人都能铸币 | PENDING | 否决 R1 | PENDING | PENDING | `execute` revert `ProposalVetoed` |
| `evil-owner`：任何人都能抢走所有权 | PENDING | 否决 R2 | PENDING | PENDING | `execute` revert `ProposalVetoed` |
| `evil-fee`：转账暗扣 10% | PENDING | 否决 R3 | PENDING | PENDING | `execute` revert `ProposalVetoed` |
| `evil-basefee`：真实区块上放开铸币 | PENDING | 否决 R9 | PENDING | PENDING | `execute` revert `ProposalVetoed` |
| `evil-drain`：任何人都能转走持有者的代币 | PENDING | 否决 R3B | PENDING | PENDING | `execute` revert `ProposalVetoed` |
| `remove-receiver`：把 CRE 从 guardian 中移除 | PENDING | 否决 R7 | PENDING | PENDING | `execute` revert `ProposalVetoed` |

## 运行

需要 [Foundry](https://getfoundry.sh)、`jq`、Node 22，以及模拟器要用的 CRE 账号。`cre/setup.sh` 会把 CRE CLI v1.37.0（锁定 SHA-256）和 bun 1.4.2 安装到 `cre/.tools`。

```bash
git clone https://github.com/jiapunk/upgrade-airlock.git
cd upgrade-airlock

# 合约（OpenZeppelin 和 forge-std 已放在 lib/）
forge build                     # 首次会下载锁定版本的 solc 0.8.37
forge test --offline            # 117 个测试

# CRE 工作流
cre/setup.sh
export PATH="$PWD/cre/.tools/bin:$PWD/cre/.tools/node_modules/.bin:$PATH"
(cd cre/veto && bun test && bun run typecheck)    # 118 个测试：规则、探测、字节码、报告字节、预算、两个 handler

# 在本地 anvil 分叉的 Sepolia 上端到端运行：不会向真实网络发送任何交易
cre login                       # 只需一次；模拟器需要 CRE 账号
cre/scripts/fork-e2e.sh
```

`cre/scripts/fork-e2e.sh` 会在分叉链上部署整套合约，用 CRE 模拟器加 `--broadcast` 运行工作流，并在链上检查每一个结果：

- log trigger：EvilMint 以 R1 否决、EvilOwner R2、EvilFee R3、EvilBaseFee R9（点名 `BASEFEE`）、EvilDrain R3B（点名 `rescue`，其他规则全部通过）；另外七种掏空手法也只以 R3B 否决：参数顺序重排、检查 token 地址的守卫、只对持有代币或 ETH 的调用者开放、不发出 `Transfer` 事件，以及对持有代币者跳过授权检查的 `transferFrom`；正常的 v2 被放行，冷静期后执行；把 receiver 从 guardian 中移除的提案以 R7 否决；经 approver 事先审批的缩短冷静期被放行；
- 定时扫描：没人判定过的升级在冷静期后 revert `NotCleared`，一次扫描就放行并可以执行；approver 手动放行的两个提案在下一次扫描中被判定：EvilDrain 以 R3B 否决（否决优先于放行），延长冷静期则再由 CRE 放行；带 6 KB 初始化数据的升级在再下一次扫描中以 R8 否决；
- 每个被否决的提案都 revert `ProposalVetoed`，每个判决的证据哈希都能只靠链上数据重新算出（[`cre/veto/tools/check-evidence.ts`](cre/veto/tools/check-evidence.ts)）。

**战情室。** `cd web && npm ci && npm run dev`，打开 `http://127.0.0.1:5173/`。它直接读 Sepolia（只读），把每个提案画成一座气闸：冷静期、CRE 放行、否决及其规则和证据。`?mode=offline` 完全不联网，播放录好的一轮；`?lang=en|zh-TW|zh-CN` 切换语言。

**Sepolia 运维工具包**（[`scripts/sepolia/`](scripts/sepolia/README.md)）。私钥放在仓库之外，在 `KEY_DIR` 里一个文件一把十六进制私钥（`owner`、`attester`、`sender`、`approver`、`emergency`）；脚本从不打印私钥，而且 owner、approver、紧急 guardian 和 attester 必须是四把不同的私钥，否则 `deploy.sh` 拒绝部署。每个脚本也都能加上 `FORK=<port>` 对本地分叉链运行，整套演示可以零成本彩排。

```bash
scripts/sepolia/deploy.sh                    # 13 笔交易，写出 deployments/sepolia.json（FORCE=1 会替换已有文件）
bun scripts/sepolia/make-config.mjs          # 工作流配置：4 家服务商，quorum 2
scripts/sepolia/fund-sender.sh 0.05          # 支付报告交易的 ETH
scripts/sepolia/airlock.sh                   # 终端 A：CRE 监听器（log trigger）
scripts/sepolia/propose.sh v2                # 终端 B：接着 evil-mint、evil-owner、evil-fee、evil-basefee、evil-drain、remove-receiver
scripts/sepolia/execute.sh <id>              # 冷静期后执行已放行的提案，否则显示 revert 原因
scripts/sepolia/status.sh                    # 每个提案的判决、CRE 是否已判定、规则、证据和交易
```

`sweep.sh` 运行一次 cron 定时扫描，`clear.sh` 是 approver 的手动放行，`fork.sh` 启动、保存、恢复 Sepolia 分叉链，`probe-rpcs.ts` 用工作流自己的判定代码检查每家服务商，`systemd/` 则在 Linux 服务器上常驻监听器和定时扫描。

## 仓库结构

```
src/AirlockAdmin.sol            两道门：提案、冷静期、guardian 否决、放行、执行、breakGlass
src/cre/AirlockReceiver.sol     CRE 报告接收合约：forwarder、工作流 metadata、EIP-712 签名、digest 绑定
src/cre/IReceiver.sol           Chainlink CRE 接收接口
src/DemoBTC.sol, DemoBTCV2.sol  演示代币（dBTC）v1 和正常的 v2
src/PausedImpl.sol              紧急暂停目标：任何余额变动都会 revert
src/attack/                     EvilMintImpl、EvilOwnerImpl、EvilFeeImpl、EvilBaseFeeImpl、EvilDrainImpl
script/DeployEth.s.sol          部署脚本（13 笔交易），检查角色、forwarder 和部署后的接线
test/                           Foundry 测试
cre/veto/                       CRE 工作流：workflow.ts（capability）、airlock.ts（handler）、judge.ts（规则、
                                quorum）、simulate.ts（eth_simulateV1）、bytecode.ts（选择器、R9）、report.ts
                                （报告、EIP-712、证据）、chain.ts（读取预算）、keys.ts、rules.ts、config.ts
cre/veto/test/                  Bun 单元测试
cre/veto/tools/                 check-evidence.ts：重新计算每个链上证据哈希
cre/scripts/fork-e2e.sh         在 anvil 分叉的 Sepolia 上端到端运行
cre/setup.sh                    锁定版本的 CRE CLI 和 bun
scripts/sepolia/                现场演示用的运维工具包
web/                            战情室（Vite、TypeScript）
deployments/                    部署结果 JSON
docs/                           设计说明和录下的运行记录
```

## 使用的 AI 工具

Upgrade Airlock 是在作者的指导下，用 [Claude Code](https://claude.com/claude-code) 打造的：合约、CRE 工作流、测试、脚本、战情室和这些文档，都是用它编写并验证的。

## 许可证

[MIT](LICENSE) © 2026 jiapunk
