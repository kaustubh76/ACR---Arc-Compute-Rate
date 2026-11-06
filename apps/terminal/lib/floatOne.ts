/* One payment, as a scene. The decisions only: the reads live in
   `floatOnchain.ts`, the wire shapes in `float.ts`, and every word a reader
   sees stays in the component as a literal `<Ed x= p=>`.
 *
 * WHY THIS LAYER EXISTS AT ALL. `components/float/MoneyPath.tsx` draws the
 * money path, and it draws it correctly, but the thing the path CLAIMS is an
 * order: the exact shortfall left the yield venue and only then was the seller
 * paid, inside one transaction. In a flat diagram that order is a drawing
 * decision. Arc serves no `debug_traceTransaction` and no `trace_*`
 * (`lib/floatWalk.ts:3-7`), so the one witness to the order is the position of
 * the logs inside the receipt, and `/api/float/walk` already returns those
 * positions. This module turns them into coordinates, so the picture is
 * plotted from the proof rather than arranged to agree with it.
 *
 * THE AXIS CARRIES ONLY BEATS THAT HAVE A LOG. This is the honest reading of a
 * discrepancy, not a smoothing of it: `MoneyPath` replays FIVE beats
 * (`LAST_STEP = 4`) while `FloatWalk` proves FOUR, and of those four only
 * steps 2, 3 and 4 carry a `log_index` at all (`floatOnchain.ts:1104-1119` --
 * step 1 is the vault recomputing the fair total, which is arithmetic and
 * emits nothing). So the ask and the fair check get no height. They are real
 * events and they are drawn, but they are drawn OFF the axis, because a
 * position on an axis of log indices would be a number nobody measured.
 *
 * SPACING IS PROPORTIONAL TO THE REAL GAPS. The canonical payment's logs sit
 * at 30, 32 and 33: the pull is two logs before the pay and the pay is one log
 * before the receipt. Normalising preserves that, so the gaps on screen are
 * the gaps in the transaction. Evenly spacing them would throw away the only
 * quantity this axis has.
 */

import type { FloatTape, FloatTapeRow, FloatVaultState, FloatWalk } from "./float";

/** The five beats of one payment, in the contract's own order.
 *
 *  `ask` and `fair` are logless by nature. The rest are logs, and `logIndex`
 *  is `null` only when the walk could not find one -- which is an absence to
 *  render as an absence, never as a zero. */
export type BeatKey = "ask" | "fair" | "venue" | "pull" | "pay" | "receipt";

export type Beat = {
  key: BeatKey;
  /** The walk's own step number, or `null` for a beat `steps[]` does not model:
   *  the ask, which emits nothing, and the venue, which is carried beside the
   *  step list rather than inside it so its log index cannot silently move the
   *  axis of the others. */
  n: 1 | 2 | 3 | 4 | null;
  /** "ok" proven, "warn" nothing to prove, "bad" contradicted, "none" absent. */
  state: "ok" | "warn" | "bad" | "none";
  /** Position in the transaction's log list. The whole proof, where it exists. */
  logIndex: number | null;
  /** 0 at the earliest log, 1 at the latest, proportional to the real gaps.
   *  `null` for a beat with no log, which therefore gets no height. */
  height: number | null;
  valueUsdc: number | null;
  /** `pull` only: a venue may deliver less than it was asked for. */
  requestedUsdc: number | null;
};

/** Which custody column a beat belongs to. The scene's other axis. */
export type Column = "agent" | "treasury" | "sleeve" | "seller" | "venue";

export const COLUMN: Record<BeatKey, Column> = {
  ask: "agent",
  fair: "treasury",
  /* THE PARTY THAT IS NOT OURS GETS ITS OWN COLUMN, because conflating it with
     the sleeve is what hid the hop. Our `Erc4626Sleeve` is a wrapper that holds
     shares; the venue is where the money actually sits, and it is the only
     thing on this path that could refuse us our own exit. */
  venue: "venue",
  pull: "sleeve",
  pay: "seller",
  receipt: "treasury",
};

