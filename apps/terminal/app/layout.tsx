import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "ACR — The Arc Compute Rate",
  description:
    "The reference rate for machine commerce — benchmarks from Arc payment exhaust, published hourly on-chain with their attack cost.",
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
