import { NextResponse } from "next/server";

import { readRegistry } from "@/lib/registryOnchain";
import { freshHeaders, readStatus } from "@/lib/readResult";
import { requestChain } from "@/lib/envelope";

/* GET /api/registry — the chain's own answer, on demand.
 *
 * Every other address on /developers reaches the page through the Python press.
 * This one does not: it is what the reader gets when they press "read it from
 * the chain", and its whole product is that the answer is fresh and stamped
 * with a block height. So it is deliberately NOT memoized and NOT cached on
 * the way out at all — a second press must be able to report a later block, or
 * the button is theatre.
 *
 * `freshHeaders`, not `readHeaders`, and the difference is not cosmetic: this
 * route shipped with the latter and production duly replayed one answer for
 * forty seconds under `x-vercel-cache: STALE`. The comment above was already
 * making the promise; the header was breaking it.
 *
 * `force-dynamic` keeps the route off the prerender path (it must never be
 * evaluated at build time, which would also break the hermetic CI build), and
 * `nodejs` because viem runs server-side here.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const chain = requestChain(req);
  // `?records=1` asks for each attestation too. Off by default because the
  // crawl costs ~2.8s of paced RPC and `took_ms` is a figure the button shows;
  // see `readRegistry`'s own note.
  const records = new URL(req.url).searchParams.get("records") === "1";
  const r = await readRegistry(chain, { records });
  if (r.ok) {
    return NextResponse.json(r.value, { status: 200, headers: freshHeaders() });
  }
  /* THREE failures, three sentences — it had two, and `readRegistry` has
     always returned three causes. "No registry configured" is a deployment
     fact; "the chain would not answer" is transient and worth pressing again;
     and `registry.chain` is "this chain has no direct-read tier at all", which
     landed in the retry bucket and told a reader to press a button that can
     never succeed here. This comment already said collapsing them "would tell
     a reader to retry something that can never succeed", which is exactly what
     it then did — and the control it breaks is the one whose entire product is
     "press twice: the block moves", i.e. this is not a recording. */
  const noAddress = r.why === "registry.address";
  const noDirectReads = r.why === "registry.chain";
  return NextResponse.json(
    {
      detail: noAddress
        ? "no registry address is configured on this deployment"
        : noDirectReads
          ? "this network has no direct-read tier here, so the browser cannot reach the chain itself. The register above still comes from the press."
          : "the chain would not answer just now. Press again",
      unread: true,
      why: r.why,
    },
    { status: noAddress || noDirectReads ? 404 : readStatus(r), headers: freshHeaders() },
  );
}
