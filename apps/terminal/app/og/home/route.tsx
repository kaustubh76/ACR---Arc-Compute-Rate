import { ImageResponse } from "next/og";
import { loadTerminal } from "@/lib/api";
import { CHAINS } from "@/lib/chainChoice";
import { envelopeHeaders, requestChain } from "@/lib/envelope";
import { fmt, serviceName } from "@/lib/format";
import { INDICES } from "@/lib/indices";
import { INK, OG_SIZE, stateColor } from "@/lib/og";
import { plexFonts } from "@/lib/ogFonts";
import { figureFor } from "@/lib/rateFigure";

export const dynamic = "force-dynamic";

/* GET /og/home: the card a pasted link unfurls with.
 *
 * A route handler under /og/, deliberately not the `opengraph-image` file
 * convention and not under /api/: a file-convention image at the app root
 * overrides every child page's own image (so /check could never carry its
 * verdict), and robots.txt disallows /api/, which Twitter's unfurler honours
 * when it fetches a card image. `app/layout.tsx` points every page here; a
 * page with a better image (/check with a bill in its URL) points elsewhere.
 *
 * Dynamic on purpose, and this is the line that makes it so: a generated
 * image is otherwise prerendered at build time, which would bake whatever
 * number the press answered during the build into every share for the life
 * of the deployment. The reference rate's whole claim is that it is current,
 * so the image says how old the figure is, in the hero's own words. */
export async function GET(req: Request) {
  const chain = requestChain(req);
  const host = new URL(req.url).host;
  const env = await loadTerminal(chain);
  const flagship = figureFor(env, chain, "ACR-INF", host) ?? figureFor(env, chain, Object.keys(env.data.prints ?? {})[0] ?? "", host);
  const fonts = await plexFonts();
  const profile = CHAINS[chain].profile;

  if (!flagship) {
    return new ImageResponse(
      (
        <div style={{ ...FRAME, justifyContent: "center", alignItems: "center", fontSize: 40 }}>
          awaiting the first print
        </div>
      ),
      { ...OG_SIZE, fonts, headers: envelopeHeaders("public, s-maxage=60", chain, { live: false }) },
    );
  }

  const others = INDICES.filter((i) => i !== flagship.index)
    .map((i) => figureFor(env, chain, i))
    .filter((f): f is NonNullable<typeof f> => f !== null);

  return new ImageResponse(
    (
      <div style={FRAME}>
        {/* 17px at 2px tracking: the two eyebrows together must clear the
            1056px between the paddings, and at 20px/4px they collided. */}
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 17, letterSpacing: 2, color: INK.sky }}>
          <span>ARC COMPUTE RATE · THE REFERENCE RATE FOR MACHINE COMMERCE</span>
          <span>{chain === "mainnet" ? `ARC MAINNET · ${profile.chainId}` : `${profile.name.toUpperCase()} · ${profile.chainId}`}</span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", gap: 20, fontSize: 28, color: INK.sky, alignItems: "baseline" }}>
            <span style={{ letterSpacing: 3 }}>{flagship.index}</span>
            <span style={{ color: "#d5e0e7" }}>{serviceName(flagship.index)}</span>
          </div>
          <div style={{ display: "flex", fontSize: 196, fontWeight: 500, color: INK.sand, letterSpacing: -6, lineHeight: 1.05 }}>
            {fmt(flagship.value)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 26, color: INK.sky }}>
            <span>{flagship.unit}</span>
            <span style={{ color: INK.mute }}>·</span>
            <div style={{ display: "flex", width: 16, height: 16, borderRadius: 8, background: stateColor(flagship.state) }} />
            <span>{flagship.line}</span>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", fontSize: 22, color: INK.sky }}>
          <div style={{ display: "flex", gap: 40 }}>
            {others.map((o) => (
              <div key={o.index} style={{ display: "flex", gap: 12 }}>
                <span>{o.index}</span>
                <span style={{ color: INK.sand }}>{fmt(o.value)}</span>
                <span style={{ color: INK.mute }}>{o.unit}</span>
              </div>
            ))}
          </div>
          <span style={{ color: INK.mute }}>{host}</span>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts,
      headers: envelopeHeaders("public, s-maxage=300, stale-while-revalidate=600", chain, env),
    },
  );
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
