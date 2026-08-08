import type { Metadata, Viewport } from "next";
import { DM_Sans, IBM_Plex_Mono, Space_Grotesk, Space_Mono } from "next/font/google";
import { Masthead } from "@/components/Masthead";
import { ChainStrip } from "@/components/ChainStrip";
import { Colophon } from "@/components/Colophon";
import { peekTerminal } from "@/lib/api";
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
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const initial = peekTerminal();
  return (
    // suppressHydrationWarning: the edition boot script may stamp
    // data-edition="plain" on <html> before hydration (next-themes pattern);
    // it is the only attribute the server does not render.
    <html
      lang="en"
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
