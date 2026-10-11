import { ImageResponse } from "next/og";
import { fetchLiveMeta } from "@/lib/api";
import { envelopeHeaders, requestChain } from "@/lib/envelope";
import { INK, OG_SIZE } from "@/lib/og";
import { plexFonts } from "@/lib/ogFonts";
import { fmtBp, fmtUsd, noBenchmarkLine } from "@/lib/parCopy";
import { parPath, parseParQuery } from "@/lib/parQuery";
import { rateChip } from "@/lib/rateChip";
import type { ParCheck } from "@/lib/types";

export const dynamic = "force-dynamic";

/* GET /og/check?unit&billed_usdc&quantity&vendor: the verdict as a card.
 *
 * `/check` writes a bill into its own URL, so a verdict is a link; this is
 * what that link looks like when it lands in a channel. The same validator,
 * the same press call and the same words as the page (`lib/parQuery.ts`,
 * `lib/parCopy.ts`, `lib/rateChip.ts`), so the card and the page it opens
 * cannot say two things about one bill. See `app/og/home/route.tsx` for why
 * this lives under /og/ and why it is dynamic. */
export async function GET(req: Request) {
  const chain = requestChain(req);
  const host = new URL(req.url).host;
  const fonts = await plexFonts();
  const q = new URL(req.url).searchParams;
  const parsed = parseParQuery((k) => q.get(k));

  const plain = (head: string, body: string, live: boolean) =>
    new ImageResponse(
      (
        <div style={FRAME}>
          <Eyebrow host={host} />
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", fontSize: 56, color: INK.sand, fontWeight: 500 }}>{head}</div>
            <div style={{ display: "flex", fontSize: 28, color: INK.sky, lineHeight: 1.4 }}>{body}</div>
          </div>
          <div style={{ display: "flex", fontSize: 22, color: INK.mute }}>no account, no key, nothing stored</div>
        </div>
      ),
      { ...OG_SIZE, fonts, headers: envelopeHeaders("public, s-maxage=60", chain, { live }) },
    );

  if (!parsed.ok) {
    return plain("Check a bill", "This link carries no bill. The page needs a unit, an amount and a quantity to price one.", false);
  }

  const { data: c } = await fetchLiveMeta<ParCheck>(chain, parPath(parsed.q), 12_000);
  if (!c) {
    return plain("Could not price this bill right now", "The press did not answer. Open the link and press the button; the page retries.", false);
  }

  const bill = `${fmtUsd(c.billed_usdc)} USDC for ${c.quantity} × ${parsed.q.unit.replace("$/", "")}`;

  if (!c.par.available) {
    return plain("No verdict, and why", noBenchmarkLine(c.par.reason), true);
  }

  const chip = rateChip(c.over_rate_bp, c.benchmarked_against, c.basket?.status);
  const unitPrice = c.quantity > 0 ? c.billed_usdc / c.quantity : null;
  const asOf = c.basket.fetched_at ? new Date(c.basket.fetched_at * 1000).toISOString().slice(0, 10) : null;

  return new ImageResponse(
    (
      <div style={FRAME}>
        <Eyebrow host={host} />

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", fontSize: 26, color: INK.sky }}>{bill}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
            <span style={{ fontSize: 72, fontWeight: 500, color: verdictColor(chip.cls) }}>{chip.x}</span>
            <span style={{ fontSize: 40, color: INK.sand }}>{fmtBp(c.over_rate_bp)}</span>
          </div>
          <div style={{ display: "flex", gap: 48, fontSize: 24, color: INK.sky }}>
            <Figure label="you paid, per unit" value={fmtUsd(unitPrice)} />
            <Figure label="the going rate" value={fmtUsd(c.par.par_usdc)} />
            <Figure label="the cheapest observed" value={fmtUsd(c.par.best_usdc)} />
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, color: INK.mute }}>
          <span>
            {`${c.par.sellers} prices compared · ${c.benchmarked_against === "market" ? "published list prices" : "our own sellers"}${asOf ? ` · read ${asOf}` : ""}`}
          </span>
          <span>{`${chain === "mainnet" ? "" : `${chain} · `}${host}`}</span>
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts, headers: envelopeHeaders("public, s-maxage=60", chain, { live: true }) },
  );
}

function Eyebrow({ host }: { host: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, letterSpacing: 4, color: INK.sky }}>
      <span>CHECK A BILL · ARC COMPUTE RATE</span>
      <span>{host.toUpperCase()}</span>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 18, color: INK.mute, letterSpacing: 2 }}>{label.toUpperCase()}</span>
      <span style={{ fontSize: 30, color: INK.sky }}>{value}</span>
    </div>
  );
}

/** The chip's class decides its colour on the page; the same three colours here. */
function verdictColor(cls: string): string {
  if (cls.includes("breach")) return "#ef6a5a";
  if (cls.includes("teal")) return INK.teal;
  if (cls.includes("gold")) return INK.gold;
  return INK.sky;
}

const FRAME = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column" as const,
  justifyContent: "space-between",
  background: INK.genesis,
  color: INK.sky,
  padding: "56px 72px",
  fontFamily: "Plex",
};
