import "server-only";

/* The chain for a server render, read from the cookie.
 *
 * Separate from `lib/envelope.ts`'s `requestChain(req)` for one reason: a server
 * component has no `Request`, so it has to go through `next/headers` — and
 * `cookies()` throws outside a request scope, which would make the whole module
 * unreachable from `npm test`. Keeping that one call in its own file leaves
 * `envelope.ts` pure and unit-testable, and `import "server-only"` makes an
 * accidental client import a build error rather than a runtime surprise.
 *
 * TWO THINGS TO KNOW BEFORE USING IT.
 *
 * `cookies()` is ASYNC in Next 16 (it was synchronous up to 14, tolerated in 15)
 * and reading it in a layout or page opts that route into dynamic rendering.
 * Every page here is already `force-dynamic`, so nothing moves in practice — but
 * it is a global property of the app rather than a local choice, which is why it
 * is written down here instead of being inferred from a call site.
 *
 * And the chain is never cached or hoisted. A warm lambda serves many visitors;
 * a module-level `let chain` would be one visitor's choice applied to the next
 * one's render, which is the single failure this whole design exists to avoid.
 */

import { cookies } from "next/headers";

import { CHAIN_COOKIE, parseChainKey, DEFAULT_CHAIN, type ChainKey } from "./chainChoice";

export async function serverChain(): Promise<ChainKey> {
  try {
    const store = await cookies();
    return parseChainKey(store.get(CHAIN_COOKIE)?.value) ?? DEFAULT_CHAIN;
  } catch {
    // Rendered outside a request scope (a build-time probe, a test). The default
    // is the product's chain, which is the right answer when nobody has chosen.
    return DEFAULT_CHAIN;
  }
}
