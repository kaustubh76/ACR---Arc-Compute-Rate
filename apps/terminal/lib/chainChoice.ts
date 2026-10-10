/* Which chain a visitor is reading, and everything that follows from it.
 *
 * ACR has partners who need Arc testnet while the product itself is mainnet, so
 * one deployment serves both and a visitor picks. This module is the whole of
 * that decision, kept pure and DOM-free so `node --test lib/*.test.ts` can
 * assert on it — the same split `lib/sellerLadder.ts` and `lib/connection.ts`
 * already use, and the reason neither of those decisions lives in a route
 * handler where nothing could reach it.
 *
 * THREE CARRIERS, AND WHY IT TAKES THREE.
 *
 *   1. a COOKIE, for server rendering. Sent automatically on a document request
 *      and on every same-origin fetch, which a header cannot be (a browser
 *      cannot set one on a navigation, so the first paint could never see it).
 *   2. the chain in the URL QUERY of every client fetch — `apiKey()` below.
 *      This is for correctness, not tidiness. Sixteen route handlers deliberately
 *      answer with `Cache-Control: public, s-maxage=…`, and Vercel's CDN keys on
 *      method and URL, NOT on cookies: Next's `Vary` list carries no cookie and
 *      Vercel documents `Vary` only for its own `X-Vercel-IP-*`. Measured on the
 *      live deployment: two sequential GETs of /api/terminal went
 *      `x-vercel-cache: MISS` then `HIT`. With a cookie alone, the first
 *      visitor's chain would be served from the edge to the next visitor on the
 *      other chain. Marking the non-default response `private, no-store` stops
 *      it POPULATING the cache and does nothing to stop it HITTING an entry
 *      already stored under the same URL — so the URL has to differ.
 *   3. the chain STAMPED ON EVERY ENVELOPE, checked by the client. The guard
 *      that holds no matter what any cache, proxy or missed call site does. The
 *      other two are prevention; this is detection, and this repo's own rule is
 *      that silence is what let the original fault survive.
 *
 * Nothing here needs a new `mainnetOnly.test.ts` ledger entry: the testnet host
 * literal lives in `./apiBase` beside the mainnet one and the chain id comes
 * from `./chain`'s profile, and both files are already in that ledger. Keep
 * every label in this file lowercase — that scan bans the capitalised display
 * name, which is why `ChainStrip` has always shipped the lowercase form. This
 * paragraph originally spelled the banned string out to explain it, and the
 * gate failed on the explanation, which is the gate working.
 */

import { LOCAL_SELLER, MAINNET_SELLER, TESTNET_SELLER } from "./apiBase";
import { CHAIN, CHAIN_TESTNET } from "./chain";
import type { ChainFactsData, TerminalData } from "./types";

export type ChainKey = "mainnet" | "testnet";

/** Readable by the server on every request, and by the client. Deliberately not
 *  `httpOnly`: it is a display preference, not a credential, and the wallet path
 *  reads it in the browser to know which press to pay. */
export const CHAIN_COOKIE = "acr-chain";
/** Rendered on `<html>` by the layout, so the client adopts the server's answer
 *  with no flash and no boot script — unlike the edition toggle, whose truth
 *  lives in localStorage where the server cannot see it. */
export const CHAIN_ATTR = "data-chain";
export const DEFAULT_CHAIN: ChainKey = "mainnet";
export const CHAIN_MAX_AGE_S = 60 * 60 * 24 * 180;
/** The query key `apiKey()` appends, and the one route handlers read. */
export const CHAIN_PARAM = "chain";

export interface ChainChoice {
  key: ChainKey;
  /** From the profile, never retyped here. */
  chainId: number;
  /** The press this build knows for that chain. */
  published: string;
  /** The env var that may override it, if any. */
  envVar: "ACR_API" | "ACR_API_TESTNET";
  profile: typeof CHAIN | typeof CHAIN_TESTNET;
  /** Whether the archived bundle is a valid cushion for this chain.
   *
   *  True for exactly one chain, and it has to be: `lib/fallback.json` is a
   *  mainnet snapshot and `mainnetOnly.test.ts` asserts field by field that it
   *  stays one. Serving it on the other chain is the precise incident that test
   *  exists for — it once carried eleven testnet venue fills under a mainnet
   *  header. So the other chain gets an empty envelope and an honest "waking"
   *  state instead, which is also simply true: that press is a free box with a
   *  measured 18-19s cold start. */
  bundle: boolean;
  /** Whether the direct-from-chain reader tier applies.
   *
   *  Mainnet only, by construction rather than by omission: `lib/onchain.ts`,
   *  `lib/futuresOnchain.ts` and `lib/registryOnchain.ts` take their contract
   *  addresses from the mainnet bundle and bypass the press entirely, and this
   *  repo holds no testnet oracle address at all. Reading mainnet contracts for
   *  a testnet visitor would be the same lie by a different route. */
  directReads: boolean;
}

