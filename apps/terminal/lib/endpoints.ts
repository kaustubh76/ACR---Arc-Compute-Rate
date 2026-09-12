/* The endpoint register: every route this service exposes, named once.
 *
 * Structure only — no prose. The descriptions stay as `<Ed x= p= />` JSX in
 * app/developers/view.tsx, and that split is deliberate rather than tidy:
 * lib/coverage.test.ts scans only app/ and components/ for edition markers and
 * only lints `p="…"` there, so copy moved into a .ts would silently stop being
 * counted AND stop being checked for banned jargon. The ContractRegister
 * extraction hit the same wall and solved it the same way. chain.test.ts binds
 * the two halves so a path can never lose its description.
 *
 * One list, two consumers: the table on /developers and the allowlist in
 * app/api/probe/route.ts. They were about to be two hand-maintained lists of
 * the same thing, which is exactly how the footer and /developers came to
 * disagree about which contracts exist, and how ENDPOINT_FAMILIES drifted from
 * GATED_ENDPOINTS on the Python side. Twice is enough.
 */

import { INDICES } from "./indices";

/** The families the page groups by. Order is the order they render. */
export const FAMILIES = ["paid", "venue", "market", "demo", "desk", "ops"] as const;
export type Family = (typeof FAMILIES)[number];

export interface EndpointRow {
  method: "GET" | "POST";
  /** The documented path, with `{index_id}` left as a placeholder. */
  path: string;
  /** What the AUTHOR believes the gate is. The page reconciles this against
   *  the press's own `gated_endpoints`, which wins — see `gateFor`. */
  gate: "x402" | "public";
  family: Family;
  /** A concrete free GET the probe may fetch, or null.
   *
   *  Null for every POST (a probe cannot invent a body) and for every paid
   *  route — those must go through the console, which shows the 402 before a
   *  cent moves. `RUNNABLE` is derived from this field alone, so a paid path
   *  can never reach the probe endpoint. */
  run: string | null;
  /** The concrete path the console should load for a paid row. Separate from
   *  `run` precisely so it does NOT widen the probe's allowlist.
   *  `{index_id}` is resolved to the first index; the console lets a reader
   *  change it afterwards. */
  console?: string;
  /** Why an unrunnable row is unrunnable. Four different reasons, and the
   *  page prints the right one: a uniform "needs a session" would be false for
   *  the webhook (Circle calls it), for the demo starters (they just want a
   *  body), and for the tape reads (they want a wallet in the path, and there
   *  is no sensible default to probe with). A row that explains itself wrongly
   *  is worse than one that says nothing. */
  why?: "session" | "post" | "inbound" | "address" | "human";
}

const i0 = INDICES[0];

