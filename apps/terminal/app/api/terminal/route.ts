import { NextResponse } from "next/server";
import { loadTerminal } from "@/lib/api";
import { chainHeaders, requestChain } from "@/lib/envelope";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const chain = requestChain(req);
  return NextResponse.json(await loadTerminal(chain), {
    // Matches the 5s server memo; the CDN absorbs the poll fan-out from many
    // viewers while stale-while-revalidate keeps responses instant.
    headers: chainHeaders("public, s-maxage=5, stale-while-revalidate=30", chain),
  });
}