export type OnePayment =
  | { status: "reading" }
  /** No payment to show, and the two reasons are not the same fact.
   *
   *  `none-in-window` means this treasury HAS paid and the tape's window did
   *  not reach it. The tape is roughly ten thousand blocks, about seventy-six
   *  minutes (`float.ts:326-329`), so an empty tape over a vault with
   *  receipts is a short window, not an idle treasury, and saying "no payments"
   *  there would be false. */
  | { status: "scripted"; why: "none-in-window" | "none-ever"; beats: Beat[] }
  | {
      status: "live";
      tx: string;
      beats: Beat[];
      verdict: NonNullable<FloatWalk["verdict"]>;
      quoteUsdc: number | null;
      fairUsdc: number | null;
      /** SIGNED, and nullable. A quote below fair is legal and a missing fair
       *  price is not a premium of zero. */
      premiumBps: number | null;
      /** `null` when the named print could not be found: an absence, not a
       *  mismatch (`float.ts` on `fair_matches`). */
      fairMatches: boolean | null;
      jit: boolean;
      human: boolean;
      guest: boolean;
      indexName: string | null;
      /** The agent and index this payment was made under, which is what a dry
       *  run needs to ask the chain the same question again. `agentId` is the
       *  keccak the chain stores; the NAME lives on the vault's agent list,
       *  because `dryRunParams` takes a name and not a hash. */
      agentId: string | null;
      indexId: string | null;
      /** The venue the shortfall came out of, and what it did. All nullable:
       *  a payment the buffer covered touches no venue at all. */
      venue: string | null;
      venueUsdc: number | null;
      /** Who the venue paid. It is the treasury, which is the one-hop claim. */
      venueReceiver: string | null;
      /** A string: 18-decimal share counts exceed MAX_SAFE_INTEGER. */
      venueShares: string | null;
      /** How many logs the venue emitted, named or not. */
      venueLogs: number | null;
      /** How many units were bought. A model name without a quantity cannot be
       *  checked against a per-unit benchmark by a reader. */
      units: number | null;
      sellerAddr: string | null;
      block: number | null;
    };

/** The newest row the tape calls paid. Refusals carry a fair price too, but
 *  they moved nothing, so they have no order to walk. */
export function firstPaid(rows: readonly FloatTapeRow[] | undefined): FloatTapeRow | undefined {
  return rows?.find((r) => r.kind === "paid");
}

/** The beats a reader meets when this chain has no payment to show.
 *
 *  FIGURELESS ON PURPOSE. Every value is `null`, so the scene has nothing to
 *  print and cannot be mistaken for a reading. The shape is the contract's,
 *  the numbers are nobody's. */
export function script(): Beat[] {
  const keys: BeatKey[] = ["ask", "fair", "venue", "pull", "pay", "receipt"];
  return keys.map((key) => ({
    key,
    n: key === "ask" || key === "venue" ? null : ((["fair", "pull", "pay", "receipt"].indexOf(key) + 1) as 1 | 2 | 3 | 4),
    state: "warn" as const,
    logIndex: null,
    height: null,
    valueUsdc: null,
    requestedUsdc: null,
  }));
}

/** Normalise real log indices to 0..1, keeping the gaps proportional.
 *
 *  Exported for its own test. One log, or several at the same index, cannot
 *  express a gap, so they all sit at 0 rather than dividing by zero. */
export function heights(indices: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (indices.length === 0) return out;
  const lo = Math.min(...indices);
  const hi = Math.max(...indices);
  const span = hi - lo;
  for (const i of indices) out.set(i, span === 0 ? 0 : (i - lo) / span);
  return out;
}

function beatsFrom(walk: FloatWalk): Beat[] {
  const steps = walk.steps ?? [];
  const byN = new Map(steps.map((s) => [s.n, s]));
  const keys: Array<{ key: BeatKey; n: 1 | 2 | 3 | 4 | null }> = [
    { key: "ask", n: null },
    { key: "fair", n: 1 },
    /* THE VENUE SITS BEFORE OUR SLEEVE, because that is the order the receipt
       records: the party we do not control released the money at log 29 and our
       wrapper recorded the delivery at 30. It has no `n` because it is carried
       beside `steps[]`, which is what keeps its log index from silently
       re-spacing the others. */
    { key: "venue", n: null },
    { key: "pull", n: 2 },
    { key: "pay", n: 3 },
    { key: "receipt", n: 4 },
  ];
  const venueIdx = typeof walk.venue_log_index === "number" ? walk.venue_log_index : null;
  /* THE AXIS SPANS EVERY LOGGED BEAT, the venue's included. On the canonical
     payment that turns 30/32/33 into 29/30/32/33, so the sleeve's own record
     moves off the floor and the venue takes it. The gaps stay the real gaps. */
  const idx = [
    ...steps.map((s) => s.log_index).filter((i): i is number => typeof i === "number"),
    ...(venueIdx === null ? [] : [venueIdx]),
  ];
  const h = heights(idx);

  return keys.map(({ key, n }) => {
    /* The ask has no step and never will: the agent asking is an MCP call, not
       a log. It is drawn from the tether, not from the axis. */
    if (key === "venue") {
      /* Absent is absent: no venue withdraw means the buffer covered this
         payment, or the shortfall came out of the USYC reserve instead. Neither
         is a venue that did nothing. */
      return {
        key,
        n,
        state: venueIdx === null ? "none" : "ok",
        logIndex: venueIdx,
        height: venueIdx === null ? null : (h.get(venueIdx) ?? null),
        valueUsdc: walk.venue_usdc ?? null,
        requestedUsdc: null,
      };
    }
    if (n === null) {
      return { key, n, state: "ok" as const, logIndex: null, height: null, valueUsdc: null, requestedUsdc: null };
    }
    const s = byN.get(n);
    const logIndex = typeof s?.log_index === "number" ? s.log_index : null;
    return {
      key,
      n,
      state: s?.state ?? "none",
      logIndex,
      height: logIndex === null ? null : (h.get(logIndex) ?? null),
      valueUsdc: s?.value_usdc ?? null,
      requestedUsdc: s?.requested_usdc ?? null,
    };
  });
}

