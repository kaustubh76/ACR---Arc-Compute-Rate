/* Server-side data loading, once per chain.
 *
 * Route handlers and server components share this — the browser only ever talks
 * to the Next proxy routes for reads (FastAPI's CORS list is an exact-string
 * allowlist, and this keeps the offline "archived edition" logic in one place).
 *
 * EVERY ENTRY POINT TAKES THE CHAIN FIRST, and that is the safety mechanism
 * rather than a stylistic choice. One deployment now serves Arc mainnet and Arc
 * testnet, and a visitor picks. Making `chain` a required leading argument turns
 * every one of the ~30 existing call sites into a compile error, which is what a
 * reviewer wants: `fetchLiveMeta("/revenue")` does not quietly keep working with
 * the path bound to the chain parameter, because `"/revenue"` is not a
 * `ChainKey`. The alternative — reading the cookie in here through
 * `next/headers` — would have been fewer edits and would also have made this
 * module unreachable from `npm test`, which runs no request scope.
 *
 * The chain is NEVER held in a module variable. A warm lambda serves many
 * visitors; a `let chain` here would be one visitor's choice applied to the
 * next one's render. Each caller resolves it per request (`requestChain(req)` in
 * lib/envelope.ts, or `cookies()` in a page) and passes it down.
 */

import { chainMismatch, isHostFailure, publishedSeller, sellerCandidates, servesPath } from "./apiBase";
import { CHAINS, chainCandidates, emptyTerminal, type ChainKey } from "./chainChoice";
import { makeLadder } from "./sellerLadder";
import type { Envelope, TerminalData } from "./types";
import fallback from "./fallback.json";

/** The configured override per chain. `ACR_API` names the default chain's seller,
 *  as it always has; `ACR_API_TESTNET` names the other one. A single `ACR_API`
 *  could not mean both once there were two. */
function configuredFor(chain: ChainKey): string {
  const raw = chain === "mainnet" ? process.env.ACR_API : process.env.ACR_API_TESTNET;
  return (raw?.trim() || "").replace(/\/$/, "");
}

/* ONE MORE RUNG ON THE LADDER, and the reason it exists.
 *
 * `ACR_API` is an operator override, and for two days it named a Render service
 * that had been SUSPENDED — every request got 503 "This service has been
 * suspended by its owner", so every route on the live terminal silently served
 * the archived bundle while the mainnet seller sat there answering fine. The
 * product whose whole job is showing live data showed a fortnight-old snapshot,
 * and nothing anywhere said why.
 *
 * So: a WORKING override still wins outright — a preview, a fork or a testnet
 * deployment is untouched, and nothing here overrides a host that answers. But
 * when the configured seller is unreachable, times out, or returns 5xx, we try
 * this build's published seller before falling all the way back to the archive.
 * A 4xx is NOT a failure of the host — a 402 from the paywall and a 404 from a
 * missing series are both correct answers — so those never trigger it.
 *
 * The rung is only defensible because it is OBSERVABLE: `baseState()` reports
 * which host is being used and whether we fell back, and /api/health and
 * /api/probe surface it. Silence is what made the original fault survive. */
interface Rig {
  chain: ChainKey;
  /** The chain the VISITOR asked for. What identity is judged against now. */
  wantedChainId: number;
  configured: string;
  published: string;
  candidates: string[];
  ladder: ReturnType<typeof makeLadder>;
  /** Hosts already judged on identity, PER CHAIN. One shared map would let the
   *  mainnet rig's refusal of the testnet host poison the testnet rig, because
   *  the verdict is "may this host serve chain X" and X differs. */
  identity: Map<string, string | null>;
  /** Which paths each host's own `/openapi.json` says it serves, or null when
   *  it could not be read. Memoised per host exactly like `identity`, and for
   *  the same reason: it is a fact about a deployment, not about a request. */
  serves: Map<string, Set<string> | null>;
  /** The 5s memo, per chain. Module-scope before, and therefore shared across
   *  visitors on a warm lambda — which is the real defect, not an inconvenience. */
  memo: { at: number; env: Envelope<TerminalData> } | null;
}

const rigs = new Map<ChainKey, Rig>();

