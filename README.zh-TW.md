[English](README.md) · **繁體中文** · [简体中文](README.zh-CN.md)

# Upgrade Airlock 升級氣閘

**Upgrade Airlock 讓每一次合約升級都要通過兩道門。** 外門是以區塊計算的冷靜期；內門只有在 Chainlink CRE 工作流程把新實作放進模擬器、在四家獨立的 RPC 供應商上當成攻擊者打過一遍，所有回答一致、DON 對判決取得共識，而且一份經過簽章的**放行（Clear）**報告已經上鏈之後才會打開。惡意實作拿到的則是一份簽章過的**否決（Veto）**，永遠無法執行，就算攻擊者手上握有升級金鑰也一樣。為 ETH Shenzhen 2026 打造，部署在 Ethereum Sepolia。

## 問題

可升級的代理合約把整個協定押在一把升級金鑰上。金鑰一旦外洩，攻擊步驟很短：部署惡意實作、把代理合約指過去、鑄幣或掏空資金。這種事已經發生過很多次：

- **PAID Network，2021 年 3 月。** 代理合約擁有者的金鑰把經過稽核的代幣程式碼換成帶有銷毀與鑄造函式的版本，攻擊者鑄出約 5,950 萬枚 PAID。（[CertiK 事後分析](https://www.certik.com/blog/paid-network-post-mortem)）
- **Ankr，2022 年 12 月。** 攻擊者用外洩的部署者金鑰，把 aBNBc 的實作換成不檢查權限就能鑄幣的版本，鑄出 60 兆枚 aBNBc。（[Ankr 官方報告](https://www.ankr.com/blog/the-abnbc-token-report/)）
- **Radiant Capital，2024 年 10 月。** 攻擊者控制 11 位多簽簽署人中的 3 位，接管借貸池的 provider 合約，並升級借貸池的實作，掏走超過 5,300 萬美元。（[rekt.news](https://rekt.news/radiant-capital-rekt2)）

時間鎖只是讓攻擊者多等一下，等待期間沒有人有義務去看；拉長延遲又會擋住緊急修補。Upgrade Airlock 讓這段等待真正做事：升級在通過一個獨立、去中心化的檢查之前不能執行，而這個檢查會在每一個提案上自動執行。

## 運作方式

```
 owner 金鑰（假設已經外洩）
   │ proposeUpgrade(newImpl, data)
   ▼
 AirlockAdmin ── 發出 Proposed(id, kind, target, codehash, readyBlock) 事件
   │  外門：冷靜期 delayBlocks（25 個區塊，在 Sepolia 上約 5 分鐘）
   │  內門：clearanceOf[id] != 0
   │
   │    Chainlink CRE 工作流程（cre/veto）
   │      ├ EVM log trigger 監聽 Proposed（另有 cron 定時掃描，每 60 秒）
   │      ├ EVM 讀取：提案、核准紀錄、餘額、區塊標頭
   │      ├ node mode，每個 DON 節點：在 4 家 RPC 供應商上做攻擊模擬（eth_simulateV1）
   │      ├ 所有回答必須一致，否則保守否決（R6）
   │      ├ DON 對 {verdict, rule} 取得共識
   │      └ 證據雜湊 + EIP-712 簽章 → report → writeReport → KeystoneForwarder → AirlockReceiver.onReport
   │
   │◄── 放行：clear(id, evidenceHash)　或　否決：veto(id, ruleHash) + attachReason
   ▼
 execute(id)：冷靜期已過 且 已放行 且 未被否決 → ProxyAdmin.upgradeAndCall(proxy, newImpl, data)
```

1. **提案。** `AirlockAdmin` 持有 OpenZeppelin `ProxyAdmin` 以及代幣的 `Ownable`。owner 金鑰只能提案：它永遠不會是 guardian（守護者）、approver（核准人）或放行預言機。每個提案（升級，或是對氣閘本身的變更：guardian、冷靜期、緊急暫停目標）都會得到 `readyBlock = block.number + delayBlocks`。升級和緊急暫停的目標必須是一般的合約程式碼：EIP-7702 委派帳戶的金鑰可以在判決之後把它改指到別處，因此一律拒絕（`DelegatedAccount`）。
2. **判定。** CRE 的 log trigger 在 `Proposed` 時觸發。對氣閘本身的變更只靠鏈上讀取判定（R7）。升級先過靜態規則（R5、R8），再進行固定於提案區塊的攻擊模擬：把代理合約的 ERC-1967 實作槽覆寫成新程式碼，並讓一個全新的陌生地址（由提案區塊的雜湊推導）看起來像真實用戶：它從第二位持有人那裡拿到代幣，也有 ETH。持有人做一筆轉帳，陌生地址在沒有授權額度的情況下呼叫 `transferFrom`，接著用五種參數形狀呼叫新位元組碼裡找到的每一個函式選擇器。不屬於標準代幣介面的選擇器，還會再以持有人形狀的參數呼叫：有餘額的持有人輪流放進前四個參數欄位，測試金額放進另一欄，其餘欄位填陌生地址或代理合約地址。前後讀取總供給量、owner 和每個受監看的餘額，每次持有人形狀的呼叫之後立刻讀取持有人的餘額，並檢查每一次探測自己發出的事件（R1 到 R4、R3B）。最後掃描新位元組碼，找出在真實區塊和模擬中會有不同行為的操作碼（R9）。
3. **一致。** 每個 DON 節點都在四家供應商上跑模擬。至少要有兩家回答，而且所有回答必須是同一個判決；其他情況一律否決（R6）。接著 DON 對完全相同的 `{verdict, rule}` 取得共識。
4. **報告。** 工作流程把正規化的證據 JSON 做雜湊，用 attester 金鑰（CRE secret）簽一份 EIP-712 判決，再透過 forwarder 寫入報告。`AirlockReceiver` 檢查發送者、時效、簽章，以及判決是否綁定到這個提案本身（`proposalDigest`），然後在 `AirlockAdmin` 上呼叫 `clear`，或 `veto` + `attachReason`。
5. **執行。** 冷靜期結束後任何人都可以呼叫 `execute(id)`。冷靜期內會 revert `TooEarly`，沒有放行會 revert `NotCleared`，被否決則 revert `ProposalVetoed`；目標上的程式碼若已不是提案時、也就是被判定的那一份，會 revert `CodehashChanged`。否決永遠優先於放行。
6. **定時掃描。** cron trigger 每 60 秒重新檢查最新的提案，凡是仍在等待、CRE 還沒有判定過的（`oracleJudged`）都會被判定：log trigger 漏掉的事件、大到無法投遞的 `Proposed` 事件，或是 approver 手動放行的升級。它的否決優先於那次放行。

所有失敗都指向同一個方向。漏掉的事件、RPC 斷線、供應商意見不一或執行失敗，結果都是提案沒有放行或被否決：只會延後升級，絕不會讓升級通過。CRE 完全無法回應時，approver 金鑰可以附上留存的證據手動放行；CRE 恢復回應後，定時掃描仍會判定這個升級，CRE 或 guardian 的否決依然優先。`breakGlass()` 讓 owner 或任一 guardian 立刻把代理合約切到事先登記的暫停實作；離開暫停狀態則是一次普通的升級，一樣要過兩道門。

**兩種模式。** 自動模式是預設值：CRE 以有界的攻擊搜尋自行放行或否決每一次升級，涵蓋有資金的外部呼叫者、新程式碼裡的每一個選擇器，以及把持有人放進每個新函式前四個參數欄位的呼叫。嚴格模式（R5）再加上一道人工審查：每個新實作的 codehash 都必須先經 approver 金鑰核准，攻擊模擬照樣執行（見[兩種模式](docs/design.md#two-modes-automatic-and-strict)）。

更多細節：[docs/design.md](docs/design.md)（威脅模型、放行狀態機、報告綁定、預算），以及 [cre/README.md](cre/README.md)（工作流程本身）。

## Chainlink CRE

CRE 是 Upgrade Airlock 的編排層：工作流程是通過內門唯一的自動化途徑，從鏈上觸發到鏈上判決的每一步都由它負責。它以 CRE TypeScript SDK（`@chainlink/cre-sdk` 1.23.0）撰寫，並用 CRE CLI v1.37.0 編譯成 WASM。

| Chainlink 技術 | 位置 | 在這裡的用途 |
|---|---|---|
| CRE 工作流程 runner | [`cre/veto/main.ts#L1-L9`](cre/veto/main.ts#L1-L9)、[`cre/veto/workflow.yaml`](cre/veto/workflow.yaml)、[`cre/project.yaml`](cre/project.yaml) | 兩個 handler，target 為 `sepolia` 與 `sepolia-fork` |
| EVM log trigger | [`cre/veto/workflow.ts#L202-L211`](cre/veto/workflow.ts#L202-L211)、[`#L193-L198`](cre/veto/workflow.ts#L193-L198)、[`#L54-L65`](cre/veto/workflow.ts#L54-L65) | 以 `LATEST` 監聽 `AirlockAdmin.Proposed`：提案一出現就判定，比它最早可執行的時間早了整整一個冷靜期 |
| Cron trigger | [`cre/veto/workflow.ts#L200`](cre/veto/workflow.ts#L200)、[`#L209`](cre/veto/workflow.ts#L209)、[`cre/veto/airlock.ts#L321-L387`](cre/veto/airlock.ts#L321-L387) | 定時掃描：最新 20 個提案，每分鐘一次 |
| EVM 讀取（`callContract`） | [`cre/veto/workflow.ts#L114-L122`](cre/veto/workflow.ts#L114-L122)、[`#L137-L142`](cre/veto/workflow.ts#L137-L142)、[`cre/veto/chain.ts`](cre/veto/chain.ts) | 提案、放行、`oracleJudged`、核准紀錄與餘額，透過 Multicall3 批次讀取，指定提案區塊或 `LATEST` |
| EVM 讀取（`headerByNumber`） | [`cre/veto/workflow.ts#L125-L136`](cre/veto/workflow.ts#L125-L136) | 最新區塊，以及用來推導模擬陌生地址的提案區塊雜湊 |
| node mode 下的 HTTP capability | [`cre/veto/workflow.ts#L167-L189`](cre/veto/workflow.ts#L167-L189)、[`#L80-L94`](cre/veto/workflow.ts#L80-L94)、[`cre/veto/judge.ts#L157-L220`](cre/veto/judge.ts#L157-L220) | 每個節點對每家供應商先送 `eth_getCode`，再送一到兩個 `eth_simulateV1` 請求（每個都在 120 kb 的請求上限內） |
| `consensusIdenticalAggregation` | [`cre/veto/workflow.ts#L184-L188`](cre/veto/workflow.ts#L184-L188)，quorum 檢查在 [`cre/veto/judge.ts#L244-L277`](cre/veto/judge.ts#L244-L277) | DON 對 `{verdict, rule}` 取得共識（最多 52 位元組） |
| Secrets | [`cre/veto/workflow.ts#L160-L166`](cre/veto/workflow.ts#L160-L166)、[`cre/secrets.yaml`](cre/secrets.yaml) | EIP-712 attester 金鑰，每次執行只取一次 |
| Report + `writeReport` | [`cre/veto/workflow.ts#L143-L149`](cre/veto/workflow.ts#L143-L149)、[`cre/veto/airlock.ts#L229-L280`](cre/veto/airlock.ts#L229-L280)、[`cre/veto/report.ts`](cre/veto/report.ts) | `runtime.report`（ECDSA、keccak256）與 `evm.writeReport`，之後再讀回提案確認結果 |
| Forwarder + `IReceiver` | [`src/cre/AirlockReceiver.sol#L88-L120`](src/cre/AirlockReceiver.sol#L88-L120)、[`#L156-L169`](src/cre/AirlockReceiver.sol#L156-L169)、[`src/cre/IReceiver.sol`](src/cre/IReceiver.sol)、[`script/DeployEth.s.sol#L35`](script/DeployEth.s.sol#L35) | `onReport` 只接受設定好的 forwarder，有設定時也檢查 workflow id 與 owner |
| Chain selectors | [`cre/veto/workflow.ts#L100-L104`](cre/veto/workflow.ts#L100-L104) | `ethereum-testnet-sepolia` |
| CRE CLI | [`cre/setup.sh`](cre/setup.sh)、[`cre/scripts/fork-e2e.sh`](cre/scripts/fork-e2e.sh)、[`scripts/sepolia/airlock.sh`](scripts/sepolia/airlock.sh)、[`scripts/sepolia/sweep.sh`](scripts/sepolia/sweep.sh) | `cre workflow build`、`cre workflow simulate --broadcast` |

**工作流程目前的執行方式。** 工作流程透過 CRE CLI 的 `cre workflow simulate --broadcast` 對 Ethereum Sepolia 執行。監聽器（[`scripts/sepolia/airlock.sh`](scripts/sepolia/airlock.sh)）讓 log trigger 保持在 listen 模式，定時掃描（[`scripts/sepolia/sweep.sh`](scripts/sepolia/sweep.sh)）每分鐘執行一次 cron handler，每一筆放行與否決都是一筆真實的 Sepolia 交易，經過 Chainlink 在 Sepolia 上的 MockKeystoneForwarder [`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts)。`AirlockReceiver` 不用修改就能接上 DON 部署：部署時把 `FORWARDER` 設為正式的 KeystoneForwarder，並設定 `WORKFLOW_ID` / `WORKFLOW_OWNER`，`onReport` 就會一併檢查 DON 簽署的工作流程 metadata。除非這兩項都有設定，或以 `ALLOW_MOCK_FORWARDER=1` 明確允許，`DeployEth` 會拒絕無權限控管的 MockKeystoneForwarder（[`script/DeployEth.s.sol#L98`](script/DeployEth.s.sol#L98)）。

工作流程在設計上就待在 CRE 每次執行的限額之內：最多 15 次鏈上讀取（Multicall3 批次，低於 5 kb 的 payload 上限）、四家供應商用掉 15 次 HTTP 呼叫中的 12 次、每次執行最多一次攻擊模擬、共識值最多 52 位元組。完整預算見 [docs/design.md](docs/design.md#budgets)。

## 規則

`ruleHash = keccak256("GUARD/<ID>")`，每次否決都會記錄在鏈上。

| 規則 | 何時否決 | 判定方式 |
|---|---|---|
| R1 `TOTAL_SUPPLY` | 陌生地址的呼叫改變了 `totalSupply` | 攻擊模擬 |
| R2 `OWNER` | 陌生地址的呼叫改變了 `owner()` | 攻擊模擬 |
| R3 `TRANSFER_CONSERVATION` | 持有人轉出 X 時，實際移動的不是剛好 X，或動到了其他人的餘額 | 攻擊模擬 |
| R3B `THIRD_PARTY_FUNDS` | 外人動了任何持有人的代幣：有資金的陌生地址不需授權就能用 `transferFrom` 拉走持有人的資金，或它的某次探測動到別人的代幣、鑄幣、銷毀、轉移擁有權，或讓持有人的餘額變少；就算沒有發出事件、或之後的呼叫又改回來也一樣 | 攻擊模擬 |
| R4 `TRANSFER_LIVENESS` | 持有人的普通轉帳失敗 | 攻擊模擬 |
| R5 `STRICT_CODEHASH` | 開啟嚴格模式，且 approver 沒有核准這個 codehash | 鏈上讀取 |
| R6 `SIM_FAILURE` | 模擬無法下判斷：供應商意見不一、回答太少、程式碼不符、view 呼叫或陌生地址的入金轉帳 revert，或探測塞不進設定的請求數 | 模擬與 quorum 檢查 |
| R7 `CONFIG_GUARD` | 更動 guardian、縮短冷靜期或更換緊急暫停目標，卻沒有 approver 的事先核准 | 鏈上讀取 |
| R8 `INIT_DATA` | 升級帶有初始化資料，而 approver 沒有連同 codehash 一起核准 | 鏈上讀取 |
| R9 `NEW_OPCODES` | 新程式碼含有設定中固定允許清單（預設為空）沒有涵蓋的區塊或交易情境操作碼（BASEFEE、TIMESTAMP、NUMBER、ORIGIN、GAS 等）、外部呼叫、create 或 selfdestruct，除非 approver 核准了這個 codehash 本身 | 位元組碼 |

R9 堵住的是模擬規避。`EvilBaseFeeImpl` 在 `block.basefee == 0`（也就是 `eth_simulateV1` 看到的情況）時表現得和 v1 一模一樣，到了真實區塊卻讓任何人都能鑄幣。所有模擬中的不變量都會通過，而它的 `BASEFEE` 操作碼讓它被否決。允許清單從不取決於代理合約目前執行的程式碼，所以一次核准只涵蓋一個 codehash，不會延伸到之後的升級。掃描只在編譯器的 metadata 尾段是完全符合 solc 格式的 CBOR，而且沒有任何指令能執行到它時才跳過；其他情況一律當成程式碼掃描。核准 codehash 只讓它免於 R9、並容許探測被截斷（R6），僅此而已：其他規則照常執行。

R3B 堵住的是悄悄掏空。`EvilDrainImpl` 就是 v1 加上一個沒有權限控管的 `rescue(from, to, amount)`。總供給量、owner、轉帳與操作碼都和 v1 相同，所以 R1 到 R4 和 R9 全部通過。`rescue` 不是標準的代幣函式，所以陌生地址還會用持有人形狀的參數呼叫它；把持有人當成 `from` 的那一次呼叫搬走了持有人的代幣，R3B 因此否決它。只對「持有代幣或 ETH 的呼叫者」開放的掏空也躲不掉，因為陌生地址兩樣都有。

## Sepolia 上線狀態

Ethereum Sepolia，chain id 11155111。以 [`script/DeployEth.s.sol`](script/DeployEth.s.sol) 部署於區塊 11950682。

| 合約 | 地址 |
|---|---|
| AirlockAdmin | [`0x28e7aAC40560804F480e454bF9C12F50C83b700B`](https://sepolia.etherscan.io/address/0x28e7aAC40560804F480e454bF9C12F50C83b700B) |
| AirlockReceiver | [`0xE40D463116F4Aa24d5E79776a65ED0f1b088c670`](https://sepolia.etherscan.io/address/0xE40D463116F4Aa24d5E79776a65ED0f1b088c670) |
| DemoBTC 代理合約（dBTC） | [`0x88Cc569265faDAEAc2a16B69f35E10B2158e4b71`](https://sepolia.etherscan.io/address/0x88Cc569265faDAEAc2a16B69f35E10B2158e4b71) |
| ProxyAdmin | [`0x51a3fE6AD22BF7753574B7b7FD56aE9a65bd593E`](https://sepolia.etherscan.io/address/0x51a3fE6AD22BF7753574B7b7FD56aE9a65bd593E) |
| DemoBTC v1 | [`0x8f7d6453d77B3f3b008CBE4A144d82c5742eB108`](https://sepolia.etherscan.io/address/0x8f7d6453d77B3f3b008CBE4A144d82c5742eB108) |
| DemoBTC v2（正常升級） | [`0x4D959f981C01E3B81ac6C9A20E84816Fe5f6Bce3`](https://sepolia.etherscan.io/address/0x4D959f981C01E3B81ac6C9A20E84816Fe5f6Bce3) |
| EvilMintImpl | [`0x01502c4af90c27f53B2E1293941670C6B761CAAA`](https://sepolia.etherscan.io/address/0x01502c4af90c27f53B2E1293941670C6B761CAAA) |
| EvilOwnerImpl | [`0xBe849DE8e0a4D9b0010ba1468f94Eeb24A42d488`](https://sepolia.etherscan.io/address/0xBe849DE8e0a4D9b0010ba1468f94Eeb24A42d488) |
| EvilFeeImpl | [`0xB95Ffa7b970B1a73488e2fC32B787fA536F12AF5`](https://sepolia.etherscan.io/address/0xB95Ffa7b970B1a73488e2fC32B787fA536F12AF5) |
| EvilBaseFeeImpl | [`0xE1AAa4E88DB9cc7ceCca14722eE2874D834e0310`](https://sepolia.etherscan.io/address/0xE1AAa4E88DB9cc7ceCca14722eE2874D834e0310) |
| EvilDrainImpl | [`0x1d98D64BC5204AE139B5A0747855841Fa5333b6d`](https://sepolia.etherscan.io/address/0x1d98D64BC5204AE139B5A0747855841Fa5333b6d) |
| PausedImpl（緊急暫停目標） | [`0xb6573006fB607E96966d0F578B96AAB25413F5BE`](https://sepolia.etherscan.io/address/0xb6573006fB607E96966d0F578B96AAB25413F5BE) |
| Chainlink MockKeystoneForwarder | [`0x15fC6ae953E024d975e77382eEeC56A9101f9F88`](https://sepolia.etherscan.io/address/0x15fC6ae953E024d975e77382eEeC56A9101f9F88) |

| 卡片 | 提案 | CRE 判決 | 提案交易 | 報告交易 | 之後 |
|---|---|---|---|---|---|
| `v2`：正常升級 | #4 | 放行 | [11950745](https://sepolia.etherscan.io/tx/0x3cd96ac220391e2b404d35591d1a96808b75256e7c685a414e2ca5a63bc54145) | [11950747 (+2)](https://sepolia.etherscan.io/tx/0x2c02d2a23016a72509900eb7ce92dabc06b0dd93a2394d076a62d687ce467efb) | `execute` [11950772](https://sepolia.etherscan.io/tx/0x01913c1854b9862763af74ddacd7be23a7f55232af7334714aa8213aa7021890)，`version()` = "2" |
| `evil-mint`：任何人都能鑄幣 | #1 | 否決 R1 | [11950735](https://sepolia.etherscan.io/tx/0x862c5fdf826a8fef09fe2ff278d3e58191f93c267dbdd38ad9aaa270f39937b0) | [11950736 (+1)](https://sepolia.etherscan.io/tx/0xb0d74e25e2528fb9aad7d21de202dac288cd256048f2986b5214280fda4b84f6) | `execute` revert `ProposalVetoed` |
| `evil-owner`：任何人都能奪取擁有權 | #6 | 否決 R2 | [11950788](https://sepolia.etherscan.io/tx/0x32eb22039bd43602e0406b1a8f9a02c5cbcdb5cf2ef1c389919a45d05820da25) | [11950790 (+2)](https://sepolia.etherscan.io/tx/0x49451bee7a2f3351b18992d94b5f89b9ff89cf53be65a937400ab95fb79be551) | `execute` revert `ProposalVetoed` |
| `evil-fee`：轉帳偷抽 10% | #7 | 否決 R3 | [11950792](https://sepolia.etherscan.io/tx/0xe06924c2e3961ab27d2803c0654b783fc06e52107345bda9bfeff391053fcad3) | [11950794 (+2)](https://sepolia.etherscan.io/tx/0x01f6055a683e0dabc8f34ae094e5daa5a81ddb11c687aa9c5ac6e30c7a7f3d3b) | `execute` revert `ProposalVetoed` |
| `evil-basefee`：真實區塊上開放鑄幣 | #3 | 否決 R9 | [11950742](https://sepolia.etherscan.io/tx/0x3c29c118ca395ca92500abcaae6126244924fbd8e14f846af57b70f113cad6e1) | [11950743 (+1)](https://sepolia.etherscan.io/tx/0xb6db2d832112384287e5a7ccdd086127931360900d09c80645c21eac2bc165db) | `execute` revert `ProposalVetoed` |
| `evil-drain`：任何人都能搬走持有人的代幣 | #2 | 否決 R3B | [11950737](https://sepolia.etherscan.io/tx/0x0e52369921040eb0c901ac3a077aff762d370b4efd9503a52c91360d56366b16) | [11950740 (+3)](https://sepolia.etherscan.io/tx/0x40bbe374a8cee47a94da977f973cf66a67573c12bc84117483fcbd11430f90cb) | `execute` revert `ProposalVetoed` |
| `remove-receiver`：把 CRE 從 guardian 移除 | #5 | 否決 R7 | [11950749](https://sepolia.etherscan.io/tx/0xda2bd1c9dc5f7770da3926358b8da3ffe5a1cd3154b499cafae440387eebb934) | [11950750 (+1)](https://sepolia.etherscan.io/tx/0xaa2f598bdcc7f46727e5456528521e50ac5c1d8e423805042cbf2d10a4c4cdac) | `execute` revert `ProposalVetoed` |

上表每個判定都由官方 CRE CLI 在伺服器上執行本 workflow 產生（log 觸發監聽器＋每 60 秒的補掃，`scripts/sepolia/systemd/`）；workflow 自己的日誌在 [`docs/evidence/sepolia-live.md`](docs/evidence/sepolia-live.md)。

## 自己跑一遍

需要 [Foundry](https://getfoundry.sh)、`jq`、Node 22，以及模擬器要用的 CRE 帳號。`cre/setup.sh` 會把 CRE CLI v1.37.0（SHA-256 鎖定）和 bun 1.4.2 安裝到 `cre/.tools`。

```bash
git clone https://github.com/jiapunk/upgrade-airlock.git
cd upgrade-airlock

# 合約（OpenZeppelin 與 forge-std 已放在 lib/）
forge build                     # 第一次會下載鎖定版本的 solc 0.8.37
forge test --offline            # 117 個測試

# CRE 工作流程
cre/setup.sh
export PATH="$PWD/cre/.tools/bin:$PWD/cre/.tools/node_modules/.bin:$PATH"
(cd cre/veto && bun test && bun run typecheck)    # 118 個測試：規則、探測、位元組碼、報告位元組、預算、兩個 handler

# 在本機 anvil 分叉的 Sepolia 上端對端執行：不會送出任何交易到真實網路
cre login                       # 只需一次；模擬器需要 CRE 帳號
cre/scripts/fork-e2e.sh
```

`cre/scripts/fork-e2e.sh` 會在分叉鏈上部署整套合約，用 CRE 模擬器加 `--broadcast` 執行工作流程，並在鏈上檢查每一個結果：

- log trigger：EvilMint 以 R1 否決、EvilOwner R2、EvilFee R3、EvilBaseFee R9（指出 `BASEFEE`）、EvilDrain R3B（指出 `rescue`，其他規則全部通過）；另外七種掏空手法也只以 R3B 否決：參數順序重排、檢查 token 地址的守衛、只對持有代幣或 ETH 的呼叫者開放、不發出 `Transfer` 事件，以及對持有代幣者略過授權檢查的 `transferFrom`；正常的 v2 被放行，冷靜期過後執行；把 receiver 從 guardian 移除的提案以 R7 否決；經 approver 事先核准的縮短冷靜期被放行；
- 定時掃描：沒人判定過的升級在冷靜期後 revert `NotCleared`，一次掃描就放行並可執行；approver 手動放行的兩個提案在下一次掃描中被判定：EvilDrain 以 R3B 否決（否決優先於放行），延長冷靜期則再由 CRE 放行；帶 6 KB 初始化資料的升級在再下一次掃描以 R8 否決；
- 每個被否決的提案都 revert `ProposalVetoed`，每個判決的證據雜湊都能只靠鏈上資料重新算出（[`cre/veto/tools/check-evidence.ts`](cre/veto/tools/check-evidence.ts)）。

**戰情室。** `cd web && npm ci && npm run dev`，打開 `http://127.0.0.1:5173/`。它直接讀 Sepolia（唯讀），把每個提案畫成一座氣閘：冷靜期、CRE 放行、否決與它的規則和證據。`?mode=offline` 完全不連網，播放錄好的一輪；`?lang=en|zh-TW|zh-CN` 切換語言。

**Sepolia 操作工具包**（[`scripts/sepolia/`](scripts/sepolia/README.md)）。金鑰放在儲存庫之外，在 `KEY_DIR` 裡一個檔案一把十六進位金鑰（`owner`、`attester`、`sender`、`approver`、`emergency`）；腳本從不印出金鑰，而且 owner、approver、緊急 guardian 與 attester 必須是四把不同的金鑰，否則 `deploy.sh` 拒絕部署。每個腳本也都能加上 `FORK=<port>` 對本機分叉鏈執行，整段示範可以零花費彩排。

```bash
scripts/sepolia/deploy.sh                    # 13 筆交易，寫出 deployments/sepolia.json（FORCE=1 會取代既有檔案）
bun scripts/sepolia/make-config.mjs          # 工作流程設定：4 家供應商，quorum 2
scripts/sepolia/fund-sender.sh 0.05          # 支付報告交易的 ETH
scripts/sepolia/airlock.sh                   # 終端機 A：CRE 監聽器（log trigger）
scripts/sepolia/propose.sh v2                # 終端機 B：接著 evil-mint、evil-owner、evil-fee、evil-basefee、evil-drain、remove-receiver
scripts/sepolia/execute.sh <id>              # 冷靜期後執行已放行的提案，否則顯示 revert 原因
scripts/sepolia/status.sh                    # 每個提案的判決、CRE 是否已判定、規則、證據與交易
```

`sweep.sh` 執行一次 cron 定時掃描，`clear.sh` 是 approver 的手動放行，`fork.sh` 啟動、儲存、還原 Sepolia 分叉鏈，`probe-rpcs.ts` 用工作流程自己的判定程式碼檢查每家供應商，`systemd/` 則在 Linux 伺服器上常駐監聽器與定時掃描。

## 儲存庫結構

```
src/AirlockAdmin.sol            兩道門：提案、冷靜期、guardian 否決、放行、執行、breakGlass
src/cre/AirlockReceiver.sol     CRE 報告接收合約：forwarder、工作流程 metadata、EIP-712 簽章、digest 綁定
src/cre/IReceiver.sol           Chainlink CRE 接收介面
src/DemoBTC.sol, DemoBTCV2.sol  示範代幣（dBTC）v1 與正常的 v2
src/PausedImpl.sol              緊急暫停目標：任何餘額變動都會 revert
src/attack/                     EvilMintImpl、EvilOwnerImpl、EvilFeeImpl、EvilBaseFeeImpl、EvilDrainImpl
script/DeployEth.s.sol          部署腳本（13 筆交易），檢查角色、forwarder 與部署後的接線
test/                           Foundry 測試
cre/veto/                       CRE 工作流程：workflow.ts（capability）、airlock.ts（handler）、judge.ts（規則、
                                quorum）、simulate.ts（eth_simulateV1）、bytecode.ts（選擇器、R9）、report.ts
                                （報告、EIP-712、證據）、chain.ts（讀取預算）、keys.ts、rules.ts、config.ts
cre/veto/test/                  Bun 單元測試
cre/veto/tools/                 check-evidence.ts：重新計算每個鏈上證據雜湊
cre/scripts/fork-e2e.sh         在 anvil 分叉的 Sepolia 上端對端執行
cre/setup.sh                    鎖定版本的 CRE CLI 與 bun
scripts/sepolia/                現場示範用的操作工具包
web/                            戰情室（Vite、TypeScript）
deployments/                    部署結果 JSON
docs/                           設計說明與錄下的執行紀錄
```

## 使用的 AI 工具

Upgrade Airlock 是在作者的指導下，用 [Claude Code](https://claude.com/claude-code) 打造的：合約、CRE 工作流程、測試、腳本、戰情室和這些文件，都是用它撰寫並驗證的。

## 授權

[MIT](LICENSE) © 2026 jiapunk
