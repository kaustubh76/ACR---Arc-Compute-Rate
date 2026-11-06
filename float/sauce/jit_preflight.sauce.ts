/**
 * Can the yield venue actually deliver this shortfall, right now?
 *
 * Asked as a compiled program against live Arc state, before any payment
 * transaction exists.
 */
function main(venue: Address, sleeve: Address, needed: Uint256) {
  // The venue must hold the asset we think it does, or every number below is
  // denominated in something else.
  require(Erc4626.Vault(venue).asset() == USDC, "venue asset is not USDC");

  // Our position, converted from a SHARE balance. Shares are 18 decimals
  // against 6-decimal USDC, so convertToAssets must never be fed an amount.
  const shares = balanceOf(venue, sleeve);
  const position = Erc4626.Vault(venue).convertToAssets(shares);

  // Morpho Vault V2 returns zero from every max* function, by design. A sleeve
  // that sized a withdrawal from maxWithdraw would report an empty position
  // forever. Assert the trap rather than describe it.
  require(
    Erc4626.Vault(venue).maxWithdraw(sleeve) == 0,
    "maxWithdraw is non-zero: this is not Vault V2",
  );

  // The question the program exists to answer.
  require(position >= needed, "the sleeve cannot cover this shortfall");
}