function rigFor(chain: ChainKey): Rig {
  const found = rigs.get(chain);
  if (found) return found;
  const configured = configuredFor(chain);
  const published =
    chain === "mainnet"
      ? publishedSeller().replace(/\/$/, "")
      : CHAINS.testnet.published.replace(/\/$/, "");
  const candidates =
    chain === "mainnet"
      ? sellerCandidates(configured, published)
      : chainCandidates(chain, configured, process.env.NODE_ENV);
  const rig: Rig = {
    chain,
    wantedChainId: CHAINS[chain].chainId,
    configured,
    published,
    candidates,
    ladder: makeLadder(candidates, (from, to) =>
      console.warn(
        `[terminal] seller ${from} is not serving on ${chain}; falling back to ${to}. ` +
          "Fix the variable; this rung is a cushion, not a cure.",
      ),
    ),
    identity: new Map(),
    serves: new Map(),
    memo: null,
  };
  rigs.set(chain, rig);
  return rig;
}

/** Null when this host may serve this chain; otherwise why it may not.
 *
 *  A failed or unparseable probe allows the host: a blink is not evidence that it
 *  is on the wrong chain, and refusing a good seller would be the worse bug.
 *
 *  COMPARED AGAINST THE REQUESTED CHAIN, not against the bundle's. It used to
 *  read `BUILD_CHAIN_ID` out of `fallback.json`, which meant a perfectly healthy
 *  testnet press was refused on a build shipping a mainnet bundle — measured on
 *  the live deployment, which reported `fellBack: true` with the configured host
 *  in `refused`. The guard keeps its whole purpose (it exists because a resumed
 *  host on the other network once served its data under a mainnet UI) and gains
 *  correctness, because it now knows what "wrong chain" means per request. */