export const ENDPOINTS: EndpointRow[] = [
  // The five flat-priced gated routes; the sixth, a fleet seller's /compute/{label},
  // is reached through the catalog and excused from this register by name in
  // tests/test_endpoint_register_parity.py. `run` is null: money is involved, so they go
  // through the console, which shows the 402 before anything is paid.
  { method: "GET", path: "/prints", gate: "x402", family: "paid", run: null, console: "/prints" },
  { method: "GET", path: "/prints/{index_id}", gate: "x402", family: "paid", run: null, console: `/prints/${i0}` },
  { method: "GET", path: "/curve/{index_id}", gate: "x402", family: "paid", run: null, console: `/curve/${i0}` },
  { method: "GET", path: "/vol/{index_id}", gate: "x402", family: "paid", run: null, console: `/vol/${i0}` },
  { method: "GET", path: "/seller-scores/{index_id}", gate: "x402", family: "paid", run: null, console: `/seller-scores/${i0}` },

  { method: "GET", path: "/", gate: "public", family: "venue", run: "/" },
  { method: "GET", path: "/onchain/{index_id}", gate: "public", family: "venue", run: `/onchain/${i0}` },
  { method: "GET", path: "/futures", gate: "public", family: "venue", run: "/futures" },
  { method: "GET", path: "/futures/{index_id}", gate: "public", family: "venue", run: `/futures/${i0}` },
  // Missing from this register since it was written, even though it has a hook and
  // a proxy route. Found by tests/test_endpoint_register_parity.py, not by eye.
  { method: "GET", path: "/hedger", gate: "public", family: "venue", run: "/hedger" },

  { method: "GET", path: "/marketplace/catalog", gate: "public", family: "market", run: "/marketplace/catalog" },
  { method: "GET", path: "/marketplace/receipts", gate: "public", family: "market", run: "/marketplace/receipts" },
  { method: "GET", path: "/terminal/data", gate: "public", family: "market", run: "/terminal/data" },

  // The indexed tape. Public reads over an allowlist of named operations —
  // the query text lives server-side, so a caller names an operation rather
  // than sending GraphQL, and the read key is never exposed.
  { method: "GET", path: "/tca/{payer}", gate: "public", family: "market", run: null, why: "address" },
  /* Free like the rest of the marketplace reads, so `gate` is honestly "public":
     that field names the PAYMENT gate and nothing is charged here. What stands
     in front of it is a proof of personhood, which is why it needs a fifth
     `why` — a probe cannot mint one, and none of the four existing reasons is
     true of it. The register's own rule is that a row explaining itself wrongly
     is worse than one saying nothing. */
  { method: "GET", path: "/tca/human", gate: "public", family: "market", run: null, why: "human" },
  { method: "GET", path: "/rating/{seller}", gate: "public", family: "market", run: null, why: "address" },
  { method: "GET", path: "/graph/operations", gate: "public", family: "market", run: "/graph/operations" },
  { method: "POST", path: "/graph/query", gate: "public", family: "market", run: null, why: "post" },
  { method: "GET", path: "/fleet", gate: "public", family: "market", run: "/fleet" },

  { method: "POST", path: "/demo/attack/start", gate: "public", family: "demo", run: null, why: "post" },
  { method: "GET", path: "/demo/attack/status", gate: "public", family: "demo", run: "/demo/attack/status" },
  { method: "POST", path: "/demo/buyer/start", gate: "public", family: "demo", run: null, why: "post" },
  { method: "GET", path: "/demo/buyer/status", gate: "public", family: "demo", run: "/demo/buyer/status" },

  // All POST. A probe cannot mint a session, so these say so rather than
  // offering a button that could only ever fail.
  { method: "POST", path: "/desk/session", gate: "public", family: "desk", run: null, why: "session" },
  { method: "POST", path: "/desk/wallet", gate: "public", family: "desk", run: null, why: "session" },
  { method: "POST", path: "/desk/faucet", gate: "public", family: "desk", run: null, why: "session" },
  { method: "POST", path: "/desk/limits", gate: "public", family: "desk", run: null, why: "session" },
  { method: "POST", path: "/desk/withdrawable", gate: "public", family: "desk", run: null, why: "session" },
  { method: "POST", path: "/desk/challenge", gate: "public", family: "desk", run: null, why: "session" },

  { method: "GET", path: "/revenue", gate: "public", family: "ops", run: "/revenue" },
  { method: "GET", path: "/x402/info", gate: "public", family: "ops", run: "/x402/info" },
  { method: "GET", path: "/humanid/info", gate: "public", family: "ops", run: "/humanid/info" },
  // The agent gate, described by itself — the sibling of /humanid/info. Omitting
  // these three while listing that one was never defensible; it just went unseen.
  { method: "GET", path: "/agent/info", gate: "public", family: "ops", run: "/agent/info" },
  { method: "GET", path: "/agent/challenge", gate: "public", family: "ops", run: "/agent/challenge" },
  { method: "GET", path: "/agent/whoami", gate: "public", family: "ops", run: "/agent/whoami" },
  { method: "GET", path: "/armor/info", gate: "public", family: "ops", run: "/armor/info" },
  { method: "POST", path: "/webhooks/circle", gate: "public", family: "ops", run: null, why: "inbound" },
  { method: "GET", path: "/webhooks/recent", gate: "public", family: "ops", run: "/webhooks/recent" },
  { method: "GET", path: "/health", gate: "public", family: "ops", run: "/health" },
];

/** Exactly the paths the probe may fetch.
 *
 *  Derived, never typed twice: the route matches against this set, so a row
 *  that is not runnable in the register cannot be run through the API either,
 *  and adding a runnable row needs no second edit. Membership is exact — no
 *  prefix matching, so no traversal.
 */
export const RUNNABLE: ReadonlySet<string> = new Set(
  ENDPOINTS.map((e) => e.run).filter((r): r is string => r !== null),
);
