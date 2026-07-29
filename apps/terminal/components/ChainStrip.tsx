"use client";

import { chainFacts } from "@/lib/chain";
import { editionLabel, publishedAt } from "@/lib/format";
import { useConnection } from "@/lib/useConnection";
import { AddressChip } from "./chain/AddressChip";
import type { Envelope, TerminalData } from "@/lib/types";

/* The dateline's tier chip mirrors the masthead ladder in one word. */
const TIER_CHIP: Record<string, { cls: string; word: string; title: string } | null> = {
  live: null, // no chip — live is the default state of the dateline
  linking: { cls: "chip-sky", word: "linking", title: "first edition — contacting the press" },
  stale: { cls: "chip-gold", word: "stale", title: "last live edition — the press stopped answering; retrying" },
  waking: { cls: "chip-gold", word: "waking", title: "the press is spinning up — free tier cold start" },
  "onchain-only": { cls: "chip-teal", word: "on-chain", title: "direct ACROracle reads — the press is down, the prints are not" },
  archived: { cls: "chip-sim", word: "sim", title: "bundled snapshot — run `make api` to go live" },
};

/* The chain strip — the old editorial dateline, chain-native. It ALWAYS
   renders the network identity (offline included; the tier chip marks the
   rung of the connection ladder instead of hiding the chain). This line is
   why no page can ever read as a plain white page again. */
export function ChainStrip({ initial }: { initial: Envelope<TerminalData> }) {
  const conn = useConnection(initial);
  const env = conn.env;
  const c = chainFacts(env.data.chain);
  const prints = Object.values(env.data.prints);
  const ts = prints.length ? Math.max(...prints.map((p) => p.ts)) : 0;
  const oracle = c.oracle ?? env.data.oracle ?? null;

  const parts: React.ReactNode[] = [];
  const tier = TIER_CHIP[conn.state];
  if (tier) {
    parts.push(
      <span key="tier" className={`chip ${tier.cls}`} title={tier.title}>
        {tier.word}
      </span>,
    );
  }
  parts.push(
    <span key="no">
      Fixing <b>{editionLabel(ts)}</b>
    </span>,
  );
  if (env.live) {
    parts.push(
      <span key="pub">
        Published <b>{publishedAt(env.fetchedAt)}</b>
      </span>,
    );
  }
  parts.push(
    <span key="net">
      <b>{c.name}</b> · {c.chainId}
    </span>,
    <span key="gas" title="USDC is Arc's native gas — deterministic, dollar-denominated fees">
      gas = USDC
    </span>,
    <span key="oracle" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      Oracle{" "}
      {oracle ? (
        <AddressChip address={oracle} explorer={c.explorer} copy={false} />
      ) : (
        <b title="deploy ACROracle to Arc testnet to light this up">undeployed</b>
      )}
    </span>,
  );
  if (c.gate) {
    parts.push(
      <span key="gate">
        gate <b>{c.gate === "circle" ? "circle gateway" : "dev"}</b>
      </span>,
    );
  }
  if (c.tapeSource) {
    parts.push(
      <span key="tape">
        tape <b>{c.tapeSource}</b>
      </span>,
    );
  }

  return (
    <div className="container">
      <div className="chain-strip">
        {parts.map((p, i) => (
          <span key={i} style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
            {i > 0 && <span className="sep">·</span>}
            {p}
          </span>
        ))}
      </div>
    </div>
  );
}
