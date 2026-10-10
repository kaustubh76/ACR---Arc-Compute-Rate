import type { Metadata, Viewport } from "next";
import { DM_Sans, IBM_Plex_Mono, Space_Grotesk, Space_Mono } from "next/font/google";
import { Masthead } from "@/components/Masthead";
import { ChainStrip } from "@/components/ChainStrip";
import { Colophon } from "@/components/Colophon";
import { peekTerminal } from "@/lib/api";
import { serverChain } from "@/lib/serverChain";
import { editionBootScript } from "@/lib/edition";
import "./globals.css";

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-display",
});

const body = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-body",
});

const eyebrow = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-eyebrow",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

/* NOTE: do NOT add an `icons` key here. Next merges the file conventions
   (app/icon.svg, app/apple-icon.png) only `if (!resolvedMetadata.icons)`, so
   hand-writing one silently drops them and they never emit a <link> — which
   would restore the /favicon.ico 404 those files exist to remove. Let the
   files win; app/favicon.ico is the belt-and-braces for the surfaces that
   carry no <head> at all (the 18 API routes, and app/global-error.tsx, which
   renders its own <html>). */
export const metadata: Metadata = {
  // Without this, Next resolves every relative URL below against
  // VERCEL_PROJECT_PRODUCTION_URL — and this Vercel project is named
  // `terminal`, not `arc-compute-rate`, so the canonical would point at a URL
  // that is not the one on the submission form.
  //
  // THE CUSTOM DOMAIN, from 2026-10-08. `arc-compute-rate.vercel.app` still
  // resolves as the project alias and every published link to it still works,
  // but only one host can be canonical and a reader arriving by either should
  // be told the same one. Paired with `alternates: { canonical: "./" }` below,
  // this is what every page's canonical URL is built from, so it was the one
  // line that would have kept advertising the old host indefinitely.
  //
  // BACK ON THE VERCEL HOST, 2026-10-09. The custom domain was never serving:
  // Vercel reported it `verified: true` while its DNS still pointed at
  // Hostinger, which answers a parked-domain page with **HTTP 200**. Paired
  // with `alternates: { canonical: "./" }` below, this line was telling every
  // crawler that the real copy of all eleven routes lived on that parked page —
  // and because it answers 200 rather than 404, a crawler would consolidate
  // onto it and drop the deployment that actually works.
  //
  // Kept in step with `app/robots.ts` and `marketplace.PROVIDER_WEBSITE` by
  // `tests/test_canonical_host.py`. That gate compares the four places to each
  // other and none of them to reality, so it was green throughout — which is
  // the lesson, not a complaint: a host is verified by fetching it and reading
  // what comes back.
  metadataBase: new URL("https://arc-compute-rate.vercel.app"),
  title: "ACR · The Arc Compute Rate",
  description:
    "The reference rate for machine commerce: benchmarks from Arc payment exhaust, published hourly on-chain with their attack cost.",
  applicationName: "ACR",
  // "./" resolves against the current pathname, so every page canonicalises to
  // itself rather than all of them collapsing onto the homepage.
  alternates: { canonical: "./" },
  openGraph: {
    type: "website",
    siteName: "ACR · The Arc Compute Rate",
    locale: "en_US",
    // Deliberately no title/description: Next inherits them from the LEAF
    // segment, so /attack unfurls as "Attack Lab · ACR" instead of every route
    // unfurling as the homepage.
  },
  // Text-only card, no generated image. `next/og` renders in Noto Sans, not
  // Space Grotesk, and getting the real face in means fetching a .ttf at build
  // time — CI keeps this build hermetic on purpose. Discord and Slack render a
  // compact card from title + description + domain + the favicon, which now
  // exists. A static app/opengraph-image.png can be dropped in later with no
  // code and no runtime.
  twitter: { card: "summary" },
};

export const viewport: Viewport = {
  // themeColor belongs to the viewport export in Next 14 — in `metadata` it
  // emits an "Unsupported metadata themeColor" build warning.
  themeColor: "#000b24",
  colorScheme: "dark",
};

export const dynamic = "force-dynamic";

// The shell NEVER blocks on the backend: peekTerminal() is synchronous (memo
// or bundled snapshot), so HTML flushes immediately and each page's own
// loadTerminal() streams in behind its loading.tsx skeleton. The client SWR
// layer upgrades the shell to live data within one fetch.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Read before the shell paints so <html data-chain> is server-rendered and the
  // client adopts it with no flash — unlike data-edition, whose truth lives in
  // localStorage where the server cannot see it and which therefore needs a
  // pre-paint script. Reading cookies here is what makes every route dynamic;
  // they are all force-dynamic already, so nothing moves.
  const chain = await serverChain();
  const initial = peekTerminal(chain);
  return (
    // suppressHydrationWarning: the edition boot script may stamp
    // data-edition="plain" on <html> before hydration (next-themes pattern);
    // it is the only attribute the server does not render.
    <html
      lang="en"
      data-chain={chain}
      className={`${display.variable} ${body.variable} ${eyebrow.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body>
        {/* Pre-paint: restore the reader's edition before any copy renders. */}
        <script dangerouslySetInnerHTML={{ __html: editionBootScript() }} />
        <Masthead initial={initial} />
        <ChainStrip initial={initial} />
        <main className="container page">{children}</main>
        <Colophon initial={initial} />
      </body>
    </html>
  );
}
