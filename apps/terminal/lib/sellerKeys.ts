import { sha256, toBytes } from "viem";
import { privateKeyToAddress } from "viem/accounts";

/* Reproducing the four demo sellers' addresses from the labels in this repo.
 *
 * /sellers used to CLAIM this in a sentence: "each key is sha256 of a label in
 * demo_sellers.py, so anyone holding this repo can reproduce all four
 * addresses." A sentence is not a proof, and that whole disclosure was three
 * paragraphs of English under a card of real numbers. This module performs the
 * claim instead, and lib/chain.test.ts asserts the output against the committed
 * bundle, so the sentence cannot go stale without CI saying so.
 *
 * DO NOT IMPORT THIS FROM A CLIENT COMPONENT. `viem/accounts` pulls
 * @noble/curves, and none of it belongs in the browser bundle. There is
 * deliberately no `import "server-only"` guard here, unlike registryOnchain.ts:
 * that package throws under plain Node, which would put the derivation beyond
 * the reach of `npm test`, and the CI assertion is the most valuable thing in
 * this file. registryCodec.ts sits in the same position for the same reason.
 * The protection is instead: only app/api/registry/keys/route.ts imports this,
 * the view imports its payload type from lib/types.ts, and the build check
 * greps .next/static for @noble/curves.
 *
 * The derived private keys never leave this function. They are testnet-only,
 * hold nothing, and are already public — the labels and the derivation are both
 * committed here — but they are still key material, so they are not returned,
 * not logged, and not written anywhere.
 */

/** The prefix is load-bearing: the key is sha256 of `acr-attest::<label>`, NOT
 *  of the bare label. Dropping it derives four different addresses that are in
 *  no registry, and every tick on the page would silently turn into a cross. */
export const KEY_PREFIX = "acr-attest::";

/** The labels, in the order `DEMO_SELLERS` declares them in
 *  packages/acr_oracle_client/acr_oracle_client/demo_sellers.py.
 *
 *  Note this is NOT the registry's order: `sellerAt(0..3)` returns them as they
 *  were filed (inf-frontier, gpu-mid, inf-open, data-small). The page shows
 *  repo order, because repo order is what a reader checking this against the
 *  source file will be looking at. */
export const DEMO_LABELS = [
  "acr-seller-inf-frontier",
  "acr-seller-inf-open",
  // Two INFERENCE sellers of the SAME model class. A price gap between
  // different classes is quality, which the hedonic stage adjusts away; only a
  // same-class pair makes "you could have paid less for the same thing" true,
  // which is what the seller fleet's transaction-cost analysis rests on.
  "acr-seller-inf-mid-a",
  "acr-seller-inf-mid-b",
  "acr-seller-gpu-mid",
  "acr-seller-data-small",
] as const;

export interface DerivedSeller {
  label: string;
  /** EIP-55 checksummed, as `privateKeyToAddress` returns it. */
  address: `0x${string}`;
}

let memo: DerivedSeller[] | null = null;

/** The four addresses, derived here and now from the labels above.
 *
 *  Four secp256k1 operations, so ~1ms, but memoized anyway: this is a constant
 *  function of committed source and there is no reason to recompute it per
 *  request. Mirrors `DemoSeller.private_key` / `.address` in demo_sellers.py.
 */
export function deriveDemoSellers(): DerivedSeller[] {
  if (memo) return memo;
  memo = DEMO_LABELS.map((label) => ({
    label,
    address: privateKeyToAddress(sha256(toBytes(KEY_PREFIX + label))),
  }));
  return memo;
}
