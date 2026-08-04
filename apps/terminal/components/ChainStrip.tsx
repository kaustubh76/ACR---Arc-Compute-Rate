"use client";

import { chainFacts } from "@/lib/chain";
import { deskTier, formatOi } from "@/lib/futuresBook";
import { editionLabel, publishedAt } from "@/lib/format";
import { useConnection } from "@/lib/useConnection";
import { useEdition } from "@/lib/useEdition";
import { useFutures } from "@/lib/useLive";
import { AddressChip } from "./chain/AddressChip";
import { Ed } from "./Ed";
import type { Envelope, TerminalData } from "@/lib/types";

/* The dateline's tier chip mirrors the masthead ladder in one word.
   plainWord/plainTitle are the same verdicts set in plain type. */
const TIER_CHIP: Record<
  string,
  { cls: string; word: string; title: string; plainWord: string; plainTitle: string } | null
> = {
  live: null, // no chip — live is the default state of the dateline
  linking: {
    cls: "chip-sky",
    word: "linking",
    title: "first edition — contacting the press",
    plainWord: "connecting",
    plainTitle: "first load — reaching our live server",
  },
  stale: {
    cls: "chip-gold",
    word: "stale",
    title: "last live edition — the press stopped answering; retrying",
    plainWord: "stale",
    plainTitle: "showing the last live numbers — our server stopped answering; retrying",
  },
  waking: {
    cls: "chip-gold",
    word: "waking",
    title: "the press is spinning up — free tier cold start",
    plainWord: "waking",
    plainTitle: "our server naps between visits to save money — it is waking up now",
  },
  "onchain-only": {
    cls: "chip-teal",
    word: "on-chain",
    title: "direct ACROracle reads — the press is down, the prints are not",
    plainWord: "blockchain",
    plainTitle: "read straight off the public record — our server is down, the numbers are not",
  },
  archived: {
    cls: "chip-sim",
    word: "sim",
    title: "bundled snapshot — run `make api` to go live",
    plainWord: "saved copy",
    plainTitle: "a saved snapshot — start the live server for fresh numbers",
  },
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
  const plain = useEdition() === "plain";
  // The global live-futures cue: total open interest on the desk, when live.
  const fut = useFutures();
  const futDesks = fut.roster?.data?.desks ? Object.values(fut.roster.data.desks) : [];
  const futOi = futDesks.reduce((a, d) => a + d.open_interest, 0);
  const futLive = Boolean(fut.roster?.live);
  // Render whenever a venue is KNOWN, live or not. Gating on liveness made the
  // futures chip the one thing in this dateline that vanishes offline —
  // contradicting this file's own rule (see the header: it always renders the
  // network identity, and the tier chip marks the rung) and the oracle chip
  // fifteen lines below, which says "undeployed" rather than disappearing.
  const futVenue = fut.roster?.data?.venue ?? c.futures ?? null;
  const futTier = deskTier(fut.roster?.data?.source, futLive);

  const parts: React.ReactNode[] = [];
  const tier = TIER_CHIP[conn.state];
  if (tier) {
    parts.push(
      <span key="tier" className={`chip ${tier.cls}`} title={plain ? tier.plainTitle : tier.title}>
        <Ed x={tier.word} p={tier.plainWord} />
      </span>,
    );
  }
  parts.push(
    <span key="no">
      <Ed x="Fixing " p="Rate-setting " />
      <b>{editionLabel(ts)}</b>
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
    <span
      key="gas"
      title={
        plain
          ? "this network charges its fees in digital dollars — fixed and predictable"
          : "USDC is Arc's native gas — deterministic, dollar-denominated fees"
      }
    >
      <Ed x="gas = USDC" p="fees paid in dollars" />
    </span>,
    <span key="oracle" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <Ed x="Oracle" p="Public scoreboard" />{" "}
      {oracle ? (
        <AddressChip address={oracle} explorer={c.explorer} copy={false} />
      ) : (
        <b
          title={
            plain
              ? "the scoreboard contract is not on the test network yet"
              : "deploy ACROracle to Arc testnet to light this up"
          }
        >
          undeployed
        </b>
      )}
    </span>,
  );
  if (c.gate) {
    parts.push(
      <span key="gate">
        <Ed x="gate" p="paid through" /> <b>{c.gate === "circle" ? "circle gateway" : "dev"}</b>
      </span>,
    );
  }
  if (c.tapeSource) {
    // The one disclosure that must survive the fully-live state. Every other
    // "sim" chip on the site reports CONNECTION tier, so once the press is up
    // and the oracle is printing they all go teal while the flow underneath
    // the number is still synthetic. Mark the simulated case explicitly.
    const simTape = c.tapeSource === "sim";
    parts.push(
      <span key="tape" className={simTape ? "chip chip-sim" : undefined} title={
        simTape
          ? "estimator, signature and on-chain print are real — the settlement flow underneath is simulated"
          : `index computed from the ${c.tapeSource} tape`
      }>
        <Ed x="tape" p="data feed" /> <b>{c.tapeSource}</b>
      </span>,
    );
  }
  if (futVenue && futDesks.length) {
    parts.push(
      <span
        key="futures"
        className={`chip ${futTier.chip}`}
        title={
          plain
            ? "the futures trading desk — contracts currently open"
            : "ACRFutures desk — total open interest"
        }
      >
        {futTier.chip === "chip-sim" ? null : <span className="dot breathe" aria-hidden />}
        {/* formatOi, not toFixed(0): an open interest of 2.82 printed here as
            "3" while the desk table printed "2.8". */}
        <Ed x="futures" p="futures desk" /> · OI {formatOi(futOi)}
      </span>,
    );
  }

  return (
    <div className="container">
      <div className="chain-strip">
        {/* outside the parts array so expert mode never renders a dangling · */}
        <span
          className="chip chip-gold plain-only"
          title="every number identical — only the words changed"
          style={{ marginRight: 10 }}
        >
          plain edition
        </span>
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
