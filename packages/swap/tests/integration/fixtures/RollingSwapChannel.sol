// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RollingSwapChannel — chain-B settlement surface for TOON swap claims
/// @notice Test-fixture implementation of the settlement contract targeted by
///         the TOON sdk's `buildSettlementTx()` EVM bundles:
///         `updateBalance(bytes32,uint256,uint256,address,bytes)` redeeming a
///         swap-node-signed cumulative balance proof, emitting
///         `SettlementSucceeded(bytes32,uint256,uint256,address)`.
///
///         The verified digest matches the swap node's `EvmPaymentChannelSigner`
///         / the sdk-and-core `balanceProofHashEvm` byte-for-byte:
///         `keccak256(channelId(32) || cumulativeAmount(32) || nonce(32) || recipient(20))`
///         signed raw (NO EIP-191 prefix) as 65-byte `r||s||v` (v = 27 + recovery).
///
///         Value semantics: `cumulativeAmount` is denominated 1:1 in wei of the
///         channel's native-ETH deposit (the off-chain asset scale is a wire
///         concern). Highest-nonce-wins: `updateBalance` pays only the delta
///         above the last settled cumulative, so N cumulative claims net to one
///         payout no matter how many are submitted — and the e2e asserts only
///         ONE is.
contract RollingSwapChannel {
    struct Channel {
        address signer; // the swap node's chain-B claim signer
        uint256 nonce; // last settled balance-proof nonce
        uint256 cumulativePaid; // cumulative amount already paid out
        uint256 deposit; // remaining maker deposit (wei)
        uint256 settlementCount; // number of successful updateBalance calls
    }

    mapping(bytes32 => Channel) public channels;

    event ChannelOpened(bytes32 indexed channelId, address indexed signer, uint256 deposit);
    event SettlementSucceeded(
        bytes32 indexed channelId, uint256 cumulativeAmount, uint256 nonce, address indexed recipient
    );

    error ChannelExists();
    error UnknownChannel();
    error StaleNonce();
    error StaleCumulativeAmount();
    error BadSignatureLength();
    error BadSignature();
    error InsufficientDeposit();
    error PayoutFailed();

    /// @notice Open + fund a channel for a swap-node signer. The channelId is
    ///         caller-chosen (mirrors the swap node's provisioned channel ids).
    function openChannel(bytes32 channelId, address signer) external payable {
        if (channels[channelId].signer != address(0)) revert ChannelExists();
        require(signer != address(0), "signer required");
        channels[channelId] = Channel({
            signer: signer,
            nonce: 0,
            cumulativePaid: 0,
            deposit: msg.value,
            settlementCount: 0
        });
        emit ChannelOpened(channelId, signer, msg.value);
    }

    /// @notice Top up a channel's deposit.
    function deposit(bytes32 channelId) external payable {
        if (channels[channelId].signer == address(0)) revert UnknownChannel();
        channels[channelId].deposit += msg.value;
    }

    /// @notice Redeem a cumulative balance proof. Signature layout and digest
    ///         match the TOON swap node's EVM claim format exactly.
    function updateBalance(
        bytes32 channelId,
        uint256 cumulativeAmount,
        uint256 nonce,
        address recipient,
        bytes calldata signature
    ) external {
        Channel storage ch = channels[channelId];
        if (ch.signer == address(0)) revert UnknownChannel();
        if (nonce <= ch.nonce) revert StaleNonce();
        if (cumulativeAmount <= ch.cumulativePaid) revert StaleCumulativeAmount();
        if (signature.length != 65) revert BadSignatureLength();

        bytes32 digest = keccak256(abi.encodePacked(channelId, cumulativeAmount, nonce, recipient));
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (ecrecover(digest, v, r, s) != ch.signer) revert BadSignature();

        uint256 delta = cumulativeAmount - ch.cumulativePaid;
        if (delta > ch.deposit) revert InsufficientDeposit();

        ch.nonce = nonce;
        ch.cumulativePaid = cumulativeAmount;
        ch.deposit -= delta;
        ch.settlementCount += 1;

        (bool ok,) = payable(recipient).call{value: delta}("");
        if (!ok) revert PayoutFailed();

        emit SettlementSucceeded(channelId, cumulativeAmount, nonce, recipient);
    }
}
