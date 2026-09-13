/* Verified humans, as the Terminal counts them.
 *
 * This file is the FOURTH implementation of one arithmetic. `HumanIdMirror.sol`
 * decides which window a resolution may be recorded for, `graph/src/parties.ts`
 * decides which window a settlement looks for a cluster in, `index_api.tca`
 * decides which window a seller rating reads its human count from — and now this
 * decides which window the chrome counts. `tests/test_human_window_parity.py`
 * already pins the first three to each other by reading them off disk;
 * `humans.test.ts` pins this one the same way, for the same reason.
 *
 * If it drifts, nothing raises. The strip looks for clusters in a window nobody
 * minted ids for, finds none, and the footer says the benchmark is secured by
 * nobody — a silent zero, under a live block number that makes it look checked.
 *
 * NO JSX HERE ON PURPOSE. lib/coverage.test.ts counts edition markers only under
 * app/ and components/, so copy that moved into a .ts would stop being counted
 * AND stop being linted for banned jargon. Structure lives here; every word the
 * reader sees stays in the .tsx. lib/endpoints.ts documents the same split.
 */

/** Seconds per rotation window. Pinned to `HumanIdMirror.RATING_WINDOW`. */
export const RATING_WINDOW_S = 604800;

/** The same span in days, for copy that says "7 days" rather than "604800". */
export const RATING_WINDOW_DAYS = RATING_WINDOW_S / 86400;

/** One wallet inside a cluster, as the `humans` operation returns it. */
export interface HumanWalletRow {
  id: string;
  totalVolume?: string | number;
  settlementCount?: string | number;
}

/** One cluster as the `humans` operation returns it. BigInts arrive as strings. */
export interface HumanClusterRow {
  id: string;
  window: string | number;
  sandbox: boolean;
  walletCount: number;
  firstSeen?: string | number;
  wallets?: readonly HumanWalletRow[];
}

/** What the chrome renders. Every field is a count of ONE window.
 *
 *  `n` is deliberately never optional and never defaulted: a caller that could
 *  not read the tape gets `null` for the whole object rather than a zero here.
 *  "The press is down" and "nobody is verified" are different facts, and the
 *  ChainStrip renders them differently. */
export interface HumanCount {
  /** Distinct verified humans RESOLVED in `window`.
   *
   *  Resolved is not the same as securing anything, and the copy must not blur
   *  them — see `traded`. */
  n: number;
  /** Of `n`, how many have actually settled a purchase on this tape.
   *
   *  THE NUMBER THE SECURITY CLAIM RESTS ON. A human who registered a wallet
   *  and never traded contributes no observation, so the manipulation bound
   *  cannot be denominated in them; saying the benchmark is "secured by" them
   *  would be W7's fatal headline in a quieter form. Today this is 0 while `n`
   *  is not, and the chrome says so rather than rounding the difference away.
   *
   *  It is also what keeps this surface consistent with /tape, which reports
   *  human depth per seller from `SellerWindow.distinctHumans` — a count of
   *  humans who TRADED with that seller. Two surfaces disagreeing about how
   *  many humans exist is worse than either number alone. */
  traded: number;
  /** How many of `n` are Sandbox identities rather than Orb-verified people. */
  sandbox: number;
  /** True when the whole count is Sandbox, which is what the caveat keys on. */
  allSandbox: boolean;
  /** Wallets those humans are resolved to — always >= n, and the fleet story. */
  wallets: number;
  window: number;
  /** The newest window clusters WERE resolved in, when none match the one asked for.
   *
   *  THE THIRD STATE. `n === 0` otherwise means two different things at once:
   *  nobody has ever been verified, and the resolver is a rotation window behind.
   *  The first is a fact about the world; the second is an operator action, and
   *  collapsing them renders the human layer as silence with nothing saying why.
   *
   *  null when rows matched the asked window, and null when there are no rows at
   *  all — so `n === 0 && staleWindow !== null` is exactly "these resolutions
   *  belong to an earlier window".
   *
   *  This file already drew the null-vs-zero distinction one field up ("an unread
   *  tape is null, never zero") and then collapsed a different pair of distinct
   *  facts immediately below it. Knowing the principle did not make it apply twice. */
  staleWindow: number | null;
}

