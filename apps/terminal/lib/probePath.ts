/* Which paths the /developers probe may fetch, as the exact string it fetches.
 *
 * It was an exact allowlist (`RUNNABLE`), which is why the endpoint table could
 * not run the reads a visiting team most wants to try: `/tca/{payer}` and
 * `/rating/{seller}` need THEIR wallet in the path, and `/par` was pinned to one
 * 0.02 x 10 bill. Now three templated families are accepted too, each parsed
 * and REBUILT here, so what reaches the press is assembled from validated parts
 * and never the caller's string:
 *
 *   /tca/0x<40 hex>[?days=1..365]      → /tca/<addr>?days=<n>      (default 30)
 *   /rating/0x<40 hex>[?days=1..365]   → /rating/<addr>?days=<n>
 *   /par?unit=…&billed_usdc=…&quantity=…[&vendor=0x…]  → parPath(parseParQuery(…))
 *
 * Everything else must still be an exact `RUNNABLE` entry: no paid route, no
 * POST, nothing a probe cannot honestly run.
 */

import { RUNNABLE } from "./endpoints";
import { parPath, parseParQuery } from "./parQuery";

/** The window a wallet read uses when none is given: the MCP plugin's default. */
export const PROBE_DAYS = 30;

const BASE = "http://probe.invalid";
const WALLET_READ = /^\/(tca|rating)\/(0x[0-9a-fA-F]{40})$/;
const PAR_KEYS = new Set(["unit", "billed_usdc", "quantity", "vendor"]);

/** The canonical path to fetch, or null when the probe must refuse it. */
export function runnablePath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 400) return null;
  if (RUNNABLE.has(raw)) return raw;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  let u: URL;
  try {
    u = new URL(raw, BASE);
  } catch {
    return null;
  }
  // A path that normalises somewhere else (`/tca/../health`) is refused, not followed.
  if (u.origin !== BASE || u.hash) return null;
  const keys = [...u.searchParams.keys()];

  const wallet = WALLET_READ.exec(u.pathname);
  if (wallet && raw.split("?")[0] === u.pathname) {
    if (keys.some((k) => k !== "days") || u.searchParams.getAll("days").length > 1) return null;
    const d = u.searchParams.get("days");
    const days = d === null ? PROBE_DAYS : Number(d);
    if (!Number.isInteger(days) || days < 1 || days > 365) return null;
    return `/${wallet[1]}/${wallet[2]}?days=${days}`;
  }

  if (u.pathname === "/par" && raw.startsWith("/par?")) {
    if (keys.some((k) => !PAR_KEYS.has(k)) || keys.length !== new Set(keys).size) return null;
    const q = parseParQuery((k) => u.searchParams.get(k));
    return q.ok ? parPath(q.q) : null;
  }
  return null;
}
