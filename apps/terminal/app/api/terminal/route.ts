import { NextResponse } from "next/server";
import { loadTerminal } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await loadTerminal(), {
    // Matches the 5s server memo; the CDN absorbs the poll fan-out from many
    // viewers while stale-while-revalidate keeps responses instant.
    headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=30" },
  });
}
