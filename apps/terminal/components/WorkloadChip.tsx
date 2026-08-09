"use client";

/* The reader's bill, in the chrome — but only once it exists.
 *
 * Quiet by default is the rule: a reader who never set a workload gets no nav
 * clutter, no invitation chip, nothing. The single invitation lives on the
 * home page's fixing section-head (WorkloadRow). Once a workload is set, this
 * renders their monthly total on every route, priced live off the same
 * envelope the masthead already holds, and links back to the editor.
 *
 * Renders nothing while marks are missing (cold start, press asleep with no
 * archive): a chip reading "$…" on eight routes would be chrome noise, and
 * `totalCost` returning null instead of $0.00 is the discipline that makes
 * that a one-line check here.
 */

import Link from "next/link";
import { Ed } from "./Ed";
import { useTerminal } from "@/lib/useLive";
import { heroFigure } from "@/lib/format";
import { useWorkload } from "@/lib/useWorkload";
import { compactMoney, totalCost } from "@/lib/workload";
import type { Envelope, TerminalData } from "@/lib/types";

export function WorkloadChip({ initial }: { initial: Envelope<TerminalData> }) {
  const w = useWorkload();
  const env = useTerminal(initial);
  if (!w) return null;

  const marks = Object.fromEntries(
    Object.values(env.data.prints).map((p) => [p.index_id, heroFigure(p).value]),
  );
  const total = totalCost(w, marks);
  if (total === null) return null;

  return (
    <Link
      href="/#fixing"
      className="chip chip-gold"
      title="your declared monthly usage, priced at the current fixing · tap to edit"
    >
      <Ed x="your bill" p="your bill" /> ≈ {compactMoney(total)}/mo
    </Link>
  );
}
