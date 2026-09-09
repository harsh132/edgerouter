// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * The code an EOA runs when it wants to do several things at once.
 *
 * Installed on an ordinary account by an EIP-7702 authorization, which makes
 * the account's code `0xef0100 || address(this)`. From then on a transaction
 * the account sends *to itself* runs this contract with `address(this)` equal
 * to the account, so every call made below leaves the account's own address as
 * `msg.sender`. That is the whole reason this exists rather than a multicall
 * helper: an ENS registry checks role bitmaps against the caller, and a helper
 * contract would arrive as itself and be refused. Granting the helper those
 * roles instead would hand a contract standing authority over a name.
 *
 * ## Only the account itself
 *
 * `msg.sender != address(this)` reverts, and that single line is the security
 * of this contract. Without it, an account running this code exposes an
 * unauthenticated "do anything as me" entry point to the entire chain, which is
 * the standard way delegated accounts are drained. With it, the only way to
 * reach `execute` is a transaction signed by the account's own key — so
 * delegation grants no authority that the key did not already have.
 *
 * There is deliberately no owner, no signature scheme, no nonce, and no
 * ERC-4337 entry point. Those exist to let somebody *other* than the key holder
 * act, and nothing here wants that.
 *
 * ## Why this is not seven lines
 *
 * `execute` is. The rest is the cost of an account suddenly having code: an
 * EOA that receives ERC-1155 tokens without acknowledging them is fine right up
 * until it has code, and then the same transfer reverts. See the receiver hooks
 * below — they exist because delegation broke name registration, not in case it
 * might.
 *
 * ## Why `receive` is not optional
 *
 * An EOA with code cannot be paid unless its code accepts the transfer. A
 * delegated account with no `receive` silently stops being fundable, which for
 * an account topped up from a faucet is a slow and confusing failure. Being
 * payable costs nothing and restores the behaviour the account had before.
 */
contract Batch7702 {
    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    /// The caller was not the account this code is installed on.
    error NotSelf();

    /**
     * Runs every call in order, or none of them.
     *
     * A failing call aborts the transaction and its revert data is re-thrown
     * verbatim, so a custom error from a registry reaches the caller as itself
     * rather than as a generic batch failure. Losing which call reverted is the
     * price of one receipt instead of seven; simulating the batch gives it back.
     */
    function execute(Call[] calldata calls) external payable {
        if (msg.sender != address(this)) revert NotSelf();

        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory returned) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                assembly {
                    revert(add(returned, 0x20), mload(returned))
                }
            }
        }
    }

    /**
     * Names are ERC-1155 tokens, and a delegated account is a contract.
     *
     * This is not defensive boilerplate, it is the fix for a real break. The
     * ENSv2 registry mints a name with `_safeMint`, which checks whether the
     * recipient has code and, if so, requires it to acknowledge the transfer.
     * An EOA has no code and skips that path entirely — until EIP-7702 gives it
     * some, at which point registration starts reverting with
     * `ERC1155InvalidReceiver` and the account can no longer be given a name at
     * all. Delegation broke minting outright, batched or not.
     *
     * So the account has to say it accepts tokens. It accepts unconditionally:
     * refusing would mean an account that cannot be sent the very names it
     * exists to own, and there is no sense in which this contract is better
     * placed than its owner to judge an incoming transfer.
     */
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    /// The same problem, for the ERC-721 half of ENS.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /**
     * `supportsInterface`, because a receiver that cannot be detected is not
     * always treated as one. ERC-1155's own acceptance check does not ask, but
     * plenty of callers do before they transfer.
     */
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == 0x01ffc9a7 || // ERC-165
            interfaceId == 0x4e2312e0 || // ERC-1155 receiver
            interfaceId == 0x150b7a02; // ERC-721 receiver
    }

    receive() external payable {}
}
