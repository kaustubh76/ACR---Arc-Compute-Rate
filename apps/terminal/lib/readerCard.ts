"use client";

/* The reader's agent card, for this tab.
 *
 * WHAT THIS HOLDS AND WHY A FIELD IS SAFE. An agent card is a bearer token that
 * expires in at most fifteen minutes (`MAX_TTL_S`), is scoped to one business,
 * carries `role: "reader"`, and cannot spend: no payment path in this codebase
 * consults a card at all. That is exactly why it may be pasted into a field and
 * a private key may not — which is also why /developers' in-tab minting
 * deliberately uses a THROWAWAY key, and why `scripts/mint_card.py` takes its
 * key from the environment and never from argv.
 *
 * AND IT CANNOT BE REVOKED. `docs/AGENT-MODULE.md` records that as a decision,
 * not an oversight: "the 15-minute bound IS the revocation window. A registry
 * would fix that and would also make the scheme permissioned, which is the
 * property being bought here." So there is no sign-out that invalidates a card,
 * only `forget()`, which stops THIS tab sending it. The UI says so rather than
 * implying a logout it cannot perform.
 *
 * SESSIONSTORAGE, NOT A COOKIE, and this is the load-bearing choice. A cookie
 * would be sent on every request to this origin automatically: ambient
 * authority, attached to requests the reader never initiated, and — on a CDN
 * that keys stored responses on method and URL and not on cookies — a
 * credential whose answers could be served to somebody else. sessionStorage is
 * read explicitly, by two hooks and one download, and dies with the tab.
 *
 * Mirrors `lib/useChain.ts` and `lib/useEdition.ts`: `useSyncExternalStore` over
 * a module singleton. Safe here for the reason `useChain` documents at length —
 * the server snapshot is a CONSTANT (no card), every server render agrees, and
 * no server component may branch on it. A card is per reader and per tab, so it
 * has no business existing on the server at all.
 */

import { useSyncExternalStore } from "react";
import { mutate } from "swr";

import { CARD_HEADER, MAX_CARD } from "./agentcard";

const STORE = "acr-reader-card";

let current: string | null = null;
const listeners = new Set<() => void>();

function read(): string {
  if (current !== null) return current;
  if (typeof sessionStorage === "undefined") return "";
  try {
    current = sessionStorage.getItem(STORE) ?? "";
  } catch {
    /* private window, blocked storage: this tab simply has no card */
    current = "";
  }
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** This tab's card, read outside React.
 *
 *  For the SWR fetcher and the ledger download, which need the value at the
 *  moment of the fetch and are not components. Deliberately separate from the
 *  hook: a fetcher that called `useReaderCard()` would be a hook called outside
 *  a render, and one that closed over a card captured at render time would send
 *  a stale one on the first fetch after a paste. */
export function readerCardNow(): string {
  return read();
}

/** The card this tab is presenting, or `""`.
 *
 *  The third argument is the server snapshot and it is the constant `""` — see
 *  the header: a card is per tab and has no business existing on the server. */
export function useReaderCard(): string {
  return useSyncExternalStore(subscribe, read, () => "");
}

/** Accept a pasted card — or, with `""`, stop sending one.
 *
 *  REVALIDATION IS THE HALF THAT IS EASY TO FORGET. SWR keys on the URL, and
 *  the card is deliberately NOT in the URL (see `cardHeader` in lib/envelope.ts
 *  for why a bearer token in a query string is the one shape to avoid). So
 *  pasting a card changes nothing SWR can see: the refused key is already in its
 *  cache with an error, and its own retry policy would not reach the new header
 *  for another thirty seconds.
 *
 *  So this tells SWR directly, with a filter rather than a list of keys: the
 *  next hook somebody adds to `/api/operator/` is covered without remembering
 *  this line exists. The alternative — putting the card in the key — would have
 *  been less code and would have put a credential in a URL.
 *
 *  ONE CARD PER TAB is what makes the URL a correct cache key despite the
 *  header: two different cards never coexist in one cache, so an entry fetched
 *  with a card can only ever be read by the same card. A per-business card
 *  selector on one page would break that property and would need the fingerprint
 *  in the key.
 */
export function setReaderCard(next: string): void {
  const card = next.trim();
  current = card;
  try {
    if (card) sessionStorage.setItem(STORE, card);
    else sessionStorage.removeItem(STORE);
  } catch {
    /* blocked storage: the card still works for this page's lifetime */
  }
  for (const fn of listeners) fn();
  void mutate((key) => typeof key === "string" && key.includes("/api/operator/"));
}

/** Headers for a fetch that should present this tab's card, or `{}`.
 *
 *  Shape-checked here as well as at the proxy. Not defence in depth for its own
 *  sake: a reader who pastes the wrong thing — a whole curl command, a private
 *  key, the JSON instead of the base64 — should be told by the page, and a value
 *  that cannot be a card should never leave the browser at all. The proxy checks
 *  again because a proxy may not trust its client.
 */
export function cardHeaders(card: string): Record<string, string> {
  const card_ = normaliseCard(card);
  return card_ ? { [CARD_HEADER]: card_ } : {};
}

/** The card as it will be SENT, or null if it is not one.
 *
 *  WHAT THIS CLOSES. The first version checked `card.trim()` and then sent the
 *  untrimmed string. Not exploitable — HTTP strips trailing whitespace from a
 *  header value, and undici refuses outright any value with a CR or LF inside
 *  it, which is a layer below this one — but it is the validate-one-thing,
 *  send-another shape, and the only reason it was harmless is a property of a
 *  library two hops away. One function now decides both, so the two cannot
 *  disagree whatever the layers below do.
 *
 *  Trailing whitespace is TRIMMED, not refused: a card pasted out of a terminal
 *  arrives with a newline on it, and refusing that would be refusing the normal
 *  way of getting one here. */
export function normaliseCard(raw: string): string | null {
  const v = raw.trim();
  if (!v || v.length > MAX_CARD) return null;
  // Standard base64's alphabet — `+/`, not `-_`. Both encoders are plain base64
  // (`b64encode` in agentcard.py, `btoa` in lib/agentcard.ts), and writing this
  // as base64url first would have refused any card containing a `+` or a `/`
  // while passing 200 of 200 real cards: a `+` needs a byte at a position
  // ≡2 mod 3 to be `>` or `~`, and a card's JSON is hex, a slug, a signature.
  if (!/^[A-Za-z0-9+/=]+$/.test(v)) return null;

  /* AND IT MUST LOOK LIKE A CARD, not merely like base64. This is the half the
     charset cannot do: hex is a SUBSET of base64's alphabet, so `0x` followed
     by sixty-four hex characters passes a charset check — which means a reader
     who pasted a PRIVATE KEY into this field would have had it sent to the
     press, by a control whose own copy says "never a private key". It would
     have been refused there and logged on the way.

     A card is base64 of `{"card":…`, so every one of them begins `eyJj`;
     measured over 100 freshly minted cards, the prefix was `eyJj` every time.
     `eyJ` is required rather than `eyJj` because that is the part fixed by the
     grammar (base64 of `{"`) rather than by today's key order. */
  return v.startsWith("eyJ") ? v : null;
}

/** Whether a pasted string could be a card at all — for enabling the button and
 *  for telling a reader who pasted a curl command that they did. One rule, in
 *  `normaliseCard`, so the page can never enable a button on a value the sender
 *  would then drop. */
export function looksLikeCard(card: string): boolean {
  return normaliseCard(card) !== null;
}
