// Approval keys looked up with AirlockAdmin.isApprovedCodehash (the approver registers them before the proposal):
//  - config proposals (kinds 1-3, R7): keccak256(abi.encode(uint8 kind, address target, uint256 value))
//  - upgrade with non-empty init data (R8): keccak256(abi.encode(bytes32 codehash, bytes32 keccak256(data)))
//    The second word is the proposal's dataHash, so the key is computable from getProposal alone: the workflow never
//    needs the init data itself (which can be larger than one log event or one chain read may carry).
//  - upgrade codehash (R5 strict, R9 exemption): the codehash itself
import { type Address, encodeAbiParameters, type Hex, keccak256 } from 'viem'

export const actionHash = (kind: number, target: Address, value: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }, { type: 'uint256' }], [kind, target, value]))

export const upgradeDataKey = (codehash: Hex, dataHash: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [codehash, dataHash]))
