"use client";

import { chainFacts } from "@/lib/chain";
import { deskTier, formatOi } from "@/lib/futuresBook";
import { ageWords, editionLabel, publishedAt } from "@/lib/format";
import { useConnection } from "@/lib/useConnection";
import { useEdition } from "@/lib/useEdition";
import { useFutures, useHealth } from "@/lib/useLive";
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
    title: "first edition: contacting the press",
    plainWord: "connecting",
    plainTitle: "first load: reaching our live server",
  },
  stale: {
    cls: "chip-gold",
    word: "stale",
    title: "last live edition: the press stopped answering; retrying",
    plainWord: "stale",
    plainTitle: "showing the last live numbers: our server stopped answering; retrying",
  },
  waking: {
    cls: "chip-gold",
    word: "waking",
    title: "the press is spinning up: free tier cold start",
    plainWord: "waking",
    plainTitle: "our server naps between visits to save money; it is waking up now",
  },
  "onchain-only": {
    cls: "chip-teal",
    word: "on-chain",
    title: "direct ACROracle reads: the press is down, the prints are not",
    plainWord: "blockchain",
    plainTitle: "read straight off the public record: our server is down, the numbers are not",
  },
  archived: {
    cls: "chip-sim",
    word: "sim",
    title: "bundled snapshot: the press is not answering",
    plainWord: "saved copy",
    plainTitle: "a saved snapshot: start the live server for fresh numbers",
  },
};

/* The chain strip — the editorial dateline.

   It used to carry the network's identity too: name, chain id, gas token, the
   ACROracle address, the gate and the tape. All of that is STATIC, and all of
   it is now said better and larger elsewhere — the footer's on-chain register
   names every contract with its address and heads itself with the CAIP-2, and
   the masthead's StatusPill already reads "live · circle gateway". Repeating
   them here, in the smallest type on the page, above the fold, on every page,
   was nine facts where four would do.

   What is left is the four things that are only true RIGHT NOW and are stated
   nowhere else: which edition this is, when this copy was published, whether
   anything is minding the book, and what the desk is carrying. The tier chip
   rides in front of them when the connection is not live, which is the one
   piece of state the four survivors cannot express by themselves. */
/** How stale a keeper chore may be before it stops being a cooldown and starts
 *  being a stopped loop. The same 300s ops.py's `_keeper` warns at — this chip
 *  sat unconditionally teal at ANY age, so the dateline could show a healthy
 *  green keeper directly above a ledger calling that same chore a warning. */
const KEEPER_STALE_S = 300;

export function ChainStrip({ initial }: { initial: Envelope<TerminalData> }) {
  const conn = useConnection(initial);
  const health = useHealth();
  const env = conn.env;
  const c = chainFacts(env.data.chain);
  const prints = Object.values(env.data.prints);
  const ts = prints.length ? Math.max(...prints.map((p) => p.ts)) : 0;
  const plain = useEdition() === "plain";
  // The global live-futures cue: total open interest on the desk, when live.
  const fut = useFutures();
  const futDesks = fut.roster?.data?.desks ? Object.values(fut.roster.data.desks) : [];
  const futOi = futDesks.reduce((a, d) => a + d.open_interest, 0);
  const futLive = Boolean(fut.roster?.live);
  // Render whenever a venue is KNOWN, live or not. Gating on liveness made the
  // futures chip vanish offline, which is the wrong reading twice over: the
  // venue does not stop existing when our press naps, and the tier chip in
  // front of the line is already the thing that says these numbers are
  // archived. A fact that disappears cannot be marked as stale.
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
  // Is anything still minding the book? The keeper's heartbeat and roll
  // verdicts went only to the server log, so a reader watching a live tape had
  // no way to tell an attended venue from an abandoned one. Rendered only when
  // the press answers AND the keeper says it is on: an unreachable press must
  // omit this line rather than report a keeper that is merely unread as dead.
  const keeper = health?.live ? health.data?.keeper : null;
  if (keeper?.enabled === true) {
    const hb = keeper.heartbeat;
    const age = hb?.checked_age_s ?? null;
    // The chore runs on a 60s loop, so past five minutes it is not resting,
    // it has stopped. Gold, and no breathing dot: a pulse animating over a
    // dead loop is the one signal worse than none.
    const stale = age == null || age >= KEEPER_STALE_S;
    const words = ageWords(age, plain);
    parts.push(
      <span
        key="keeper"
        className={`chip ${stale ? "chip-gold" : "chip-teal"}`}
        title={
          plain
            ? `the shopkeeper's rounds · last check ${words}${hb?.verdict ? `: ${hb.verdict}` : ""}`
            : `venue keeper · heartbeat checked ${words}${hb?.verdict ? `: ${hb.verdict}` : ""}`
        }
      >
        {stale ? null : <span className="dot breathe" aria-hidden />}
        <Ed x="keeper" p="minded" /> · {words}
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
            ? "the futures trading desk · contracts currently open"
            : "ACRFutures desk · total open interest"
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
          title="every number identical; only the words changed"
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
