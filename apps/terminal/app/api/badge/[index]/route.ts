import { NextResponse } from "next/server";
import { badgeSvg } from "@/lib/badge";
import { envelopeHeaders, refusalHeaders, requestChain } from "@/lib/envelope";
import { isIndexId } from "@/lib/indices";
import { loadFigure } from "@/lib/rateFigure";

export const dynamic = "force-dynamic";

/* GET /api/badge/ACR-INF.svg: the rate as a README badge.
 *
 * An `<img>` is the one embed that works everywhere without CORS, a script
 * or an iframe, and GitHub's image proxy fetches it server-side with no
 * regard for robots.txt, so living under /api/ costs nothing here. The chain
 * follows the normal API rule (`?chain=` or the cookie), and the image names
 * the chain in its title so a saved copy cannot pass for the other network.
 *
 * Cached for a minute on the shared cache when the press answered, through
 * `envelopeHeaders` so a cushion render is never cached as if it were an
 * answer; `max-age` as well, because GitHub's proxy honours that one. */
export async function GET(req: Request, { params }: { params: Promise<{ index: string }> }) {
  const chain = requestChain(req);
  const { index: raw } = await params;
  const index = raw.replace(/\.svg$/i, "");
  if (!isIndexId(index)) {
    return new NextResponse("no such index", { status: 404, headers: refusalHeaders() });
  }
  const fig = await loadFigure(chain, index);
  if (!fig) {
    return new NextResponse("no print yet", { status: 404, headers: refusalHeaders() });
  }
  return new NextResponse(badgeSvg(fig), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      ...envelopeHeaders("public, s-maxage=60, max-age=60, stale-while-revalidate=300", chain, fig.env),
    },
  });
}