async function identityProblem(rig: Rig, base: string): Promise<string | null> {
  if (!rig.wantedChainId) return null;
  const known = rig.identity.get(base);
  if (known !== undefined) return known;
  let verdict: string | null = null;
  try {
    const res = await fetch(`${base}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const body = (await res.json()) as { chain_id?: unknown };
      verdict = chainMismatch(rig.wantedChainId, body?.chain_id);
    }
  } catch {
    verdict = null;
  }
  rig.identity.set(base, verdict);
  if (verdict) console.warn(`[terminal] refusing ${base} for ${rig.chain}: ${verdict}`);
  return verdict;
}

/** Whether this host simply does not have the route — as opposed to failing.
 *
 *  Asked only after a 404, and answered by the host's own `/openapi.json`.
 *  One fetch per host per process, memoised like `identityProblem`'s `/health`
 *  probe above; ~39 KB measured against the live presses, under a second. It
 *  is `scripts/verify_deploy_drift.py` run for the visitor instead of for the
 *  operator, and it means the honest message below disappears by itself when
 *  the host is redeployed — nothing to remember, nothing to un-hardcode.
 *
 *  UNREADABLE MEANS "DO NOT CLAIM". If the spec cannot be fetched this returns
 *  false, so the answer stays the ordinary failure. Absence of evidence is not
 *  evidence, the same rule `identityProblem` applies to a missing chain id.
 */
async function routeAbsent(rig: Rig, base: string, path: string): Promise<boolean> {
  const served = await specFor(rig, base);
  return served !== null && !servesPath(served, path);
}

/** The paths a host says it serves, fetched once and remembered.
 *
 *  FACTORED OUT BECAUSE IT HAS TWO READERS AND THEY MUST AGREE. `routeAbsent`
 *  asks it after a 404 to decide what to call the failure; `servedPaths` asks
 *  it up front so a page can avoid offering a control that could only fail.
 *  Two copies of this fetch would be two answers to "does this host have that
 *  route", and the UI would eventually show a button for a route the error
 *  path already knows is missing.
 *
 *  `null` means the spec could not be read, which is NOT "serves nothing".
 *  Both callers treat it as "cannot tell" and fall back to today's behaviour —
 *  the same rule `identityProblem` applies to a missing chain id.
 */
async function specFor(rig: Rig, base: string): Promise<Set<string> | null> {
  const known = rig.serves.get(base);
  if (known !== undefined) return known;
  let served: Set<string> | null = null;
  try {
    const res = await fetch(`${base}/openapi.json`, {
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const spec = (await res.json()) as { paths?: Record<string, unknown> };
      if (spec?.paths) served = new Set(Object.keys(spec.paths));
    }
  } catch {
    /* unreadable: stays null, and every caller reports "cannot tell" */
  }
  rig.serves.set(base, served);
  return served;
}

/** Which paths this chain's press serves, or null if it would not say.
 *
 *  For a surface that advertises runnable endpoints: /developers lists what the
 *  PRODUCT serves (`lib/endpoints.ts`, pinned against `app.openapi()`), and
 *  that register is right even when the deployment behind it is older. Which of
 *  those a visitor can actually run today is a different, per-host fact, and
 *  this is it.
 */
export async function servedPaths(chain: ChainKey): Promise<string[] | null> {
  const rig = rigFor(chain);
  const served = await specFor(rig, rig.ladder.state().active);
  return served === null ? null : [...served];
}

export function apiBase(chain: ChainKey): string {
  return rigFor(chain).ladder.state().active;
}

/** Which seller is actually serving this chain, and whether it is the configured
 *  one. Read by /api/health and /api/probe so a stale override announces itself
 *  instead of quietly demoting the whole terminal to the archive. */
export function baseState(chain: ChainKey): {
  chain: ChainKey;
  active: string;
  configured: string | null;
  published: string;
  fellBack: boolean;
  buildChainId: number;
  refused: Record<string, string>;
} {
  const rig = rigFor(chain);
  const { active, fellBack } = rig.ladder.state();
  const refused: Record<string, string> = {};
  for (const [base, why] of rig.identity) if (why) refused[base] = why;
  return {
    chain,
    active,
    configured: rig.configured || null,
    published: rig.published,
    fellBack,
    // Kept under its published name: /api/health has reported this key since the
    // chain-identity guard shipped, and it is the chain being enforced — which is
    // now the requested one rather than the bundle's.
    buildChainId: rig.wantedChainId,
    refused,
  };
}

export type UpstreamStatus = "ok" | "error" | "timeout";

/** A raw fetch that climbs this chain's ladder, for callers that need the
 *  Response itself rather than parsed JSON — /api/probe reports a status and a
 *  body, so it cannot go through fetchLiveMeta. Without this it would call the
 *  configured host directly and report 503 while every data route on the same
 *  page worked, which is a worse kind of confusing than the bug it is
 *  diagnosing. Returns the base that actually answered, so the caller can say so.
 *
 *  `init` is forwarded whole, which is how a caller-supplied `AGENT-CARD` header
 *  reaches the press — the one path by which a browser's card can be presented
 *  upstream. */
export async function sellerFetch(
  chain: ChainKey,
  path: string,
  init: RequestInit,
): Promise<{ res: Response; base: string }> {
  const rig = rigFor(chain);
  /* A Response or the reason there isn't one. The ladder decides between hosts;
     an unreachable host has no Response, so the error travels with the attempt
     and is re-thrown below if every candidate failed — a fabricated Response
     would be worse than the exception the caller already handles. */
  type RawTry = { res: Response | null; base: string; error?: unknown };

  const out = await rig.ladder.run<RawTry>(async (base) => {
    try {
      const res = await fetch(`${base}${path}`, init);
      const bad = isHostFailure(res.status) || (res.ok && Boolean(await identityProblem(rig, base)));
      return { ok: !bad, hostFailed: bad, value: { res, base } };
    } catch (error) {
      return { ok: false, hostFailed: true, value: { res: null, base, error } };
    }
  });

  if (!out.res) throw out.error ?? new Error(`seller ${out.base} is unreachable`);
  return { res: out.res, base: out.base };
}

/** An upstream answer that was a NO rather than a failure.
 *
 *  THE PROBLEM THIS SOLVES. `fetchLive` returns `T | null`, so every unhappy
 *  answer arrives at the browser as `{live: false, data: null}` — a press that
 *  is down and a press that refused you are the same empty page. That was
 *  harmless while nothing upstream could refuse a read. The moment
 *  `ACR_OPERATOR_READ_SCOPE` is on, the press answers four deliberately
 *  different sentences and this hop was about to flatten all four into silence.
 *
 *  ONLY 401 AND 403 TRAVEL THIS CHANNEL, and the narrowness is the point. A 404
 *  for an unknown business keeps answering exactly as it does today — a 200
 *  envelope with `data: null`, which `/traction` and `scripts/verify_operator.py`
 *  both already depend on. Widening this to every 4xx would be a bigger change
 *  wearing this one's clothes.
 */
export interface Refusal {
  status: number;
  /** The press's own `detail`: an object for the 401 challenge, a sentence for
   *  the 403s. Passed through unread — this hop does not get to paraphrase a
   *  refusal it did not make. */
  detail: unknown;
  /** `AgentCard`, when the press sent it. The client reads it to tell "you need
   *  a card" from "your card is not the problem". */
  authenticate?: string;
}

/** Whether an upstream status is a refusal of THIS caller rather than a fault.
 *  Separate from `isHostFailure` on purpose: that one decides whether to climb
 *  the ladder, this one decides whether there is a sentence worth carrying. */
function isRefusal(status: number): boolean {
  return status === 401 || status === 403;
}

async function readRefusal(res: Response): Promise<Refusal> {
  const authenticate = res.headers.get("WWW-Authenticate") ?? undefined;
  try {
    const body = (await res.json()) as { detail?: unknown };
    return { status: res.status, detail: body?.detail ?? body, ...(authenticate ? { authenticate } : {}) };
  } catch {
    // A refusal with an unparseable body is still a refusal; the status is the
    // part the client acts on, and inventing a sentence here would be worse
    // than admitting there wasn't one.
    return { status: res.status, detail: null, ...(authenticate ? { authenticate } : {}) };
  }
}

/** Like fetchLive, but reports WHY the upstream failed so proxies can stamp
 *  `upstream` on their envelope — the UI renders "press unreachable"
 *  differently from a genuine empty feed. Failures are logged (once per call)
 *  so a fall-back to the archived edition is diagnosable from server logs.
 *
 *  `headers` is optional and forwarded: the operator surfaces need to pass a
 *  caller's agent card upstream, and this is the helper they go through. */
export async function fetchLiveMeta<T>(
  chain: ChainKey,
  path: string,
  timeoutMs = 5000,
  headers?: Record<string, string>,
): Promise<{ data: T | null; upstream: UpstreamStatus; refusal?: Refusal }> {
  const rig = rigFor(chain);
  type Meta = { data: T | null; upstream: UpstreamStatus; refusal?: Refusal };
  return rig.ladder.run<Meta>(async (base) => {
    try {
      const res = await fetch(`${base}${path}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
        ...(headers ? { headers } : {}),
      });
      if (res.ok) {
        const wrongChain = await identityProblem(rig, base);
        if (wrongChain) {
          return {
            ok: false,
            hostFailed: true,
            value: { data: null, upstream: "error" as UpstreamStatus },
          };
        }
        return {
          ok: true,
          hostFailed: false,
          value: { data: (await res.json()) as T, upstream: "ok" as UpstreamStatus },
        };
      }
      console.warn(`[terminal] upstream ${res.status} on ${path} (${chain})`);
      /* A 404 is either "this deployment predates the route" or an ordinary
         not-found, and only the host's own spec can say which. Asked here
         rather than guessed from the body, and only on a 404, so the common
         paths pay nothing for it. */
      const absent = res.status === 404 && (await routeAbsent(rig, base, path));
      return {
        ok: false,
        hostFailed: isHostFailure(res.status),
        value: {
          data: null,
          upstream: (absent ? "absent" : "error") as UpstreamStatus,
          // The ladder already stops here — "an answer, even an unwelcome one,
          // ends it" — so a 401 is never retried against the fallback host,
          // which would be asking a second press to agree about a credential.
          ...(isRefusal(res.status) ? { refusal: await readRefusal(res) } : {}),
        },
      };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      console.warn(`[terminal] upstream ${timedOut ? "timeout" : "unreachable"} on ${path} (${chain})`);
      return {
        ok: false,
        hostFailed: true,
        value: { data: null, upstream: (timedOut ? "timeout" : "error") as UpstreamStatus },
      };
    }
  });
}