/** Everything the scene renders, from the three reads the page already makes.
 *
 *  `reading` is the walk's own in-flight flag. It matters because a tx hash in
 *  hand with no walk yet is a fourth state: not scripted, not live, and not an
 *  error. Rendering the script there would flash a figureless diagram over a
 *  payment that is about to arrive. */
export function onePayment(input: {
  vault: FloatVaultState | null | undefined;
  tape: FloatTape | null | undefined;
  walk: FloatWalk | null | undefined;
  reading?: boolean;
}): OnePayment {
  const { vault, tape, walk, reading } = input;
  const newest = firstPaid(tape?.rows);

  if (newest && (reading || !walk)) return { status: "reading" };

  /* THE WALK IS THE EVIDENCE; THE TAPE IS ONLY HOW WE FOUND IT.
   *
   * MEASURED, and it broke a run in front of me. The tape is a moving window of
   * roughly nine thousand blocks, it re-polls every twelve seconds, and a poll
   * that drifts past the newest payment or comes back part-read stops listing
   * it. Keyed off the tape, that turned a live payment into "no payment in this
   * window" MID-RUN: the stations went out, the scene unmounted and the flat
   * diagram took its place, two beats into a walk the reader had started.
   *
   * Once the chain has shown us a transaction and we have walked its logs,
   * a window moving on does not un-show it. So the walk decides, and whatever
   * the tape still offers is taken as a bonus rather than a requirement. */
  if (walk?.status !== "ok" || !walk.tx) {
    /* A vault that reports receipts has paid; a tape that did not reach the
       vault's first block simply did not look far enough back. Only a vault
       reporting zero receipts has never paid. `undefined` receipts means the
       chain did not answer that field, and an unread count must not be read
       as a zero, so it falls to the window wording too. */
    const ever = (vault?.receipts ?? 0) > 0 || tape?.reached_start === false;
    return { status: "scripted", why: ever ? "none-in-window" : "none-ever", beats: script() };
  }

  return {
    status: "live",
    tx: walk.tx,
    beats: beatsFrom(walk),
    verdict: walk.verdict ?? "unproven",
    quoteUsdc: walk.quote_usdc ?? null,
    fairUsdc: walk.fair_usdc ?? null,
    /* Off the tape row when it is still listed, and `null` when the window has
       moved on. A missing premium is not a premium of zero. */
    premiumBps: newest?.premium_bps ?? null,
    fairMatches: walk.fair_matches ?? null,
    jit: Boolean(walk.jit_funded),
    human: Boolean(walk.human_approved),
    guest: Boolean(walk.guest),
    indexName: walk.index_name ?? null,
    /* The walk's own copies first, because they survive the window moving. */
    agentId: walk.agent_id ?? newest?.agent_id ?? null,
    indexId: newest?.index ?? null,
    venue: walk.venue ?? null,
    venueUsdc: walk.venue_usdc ?? null,
    venueReceiver: walk.venue_receiver ?? null,
    venueShares: walk.venue_shares ?? null,
    venueLogs: walk.venue_log_count ?? null,
    units: walk.units ?? null,
    sellerAddr: walk.seller ?? null,
    block: walk.block ?? null,
  };
}