export const CHAINS: Record<ChainKey, ChainChoice> = {
  mainnet: {
    key: "mainnet",
    chainId: CHAIN.chainId,
    published: MAINNET_SELLER,
    envVar: "ACR_API",
    profile: CHAIN,
    bundle: true,
    directReads: true,
  },
  testnet: {
    key: "testnet",
    chainId: CHAIN_TESTNET.chainId,
    published: TESTNET_SELLER,
    envVar: "ACR_API_TESTNET",
    profile: CHAIN_TESTNET,
    bundle: false,
    directReads: false,
  },
};

export const CHAIN_KEYS: ChainKey[] = ["mainnet", "testnet"];

/** A chain key, or null for anything else. Null rather than a throw or a silent
 *  default, so a caller decides what an unrecognised value means — a stray query
 *  param should fall back, a mismatched envelope should fail. */
export function parseChainKey(raw: unknown): ChainKey | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return v === "mainnet" || v === "testnet" ? v : null;
}

/** The chain a request is for: an explicit query param wins over the cookie,
 *  and the default wins over nothing. The param wins because it is what makes a
 *  cached response correct — a URL carrying `chain=testnet` must never be
 *  answered from the mainnet rig just because this visitor's cookie says so. */
export function resolveChain(param: unknown, cookie: unknown): ChainKey {
  return parseChainKey(param) ?? parseChainKey(cookie) ?? DEFAULT_CHAIN;
}

/** The SWR key / fetch URL for a proxy path on a given chain.
 *
 *  Always stamps the param, including for the default chain. Stamping only the
 *  non-default would leave the default's entries sitting at the bare URL, where
 *  an older deploy's cached response — written before this param existed — can
 *  still answer them. One shape for both chains has no such seam. */
export function apiKey(path: string, chain: ChainKey): string {
  const [base, query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  params.set(CHAIN_PARAM, chain);
  return `${base}?${params.toString()}`;
}

/** Which seller bases to try for a chain, configured override first.
 *
 *  Mirrors `sellerCandidates()` and dedupes the same way: an override equal to
 *  the published host is one candidate, not two. The cushion rung exists because
 *  an `ACR_API` naming a decommissioned host once demoted every route on the
 *  live terminal to the archive for two days. */
export function chainCandidates(chain: ChainKey, configured: string, nodeEnv?: string): string[] {
  const published =
    nodeEnv === "production" || nodeEnv === undefined
      ? CHAINS[chain].published
      : chain === "mainnet"
        ? LOCAL_SELLER
        : CHAINS[chain].published;
  const c = configured.trim().replace(/\/$/, "");
  const p = published.trim().replace(/\/$/, "");
  if (!c) return [p];
  return c === p ? [c] : [c, p];
}

/** The chain block for a chain with no bundle behind it.
 *
 *  Invents nothing. Every value comes from the profile, and the three contract
 *  addresses are null because this repo genuinely does not know them for that
 *  network — `deployedContracts()` then omits those rows rather than printing a
 *  mainnet address under a testnet heading, which is the whole point. */
export function emptyChainFacts(chain: ChainKey): ChainFactsData {
  const p = CHAINS[chain].profile;
  return {
    name: p.name,
    chain_id: p.chainId,
    caip2: p.caip2,
    explorer_base: p.explorer,
    public_rpc_url: p.rpc,
    usdc_address: p.usdc,
    gateway_wallet: p.gatewayWallet,
    circle_blockchain: p.circleBlockchain,
    gateway_chain: p.gatewayChain,
    private_mainnet: p.privateMainnet,
    oracle_address: null,
    registry_address: null,
    futures_address: null,
  } as unknown as ChainFactsData;
}

/** A payload with nothing in it but a truthful chain block.
 *
 *  `chainFacts(undefined)` falls back to the mainnet profile field by field, so
 *  an empty payload would make `isMainnet()` true and print "Arc mainnet" over a
 *  testnet session. Carrying a real chain block is what forecloses that, and it
 *  is why this returns a populated `chain` rather than an empty object.
 *
 *  NO `as unknown as` CAST, AND THAT IS THE POINT. There was one, and under it
 *  `attack` was built as `{runs, summary}` while the type says
 *  `{per_index, series, usdc_burned, n_adversarial}` — so `app/attack/view.tsx`
 *  read `archived.series.length` off `undefined` and threw during the SERVER
 *  render. Testnet sets `bundle: false`, so this cushion is exactly what a
 *  visitor gets while the press wakes, which was measured at 18-19s, on the
 *  page `/companion` sends plain-edition readers to first.
 *
 *  A cast that silences the one check that would have caught it is worse than
 *  no helper. Removing it cost one corrected literal and now the compiler
 *  enumerates anything a future field adds. */
export function emptyTerminal(chain: ChainKey): TerminalData {
  return {
    prints: {},
    attack: { per_index: [], series: [], usdc_burned: 0, n_adversarial: 0 },
    chain: emptyChainFacts(chain),
  };
}

/** Whether an envelope answered for the chain that was asked for.
 *
 *  The last line of defence, and the only one that survives a cache nobody
 *  predicted. False means show an error, never render the numbers. */
export function sameChain(body: unknown, want: ChainKey): boolean {
  if (!body || typeof body !== "object") return false;
  const got = parseChainKey((body as { chain?: unknown }).chain);
  return got === want;
}
