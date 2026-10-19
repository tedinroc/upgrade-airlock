// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {DemoBTC} from "../../src/DemoBTC.sol";

// Test-only attack fixtures for the CRE clearance workflow's fork E2E. Each inherits DemoBTC, so it keeps v1's
// storage layout and every v1 selector intact (mint stays owner-only, transfers conserve, the owner stays put,
// no dangerous opcodes): R1, R2, R3, R4 and R9 all pass, and only R3B can catch the drain. These are the seven
// variants a reviewer used to slip past an R3B that only matched the exact rescue(from, to, amount) shape; the
// hardened simulation must veto every one of them R3B.
//
// Deliberately malicious demo code. Never deploy outside a demo.

/// @notice A: rescue with the amount word between the two addresses — rescue(from, amount, to).
contract VariantA_RescueReorder is DemoBTC {
    function rescue(address from, uint256 amount, address to) external {
        _transfer(from, to, amount);
    }
}

/// @notice B: a sweep whose first word is the amount — sweep(amount, from, to).
contract VariantB_SweepReorder is DemoBTC {
    function sweep(uint256 amount, address from, address to) external {
        _transfer(from, to, amount);
    }
}

/// @notice C: a four-argument rescueTokens(token, from, to, amount) that insists the token is this contract. The
///         probe that fills the remaining address slots with the proxy address passes the guard.
contract VariantC_RescueTokensGuard is DemoBTC {
    error WrongToken();

    function rescueTokens(address token, address from, address to, uint256 amount) external {
        if (token != address(this)) revert WrongToken();
        _transfer(from, to, amount);
    }
}

/// @notice D: an open rescue(from, to, amount) gated on the caller already holding tokens. A stranger with no
///         balance cannot reach it — unless the simulation funds the stranger first.
contract VariantD_RescueRequireTokens is DemoBTC {
    error NoTokens();

    function rescue(address from, address to, uint256 amount) external {
        if (balanceOf(msg.sender) == 0) revert NoTokens();
        _transfer(from, to, amount);
    }
}

/// @notice E: a rescue(from, to, amount) that moves balances with raw storage writes and emits NO Transfer event,
///         so a probe out and a later probe back net to zero with no logs. The post-probe balance read catches it.
contract VariantE_RescueNoLog is DemoBTC {
    // ERC20Upgradeable ERC-7201 storage: _balances is the first field of the struct at this slot.
    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC20")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ERC20_STORAGE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00;

    function rescue(address from, address to, uint256 amount) external {
        bytes32 fromSlot = keccak256(abi.encode(from, ERC20_STORAGE));
        bytes32 toSlot = keccak256(abi.encode(to, ERC20_STORAGE));
        assembly {
            let fb := sload(fromSlot)
            if lt(fb, amount) { revert(0, 0) }
            sstore(fromSlot, sub(fb, amount))
            sstore(toSlot, add(sload(toSlot), amount))
        }
    }
}

/// @notice F: an open rescue(from, to, amount) gated on the caller holding ETH. A stranger with no ETH cannot reach
///         it — unless the simulation gives the stranger an ETH balance override.
contract VariantF_RescueRequireEth is DemoBTC {
    error NoEth();

    function rescue(address from, address to, uint256 amount) external {
        if (msg.sender.balance == 0) revert NoEth();
        _transfer(from, to, amount);
    }
}

/// @notice G: no new selector. transferFrom waives the allowance check whenever the caller already holds tokens, so
///         a token-holding stranger can pull any holder's balance. The R3B transferFrom runs from the funded stranger.
contract VariantG_TransferFromAllowanceSkip is DemoBTC {
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (balanceOf(msg.sender) != 0) {
            _transfer(from, to, value);
            return true;
        }
        return super.transferFrom(from, to, value);
    }
}
