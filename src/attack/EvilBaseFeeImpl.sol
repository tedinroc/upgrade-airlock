// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DemoBTC} from "../DemoBTC.sol";

/// @title EvilBaseFeeImpl (demo attack: simulation evasion)
/// @notice Same selectors as DemoBTC v1. While `block.basefee == 0` (what an `eth_simulateV1` call without
///         validation sees) `mint` keeps v1's owner check, so a simulation of the upgrade finds nothing wrong.
///         On a real block (`block.basefee > 0`) the check is skipped and anyone can mint.
/// @dev Deliberately malicious demo code. Never deploy outside a demo. The BASEFEE opcode in its bytecode is what
///      the static check (R9) flags.
contract EvilBaseFeeImpl is DemoBTC {
    function mint(address to, uint256 amount) public override {
        if (block.basefee == 0) _checkOwner();
        _mint(to, amount);
    }
}