export async function fetchLive<T>(
  chain: ChainKey,
  path: string,
  timeoutMs = 5000,
  headers?: Record<string, string>,
): Promise<T | null> {
  return (await fetchLiveMeta<T>(chain, path, timeoutMs, headers)).data;
}

/** The same contract for a POST body — the tape's read proxy is a POST, because
 *  the query text lives server-side and the caller names an allowlisted
 *  operation rather than sending GraphQL. Same timeout, same one-line log, same
 *  `upstream` stamp, so a subgraph outage is diagnosable exactly like a press
 *  outage instead of arriving as an unexplained empty page. */
export async function postLiveMeta<T>(
  chain: ChainKey,
  path: string,
  body: unknown,
  timeoutMs = 8000,
  headers?: Record<string, string>,
): Promise<{ data: T | null; upstream: UpstreamStatus }> {
  const rig = rigFor(chain);
  return rig.ladder.run<{ data: T | null; upstream: UpstreamStatus }>(async (base) => {
    try {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        const wrongChain = await identityProblem(rig, base);
        if (wrongChain) {
          return {
            ok: false,
            hostFailed: true,
            value: { data: null, upstream: "error" as UpstreamStatus },
          };
        }
        return {
          ok: true,
          hostFailed: false,
          value: { data: (await res.json()) as T, upstream: "ok" as UpstreamStatus },
        };
      }
      console.warn(`[terminal] upstream ${res.status} on POST ${path} (${chain})`);
      return {
        ok: false,
        hostFailed: isHostFailure(res.status),
        value: { data: null, upstream: "error" as UpstreamStatus },
      };
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      console.warn(
        `[terminal] upstream ${timedOut ? "timeout" : "unreachable"} on POST ${path} (${chain})`,
      );
      return {
        ok: false,
        hostFailed: true,
        value: { data: null, upstream: (timedOut ? "timeout" : "error") as UpstreamStatus },
      };
    }
  });
}

