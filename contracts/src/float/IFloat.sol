// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal ERC-20 surface for USDC (6 decimals on Arc's ERC-20 view).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice The price feed the vault authorizes spending against.
/// @dev    `printId` is the whole point of this interface. A print must be
///         identified by something INJECTIVE so that "this quote was checked
///         against a print that has since rotated" is a refusal distinct from
///         "this print is too old". `postedAt` cannot do that job: two indices
///         written in one block share a timestamp, and a retried keeper
///         transaction re-posts at the same block time with a different value.
///         An incrementing id per index is injective by construction.
///
///         `printId == 0` means NO PRINT. Ids start at 1, so absence needs no
///         second return value and no revert.
interface IFloatPrices {
    function latest(bytes32 index)
        external
        view
        returns (uint256 priceWad, uint64 printId, uint64 postedAt, uint32 ciBps);
}

/// @notice A place idle float earns yield, with the only two verbs the vault needs.
/// @dev    `withdrawExact` is a REQUEST, not a promise. Share-priced vaults round,
///         so a sleeve may deliver slightly less than asked. The vault therefore
///         measures the balance delta rather than trusting the call — see
///         `FloatVault._fund`. A sleeve that cannot deliver must not silently
///         deliver less and let the caller discover it at transfer time.
interface ISleeve {
    function depositIdle(uint256 usdcAmount) external;
    function withdrawExact(uint256 usdcAmount) external;
    function valueUsdc() external view returns (uint256);
}

/// @notice The ERC-4626 surface we actually use.
/// @dev    DELIBERATELY OMITS `maxWithdraw`/`maxDeposit`/`maxMint`/`maxRedeem`.
///         Morpho Vault V2 — the vault live on Arc Testnet and the one this
///         sleeve is built for — returns ZERO from all four by design, and says
///         so in its own source: "the vault has a non-conventional behaviour on
///         max functions: they always return zero." Code that sizes a withdrawal
///         from `maxWithdraw` reports no float forever, which would defeat the
///         entire just-in-time path while looking like an empty treasury. The
///         interface leaves them out so nobody can reach for them by accident.
interface IERC4626 {
    function asset() external view returns (address);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares);
    function balanceOf(address account) external view returns (uint256);
    function convertToAssets(uint256 shares) external view returns (uint256 assets);
    function previewWithdraw(uint256 assets) external view returns (uint256 shares);
}
