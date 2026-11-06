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
export type BeatKey = "ask" | "fair" | "pull" | "pay" | "receipt";

export type Beat = {
  key: BeatKey;
  /** The walk's own step number. `null` for the ask, which the walk does not
   *  model because there is nothing on chain to model. */
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
export const COLUMN: Record<BeatKey, "agent" | "treasury" | "sleeve" | "seller"> = {
  ask: "agent",
  fair: "treasury",
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
  const keys: BeatKey[] = ["ask", "fair", "pull", "pay", "receipt"];
  return keys.map((key) => ({
    key,
    n: key === "ask" ? null : ((["fair", "pull", "pay", "receipt"].indexOf(key) + 1) as 1 | 2 | 3 | 4),
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
    { key: "pull", n: 2 },
    { key: "pay", n: 3 },
    { key: "receipt", n: 4 },
  ];
  const idx = steps.map((s) => s.log_index).filter((i): i is number => typeof i === "number");
  const h = heights(idx);

  return keys.map(({ key, n }) => {
    /* The ask has no step and never will: the agent asking is an MCP call, not
       a log. It is drawn from the tether, not from the axis. */
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

  if (!newest || walk?.status !== "ok" || !walk.tx) {
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
    premiumBps: newest.premium_bps,
    fairMatches: walk.fair_matches ?? null,
    jit: Boolean(walk.jit_funded),
    human: Boolean(walk.human_approved),
    guest: Boolean(walk.guest),
    indexName: walk.index_name ?? null,
    sellerAddr: walk.seller ?? null,
    block: walk.block ?? null,
  };
}
