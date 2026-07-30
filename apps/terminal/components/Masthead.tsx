"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useHealth } from "@/lib/useLive";
import { useConnection, type Connection } from "@/lib/useConnection";
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
          live · dev gate
        </span>
      );
    case "linking":
      return (
        <span className="chip chip-sky nav-pulse" title="first edition — contacting the press">
          linking · first edition
        </span>
      );
    case "stale":
      return (
        <span
          className="chip chip-gold nav-pulse"
          title="the press stopped answering — showing the last live edition while retrying"
        >
          <i className="dot breathe" />
          stale · {conn.ageS ?? 0}s — retrying
        </span>
      );
    case "waking":
      return (
        <span
          className="chip chip-gold nav-pulse"
          title="the press sleeps between visits (free tier) — a wake call is in flight"
        >
          <i className="dot breathe" />
          waking the press · ~{conn.wakeRemainingS ?? 0}s
        </span>
      );
    case "onchain-only":
      return (
        <span
          className="chip chip-teal nav-pulse"
          title="the press is down but ACROracle answers direct reads — prints are settlement-grade"
        >
          <i className="dot breathe" />
          live · on-chain reads
        </span>
      );
    default:
      return (
        <span
          className="chip chip-sim nav-pulse"
          title="bundled snapshot — run `make api` to go live"
        >
          sim · archived
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