/** The rotation window a timestamp falls in.
 *
 *  Takes the time rather than reading a clock, so the caller can pass the
 *  SUBGRAPH's block timestamp. That matters: the window a cluster id was minted
 *  for is a fact about chain time, and a browser whose clock is a few minutes
 *  fast near a boundary would look for ids in a window that does not exist yet.
 *  `HumanIdMirrorClient.chain_window()` refuses the local clock for the same
 *  reason. */
export function currentWindow(nowS: number): number {
  return Math.floor(nowS / RATING_WINDOW_S);
}

/** Count the humans in ONE window, never across several.
 *
 *  A cluster id is minted per window, so the same person carries a different id
 *  in each. Summing two windows would multiply one human into two — which is
 *  also why `tca.py` refuses a request longer than the window rather than
 *  serving a blended number. The `humans` operation returns every window it has
 *  ever indexed, so this filter is the whole safety of the count.
 *
 *  Rows are counted by entity id, so a duplicate row cannot inflate `n`. */
export function countHumans(
  rows: readonly HumanClusterRow[] | null | undefined,
  window: number,
): HumanCount | null {
  if (rows == null) return null;
  const seen = new Set<string>();
  let sandbox = 0;
  let wallets = 0;
  let traded = 0;
  //  The newest window any row carries, tracked while we are already walking them
  //  so the third state costs no second pass.
  let newestSeen: number | null = null;
  for (const row of rows) {
    const rowWindow = Number(row.window);
    if (Number.isFinite(rowWindow) && (newestSeen === null || rowWindow > newestSeen)) {
      newestSeen = rowWindow;
    }
    if (rowWindow !== window) continue;
    const id = String(row.id).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    if (row.sandbox) sandbox += 1;
    wallets += Number(row.walletCount) || 0;
    // A cluster counts as trading when ANY of its wallets has settled: the
    // whole point of a fleet is that one person's purchases are spread across
    // several addresses, so requiring all of them would undercount the human
    // exactly where the fleet story is strongest.
    if ((row.wallets ?? []).some((w) => (Number(w.settlementCount) || 0) > 0)) traded += 1;
  }
  const n = seen.size;
  //  Only meaningful when nothing matched: if any row was in this window the
  //  resolver is current, and an older window alongside it is just history.
  const staleWindow = n === 0 && newestSeen !== null && newestSeen < window ? newestSeen : null;
  // allSandbox is false on an empty count: "every one of nobody is simulated"
  // is not a claim worth making, and the caveat it drives would read as one.
  return { n, traded, sandbox, allSandbox: n > 0 && sandbox === n, wallets, window, staleWindow };
}

/** `GET /humanid/info`, as the press describes itself.
 *
 *  Read rather than hardcoded so the footer cannot claim a gate the running
 *  service is not using — the mode is an env var, and a page that stated it from
 *  a constant would keep saying "agentkit" after an operator switched it. */
export interface HumanIdInfo {
  backend: string;
  /** Which roster the AgentKit verifier checks a wallet against: `fixture` (the
   *  demo wallets) or `world-chain`. Absent on the dev gate. */
  agentbook?: string | null;
  sandbox: boolean;
  app_id: string | null;
  proof_header: string;
  rotation_window_days: number;
  /** null when there is nothing to compare against; FALSE is a live
   *  misconfiguration that makes every human resolve to an empty union. */
  salt_matches_commitment: boolean | null;
  verified_proofs: number;
  unrecognised_env: string[];
}

/** What `/api/humanid` hands the chrome. Either half may be null on its own. */
export interface HumanIdData {
  info: HumanIdInfo | null;
  humans: HumanCount | null;
  /** The tape returned a full page, so `n` may be a floor rather than a total.
   *  Rendered as "200+" rather than as a confident exact number. */
  truncated: boolean;
}

/** The 401 challenge body, exactly as `humanid.py::_challenge_body` builds it. */
export interface HumanChallenge {
  error: string;
  scheme: string;
  app_id: string | null;
  nonce: string;
  expires_in_seconds: number;
  resource: string;
  sandbox: boolean;
  header: string;
}