/* --- the scene's geometry ------------------------------------------------

   THESE ARE SPATIAL CLAIMS, SO THEY LIVE WHERE A TEST CAN REACH THEM. They
   were in `components/float/OnePaymentScene.tsx`, which no test under
   `lib/*.test.ts` can see, and "the agent is never on the money plane" is
   exactly the kind of sentence that should fail a suite rather than a review.

   TWO PLANES, AND THE SECOND ONE IS THE POINT. `z.money` carries everything
   that holds or moves USDC. `z.offPlane` carries the two things that do not:
   the agent, which sends an instruction down a dashed tether and holds
   nothing, and the benchmark, which checks a price and never touches a
   balance. In the flat diagram the agent hangs above the rail and a reader
   takes the gap on trust; here it is off the plane from every angle the
   camera can reach, which is the whole reason the camera is allowed to move.

   Y IS THE LOG INDEX, so only a beat with a log gets a height. `floor` and
   `ceil` bound the normalised 0..1 that `heights()` produces. `agentY` and
   `benchmarkY` sit above `ceil` on purpose: they are off the axis, not at the
   top of it, because a position on an axis of log indices would be a number
   nobody measured. */
export const SCENE = {
  x: { agent: 0, treasury: -2.3, sleeve: 0, seller: 2.3, venue: 0 },
  /* THREE PLANES, AND Z NOW MEANS "WHOSE MONEY-TOUCHING IS THIS".
   *
   *  `offPlane` behind: touches no money at all. The agent sends an instruction
   *  and the benchmark reads a price; neither can hold a balance.
   *  `money`: ours, and holds or moves it.
   *  `outside` in front: touches our money and is NOT ours. Exactly one thing
   *  is here, the yield venue, and it is the one `WhoTouches` marks "not ours"
   *  because it could close our exit. Putting it in front rather than behind is
   *  deliberate: it is nearest the reader, because it is the counterparty. */
  z: { money: 0, offPlane: -1.7, outside: 1.7 },
  floor: 0.3,
  ceil: 2.3,
  /** Above the rail, centred, and off the money plane. */
  agentY: 3.3,
  /** Above the treasury, because the treasury is what does the checking. */
  benchmarkY: 2.95,
} as const;

/** Where a beat sits in the scene, or `null` when it has no business there.
 *
 *  `null` for any beat without a log: the ask and the fair check are real
 *  events and they are drawn, but they are drawn OFF the axis, by their own
 *  components, at their own fixed heights. */
/** Which plane a column sits on. The money path is ours; the venue is not. */
export const PLANE: Record<Column, number> = {
  agent: SCENE.z.offPlane,
  treasury: SCENE.z.money,
  sleeve: SCENE.z.money,
  seller: SCENE.z.money,
  venue: SCENE.z.outside,
};

export function pointOf(b: Beat): [number, number, number] | null {
  if (b.height === null) return null;
  const col = COLUMN[b.key];
  return [SCENE.x[col], SCENE.floor + b.height * (SCENE.ceil - SCENE.floor), PLANE[col]];
}

/** The agent's fixed point. Off the money plane, above the rail, no log. */
export function agentPoint(): [number, number, number] {
  return [SCENE.x.agent, SCENE.agentY, SCENE.z.offPlane];
}

/** The benchmark's fixed point. Off the money plane, over the treasury. */
export function benchmarkPoint(): [number, number, number] {
  return [SCENE.x.treasury, SCENE.benchmarkY, SCENE.z.offPlane];
}

/** The stations a run lights, in order, skipping what did not happen.
 *
 *  SKIPPED AND NOT ANIMATED, which is the rule `MoneyPath` already follows: a
 *  payment the buffer covered never pulled from anywhere, and walking a reader
 *  past a venue station that did nothing would be telling them a payment took a
 *  hop it did not take. The venue goes when there is no venue log, which covers
 *  both a buffer-covered payment and a pull from the USYC reserve; our sleeve's
 *  own station goes when the payment never claimed to be funded that way. */
export function runOrder(beats: readonly Beat[], jit: boolean): BeatKey[] {
  return beats
    .filter((b) => (b.key === "venue" ? b.logIndex !== null : true))
    .filter((b) => (b.key === "pull" ? jit : true))
    .map((b) => b.key);
}

/** Which beats are lit at a given step of a run. Cumulative: a station that has
 *  lit stays lit, as `LoopFlow`'s and `MoneyPath`'s do. */
export function litAt(order: readonly BeatKey[], step: number): Set<BeatKey> {
  return new Set(order.slice(0, Math.max(0, step + 1)));
}
