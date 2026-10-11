import { loadTerminal } from "./api";
import { CHAINS, type ChainKey } from "./chainChoice";
import { halfCiBp, heroFigure } from "./format";
import { freshnessLine } from "./og";
import type { RateSvgInput } from "./badge";
import type { Envelope, PrintRow, TerminalData } from "./types";

/* One print, read the way the hero reads it, shaped for an image.
 *
 * Server-side: the badge, the card and the preview images all start here, so
 * they cannot disagree with each other or with the front page about which
 * figure is THE figure (the on-chain print when there is one, the estimator
 * otherwise, via `heroFigure`) or about how old it is (`freshnessLine`, which
 * judges against the press's own settle window).
 */

export interface RateFigure extends RateSvgInput {
  print: PrintRow;
  env: Envelope<TerminalData>;
}

export function figureFor(
  env: Envelope<TerminalData>,
  chain: ChainKey,
  index: string,
  host?: string,
): RateFigure | null {
  const print = env.data.prints?.[index];
  if (!print) return null;
  const h = heroFigure(print);
  const nowS = Math.floor(Date.now() / 1000);
  const { text, state } = freshnessLine(h.posted_at, nowS, h.onchain);
  const ageS = h.posted_at ? Math.max(0, nowS - h.posted_at) : null;
  return {
    print,
    env,
    index,
    value: h.value,
    unit: print.unit,
    state,
    ageS,
    line: text,
    chain: CHAINS[chain].profile.name,
    ciHalfBp: halfCiBp(h),
    costToMove1pct: print.cost_to_move_1pct,
    host,
  };
}

export async function loadFigure(chain: ChainKey, index: string, host?: string): Promise<RateFigure | null> {
  return figureFor(await loadTerminal(chain), chain, index, host);
}
