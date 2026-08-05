"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useHealth } from "@/lib/useLive";
import { useConnection, type Connection } from "@/lib/useConnection";
import { useEdition } from "@/lib/useEdition";
import { Ed } from "@/components/Ed";
import { EditionToggle } from "@/components/EditionToggle";
import type { Envelope, TerminalData } from "@/lib/types";

/* [href, expert label, plain label] — the plain edition renames the sections
   in the reader's own words; the pages themselves swap with the same click. */
const NAV: Array<[href: string, label: string, plain: string]> = [
  ["/", "Fixing", "The Rate"],
  ["/attack", "Attack Lab", "Try to Cheat It"],
  ["/curve", "Curve", "Future Prices"],
  ["/exchange", "Exchange", "The Shop Floor"],
  ["/sellers", "Registry", "Sellers"],
  ["/developers", "Developers", "For Coders"],
  // The reader's primer. It existed for a week reachable only from the footer
  // and the 404 page — the one page written for a first-time reader was the
  // one no first-time reader could find.
  ["/companion", "Companion", "Start Here"],
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/index/");
  return pathname.startsWith(href);
}

/* The honest mode signal, always visible: which tier of reality is on screen.
   The full connection ladder (lib/connection.ts) — live / stale / waking /
   on-chain-only / archived / linking — not just a live-or-sim binary. */
function StatusPill({ conn }: { conn: Connection }) {
  const health = useHealth();
  const gate = health?.live ? health.data?.gate : null;
  const plain = useEdition() === "plain";

  switch (conn.state) {
    case "live":
      return gate === "circle" ? (
        <span className="chip chip-teal nav-pulse">
          <i className="dot breathe" />
          live · circle gateway
        </span>
      ) : (
        <span className="chip chip-sky nav-pulse">
          <i className="dot breathe" />
          <Ed x="live · dev gate" p="live · practice paywall" />
        </span>
      );
    case "linking":
      return (
        <span
          className="chip chip-sky nav-pulse"
          title={
            plain
              ? "first load — reaching our live server"
              : "first edition — contacting the press"
          }
        >
          <Ed x="linking · first edition" p="connecting · first load" />
        </span>
      );
    case "stale":
      return (
        <span
          className="chip chip-gold nav-pulse"
          title={
            plain
              ? "our server stopped answering — showing the last live numbers while retrying"
              : "the press stopped answering — showing the last live edition while retrying"
          }
        >
          <i className="dot breathe" />
          stale · {conn.ageS ?? 0}s — retrying
        </span>
      );
    case "waking":
      return (
        <span
          className="chip chip-gold nav-pulse"
          title={
            plain
              ? "our server naps between visits to save money — it is waking up now"
              : "the press sleeps between visits (free tier) — a wake call is in flight"
          }
        >
          <i className="dot breathe" />
          <Ed
            x={<>waking the press · ~{conn.wakeRemainingS ?? 0}s</>}
            p={<>waking our server · ~{conn.wakeRemainingS ?? 0}s</>}
          />
        </span>
      );
    case "onchain-only":
      return (
        <span
          className="chip chip-teal nav-pulse"
          title={
            plain
              ? "our server is down — the public scoreboard answers directly; the numbers are the official record"
              : "the press is down but ACROracle answers direct reads — prints are settlement-grade"
          }
        >
          <i className="dot breathe" />
          <Ed x="live · on-chain reads" p="live · read off the blockchain" />
        </span>
      );
    default:
      return (
        <span
          className="chip chip-sim nav-pulse"
          title={
            plain
              ? "a saved snapshot — run `make api` to go live"
              : "bundled snapshot — run `make api` to go live"
          }
        >
          <Ed x="sim · archived" p="simulation · saved copy" />
        </span>
      );
  }
}

export function Masthead({ initial }: { initial: Envelope<TerminalData> }) {
  const conn = useConnection(initial);
  const pathname = usePathname() ?? "/";
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className={`masthead-shell${scrolled ? " scrolled" : ""}`}>
      <header className="masthead container">
        <div className="masthead-top">
          <div className="nameplate">
            ACR <em>— Arc Compute Rate</em>
          </div>
          <Ed
            x="the reference rate for machine commerce"
            p="the going rate for machine work — in plain words"
            className="label"
          />
        </div>
        <div className="horizon-rule" />
        <nav className="nav">
          {NAV.map(([href, label, plain]) => (
            <Link key={href} href={href} className={isActive(pathname, href) ? "active" : ""}>
              <Ed x={label} p={plain} />
            </Link>
          ))}
          <span className="nav-right">
            <EditionToggle />
            <StatusPill conn={conn} />
          </span>
        </nav>
      </header>
    </div>
  );
}
