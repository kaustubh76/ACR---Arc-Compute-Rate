import { NextResponse } from "next/server";

import { readRegistry } from "@/lib/registryOnchain";
import { readHeaders, readStatus } from "@/lib/readResult";

/* GET /api/registry — the chain's own answer, on demand.
 *
 * Every other number on /sellers reaches the page through the Python press.
 * This one does not: it is what the reader gets when they press "read it from
 * the chain", and its whole product is that the answer is fresh and stamped
 * with a block height. So it is deliberately NOT memoized and NOT CDN-cached
 * on the way out beyond readHeaders' 10s — a second press must be able to
 * report a later block, or the button is theatre.
 *
 * `force-dynamic` keeps the route off the prerender path (it must never be
 * evaluated at build time, which would also break the hermetic CI build), and
 * `nodejs` because viem runs server-side here.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const r = await readRegistry();
  if (r.ok) {
    return NextResponse.json(r.value, { status: 200, headers: readHeaders(r) });
  }
  // Two different failures, two different sentences. "No registry configured"
  // is a deployment fact the reader can act on (nothing is wrong, this build
  // has no address); "the chain would not answer" is transient and worth
  // pressing again. Collapsing them into one message would tell a reader to
  // retry something that can never succeed here.
  const noAddress = r.why === "registry.address";
  return NextResponse.json(
    {
      detail: noAddress
        ? "no registry address is configured on this deployment"
        : "the chain would not answer just now. Press again",
      unread: true,
      why: r.why,
    },
    { status: noAddress ? 404 : readStatus(r), headers: readHeaders(r) },
  );
}
