import { NextResponse } from "next/server";
import { cardSvg } from "@/lib/badge";
import { envelopeHeaders, refusalHeaders, requestChain } from "@/lib/envelope";
import { isIndexId } from "@/lib/indices";
import { loadFigure } from "@/lib/rateFigure";

export const dynamic = "force-dynamic";

/* GET /api/card/ACR-INF.svg: the rate card, 320 by 160, for a docs page.
 *
 * The badge's larger sibling: the same figure, the same freshness line, plus
 * the interval and the cost to move it, and the host it was read from so a
 * reader can go and check. See `app/api/badge/[index]/route.ts` for why an
 * SVG image, why /api/, and why the cache goes through `envelopeHeaders`. */
export async function GET(req: Request, { params }: { params: Promise<{ index: string }> }) {
  const chain = requestChain(req);
  const { index: raw } = await params;
  const index = raw.replace(/\.svg$/i, "");
  if (!isIndexId(index)) {
    return new NextResponse("no such index", { status: 404, headers: refusalHeaders() });
  }
  const fig = await loadFigure(chain, index, new URL(req.url).host);
  if (!fig) {
    return new NextResponse("no print yet", { status: 404, headers: refusalHeaders() });
  }
  return new NextResponse(cardSvg(fig), {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      ...envelopeHeaders("public, s-maxage=60, max-age=60, stale-while-revalidate=300", chain, fig.env),
    },
  });
}