/** What this chain falls back to while the press is cold.
 *
 *  Mainnet gets the bundled snapshot. **No other chain does**, and that is the
 *  point rather than an omission: `fallback.json` IS a mainnet snapshot, and
 *  `lib/mainnetOnly.test.ts` asserts field by field that it stays one. Serving it
 *  under another chain's label is the exact incident that test exists for — it
 *  carried eleven testnet venue fills under a mainnet header as recently as
 *  2026-09-28. So the other chain gets an empty payload carrying a truthful chain
 *  block, and the connection ladder renders "waking", which is also simply true
 *  of a free box with a measured 18-19s cold start. */
export function cushion(chain: ChainKey): TerminalData {
  return CHAINS[chain].bundle
    ? (fallback as unknown as TerminalData)
    : emptyTerminal(chain);
}

/** Bundled snapshot sections (marketplace / revenue / x402 / exchange sample) so
 *  the crypto-dense proxies never fall back to null. Optional keys — an older
 *  bundle just yields undefined and the proxy keeps its legacy offline shape.
 *
 *  Answers undefined on a chain with no bundle, which is the honest shape: those
 *  proxies then serve their own empty state rather than another chain's numbers. */
export function bundleSection<K extends keyof TerminalData>(
  chain: ChainKey,
  key: K,
): TerminalData[K] | undefined {
  return CHAINS[chain].bundle ? (fallback as unknown as TerminalData)[key] : undefined;
}

const MEMO_MS = 5_000;

/** Synchronous peek for the layout shell: the last-known envelope if any fetch
 *  has resolved for this chain, else this chain's cushion with `fetchedAt: 0` —
 *  the sentinel the client connection ladder reads as "provisional, no live
 *  fetch has been attempted yet" (rendered as *linking*, never as a false
 *  *archived*). Never blocks; the shell paints instantly regardless of the
 *  backend. */
export function peekTerminal(chain: ChainKey): Envelope<TerminalData> {
  const rig = rigFor(chain);
  if (rig.memo) return rig.memo.env;
  return { live: false, data: cushion(chain), fetchedAt: 0, chain };
}

export async function loadTerminal(chain: ChainKey): Promise<Envelope<TerminalData>> {
  const rig = rigFor(chain);
  if (rig.memo && Date.now() - rig.memo.at < MEMO_MS) return rig.memo.env;
  // /terminal/data does 3 on-chain reads + a derived payload; a warm box answers
  // in ~3-5s, so allow generous headroom before falling back to the cushion.
  const data = await fetchLive<TerminalData>(chain, "/terminal/data", 9000);
  const env: Envelope<TerminalData> = data
    ? { live: true, data, fetchedAt: Date.now(), chain }
    : { live: false, data: cushion(chain), fetchedAt: Date.now(), chain };
  rig.memo = { at: Date.now(), env };
  return env;
}
