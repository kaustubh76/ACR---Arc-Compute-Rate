import { NextResponse } from "next/server";

import { readSellerKeyEvidence } from "@/lib/registryOnchain";
import { freshHeaders, readStatus } from "@/lib/readResult";

/* GET /api/registry/keys — reproduce the four seller addresses, then look them up.
 *
 * The sibling route answers "what does the registry hold". This one answers the
 * question the disclosure under it used to answer in English: who signed these
 * records, and how did four accounts that never sent a transaction end up with
 * one each. It derives every address from a label committed in this repo, then
 * reads the account nonce and the contract's own signature nonce for each.
 *
 * Same freshness discipline as the sibling and for the same reason: not
 * memoized, `freshHeaders` (no-store) on the way out, so a second press can
 * report a later block. `force-dynamic` keeps it off the prerender path and
 * `nodejs` because viem runs server-side.
 *
 * Note this can succeed with `chain_unread: true` — the derivation is offline,
 * so a dead RPC costs the two counts and not the addresses. That is a 200 with
 * honest nulls, not a 503: refusing would throw away a real answer.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const r = await readSellerKeyEvidence();
  if (r.ok) {
    return NextResponse.json(r.value, { status: 200, headers: freshHeaders() });
  }
  // Three failures, three sentences, because they ask the reader for three
  // different things. No address is a deployment fact (nothing is wrong here);
  // a failed derivation is a broken build and pressing again cannot help; only
  // the chain case is worth a retry.
  const noAddress = r.why === "registry.address";
  const badDerive = r.why === "registry.derive";
  const detail = noAddress
    ? "no registry address is configured on this deployment"
    : badDerive
      ? "this build could not derive the seller keys, so there is nothing to check"
      : "the chain would not answer just now. Press again";
  return NextResponse.json(
    { detail, unread: true, why: r.why },
    { status: noAddress ? 404 : readStatus(r), headers: freshHeaders() },
  );
}
