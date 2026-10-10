import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cardHeader } from "./envelope";
import { cardHeaders, looksLikeCard } from "./readerCard";
import { filenameFrom } from "../components/spend/LedgerDownload";

/* The card's path through the terminal: what may carry it, and what may not.
 *
 * `/spend` is publicly readable by design, which is right for review and wrong
 * for a customer with a real treasury and a real vendor list. The press gate is
 * the fix (`ACR_OPERATOR_READ_SCOPE`); this file holds the two things the
 * BROWSER half can get wrong, both of which are silent.
 *
 * ONE: a credential in a URL. A card is a bearer token. A URL is written to
 * access logs, kept in history, sent in a `Referer`, and — the one that bites
 * here — is the only thing Vercel's CDN keys a stored response on, measured on
 * the live deployment. A card in a query string would be leaked four ways and
 * would also become the key under which one reader's private statement got
 * stored for the next reader. So the scan below reads the source rather than
 * trusting that nobody will ever find a query parameter convenient.
 *
 * TWO: a credential sent where none is needed. `/operator/businesses` and
 * `/operator/traction` are counts, they stay public in both flag states, and a
 * card attached to them would be a credential spent for nothing.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** A real card, as `scripts/mint_card.py` printed one: 652 bytes of standard
 *  base64. Trimmed here to its distinguishing head and tail. */
const REAL = "eyJjYXJkIjp7ImFnZW50IjoiMHg3MERDZUMx" + "Qm9ePw/+".repeat(20) + "In0=";

function req(headers: Record<string, string>): Request {
  return new Request("https://acr.example/api/operator/statement?business=acme", { headers });
}

test("a real card is forwarded, with the + and / standard base64 actually emits", () => {
  /* THE BUG THIS PINS. I wrote the guard as base64url (`-_`) first. Both
     encoders are plain base64 — `b64encode` in agentcard.py, `btoa` in
     lib/agentcard.ts — so that regex would have refused any card containing a
     `+` or a `/` before the press ever saw it, and it passed 200 of 200 real
     minted cards, because a `+` needs a byte at a position ≡2 mod 3 to be `>`
     or `~` and a card's JSON is hex, a slug and a signature. Invisible to every
     test I would have thought to write, and waiting on the first card whose
     `name` carried one of four characters. */
  assert.ok(REAL.includes("+") && REAL.includes("/"), "the fixture must exercise both");
  assert.deepEqual(cardHeader(req({ "AGENT-CARD": REAL })), { "AGENT-CARD": REAL });
});

test("no card, an empty card and whitespace are all simply no card", () => {
  assert.deepEqual(cardHeader(req({})), {});
  assert.deepEqual(cardHeader(req({ "AGENT-CARD": "" })), {});
  assert.deepEqual(cardHeader(req({ "AGENT-CARD": "   " })), {});
});

test("a value that is not base64 is dropped rather than forwarded", () => {
  /* This value is copied into an outbound request, so it is checked before it
     goes rather than forwarded for the press to judge — by then it would
     already be in a request we made. */
  for (const evil of ["eyJ YWJj", "ey=J;x", "eyJ.YWJj", "eyJ_YWJj-Zg"]) {
    assert.deepEqual(cardHeader(req({ "AGENT-CARD": evil })), {}, JSON.stringify(evil));
  }
});

test("an embedded CR and a NUL are refused a layer below this one", () => {
  /* MEASURED, and it changed this file. The first version of the test above fed
     `"eyJ\r\nX-Evil: 1"` to `cardHeader` and failed — not on the assertion, but
     in `new Request(...)`: undici refuses a header value containing a CR or LF
     outright, so a request-splitting card cannot be constructed here to be
     dropped. The guard above is still the right shape (it must not forward what
     it has not checked) and the platform is the thing actually standing between
     a crafted header and an outbound request. Pinned, because a future runtime
     that quietly allowed it would otherwise change our exposure silently. */
  for (const raw of ["eyJ\r\nX-Evil: 1", "eyJ\u0000"]) {
    assert.throws(() => req({ "AGENT-CARD": raw }), /invalid header value/i, JSON.stringify(raw));
  }
});

test("an overlong header is not a card, and the boundary is exact", () => {
  // Attacker-set and copied into a request we make, so unbounded here means an
  // unbounded request made on somebody else's say-so. Both fixtures carry the
  // `eyJ` prefix, so this test measures the LENGTH rule and nothing else — the
  // first version used `"A".repeat(...)` and started failing on the prefix,
  // which is a test that would have passed for the wrong reason.
  const at = (n: number) => `eyJ${"A".repeat(n - 3)}`;
  assert.equal(at(2048).length, 2048);
  assert.deepEqual(cardHeader(req({ "AGENT-CARD": at(2049) })), {});
  assert.deepEqual(cardHeader(req({ "AGENT-CARD": at(2048) })), { "AGENT-CARD": at(2048) });
});

test("the browser's own check agrees with the proxy's", () => {
  /* Two checks, one rule. The page checks so a reader who pastes a curl command
     is told by the page; the proxy checks because a proxy may not trust its
     client. They must not disagree about what a card is, or the page would
     enable a button on a value the proxy then silently drops. */
  for (const v of [REAL, `eyJ${"A".repeat(2045)}`]) assert.ok(looksLikeCard(v), v.slice(0, 20));
  for (const v of ["", "   ", "eyJ YWJj", "A".repeat(2049), "0xdeadbeef…", "eyJ.YWJj"]) {
    assert.equal(looksLikeCard(v), false, JSON.stringify(v.slice(0, 24)));
  }

  /* THE ONE A CHARSET CHECK CANNOT CATCH, and the reason there is a prefix.
     Hex is a subset of base64's alphabet, so a private key passes any charset
     test — and a reader who pasted one into a credential field would have had
     it transmitted by a control whose own copy promises "never a private key".
     Found by this test failing on `0xdeadbeef`, which is also just base64. */
  const key = `0x${"ab".repeat(32)}`;
  assert.equal(looksLikeCard(key), false, "a private key must never be sendable");
  assert.deepEqual(cardHeaders(key), {});
  assert.deepEqual(cardHeader(req({ "AGENT-CARD": key })), {}, "nor through the proxy");
  // The prefix is base64 of `{"`, which every card has by grammar: measured
  // `eyJj` on 100 freshly minted cards, pinned at `eyJ`.
  assert.ok(REAL.startsWith("eyJ"));
  /* A TRAILING NEWLINE IS A CARD, because that is how a card arrives: pasted
     out of a terminal where `mint_card.py` printed it. Accepted and trimmed —
     and `cardHeaders` must send the trimmed bytes, which is the half that was
     wrong when this test was first written. */
  assert.ok(looksLikeCard(`${REAL}\n`));
  assert.deepEqual(cardHeaders(`  ${REAL}\n`), { "AGENT-CARD": REAL });
});

test("the card is never put in a URL, a query string or a cookie", () => {
  /* The invariant, scanned. Three shapes, each of which would work and each of
     which leaks: a query parameter (logs, history, Referer, CDN key), a cookie
     (ambient on every request to this origin, including ones the reader never
     made), and sessionStorage read into a path. */
  const sources = [
    "lib/readerCard.ts",
    "lib/useLive.ts",
    "lib/envelope.ts",
    "components/spend/ReaderCardGate.tsx",
    "components/spend/LedgerDownload.tsx",
    "app/api/operator/statement/route.ts",
    "app/api/operator/audit/route.ts",
    "app/api/operator/ledger/route.ts",
  ];
  const leaks: string[] = [];
  for (const file of sources) {
    for (const [i, line] of read(file).split("\n").entries()) {
      const code = line.replace(/^\s*(\*|\/\/|\/\*).*/, ""); // prose may discuss all of this
      if (/[?&](card|agent_card|agentcard|AGENT-CARD)=/.test(code)) leaks.push(`${file}:${i + 1} query`);
      if (/document\.cookie/.test(code)) leaks.push(`${file}:${i + 1} cookie`);
      if (/searchParams\.(set|append)\(\s*["'`][^"'`]*card/i.test(code)) leaks.push(`${file}:${i + 1} param`);
    }
  }
  assert.deepEqual(leaks, [], `a card must travel as a header only:\n  ${leaks.join("\n  ")}`);
});

test("every per-business operator proxy forwards the caller's card", () => {
  // The three routes that answer one business's detail. A fourth added without
  // the header would 401 for a carded reader while the other three worked,
  // which reads as "this page is broken" rather than "this hop forgot".
  const missing = [
    "app/api/operator/statement/route.ts",
    "app/api/operator/audit/route.ts",
    "app/api/operator/ledger/route.ts",
  ].filter((f) => !read(f).includes("cardHeader(req)"));
  assert.deepEqual(missing, [], `these drop the card on the floor: ${missing.join(", ")}`);
});

test("the public aggregates do not send a card, and the detail reads do", () => {
  /* The decision, held as a test. Counts are not a vendor list: /traction and
     the business list are what let a stranger check this product's claims, and
     they must keep answering without a credential. The inverse half matters as
     much — a detail hook that quietly went back to the plain fetcher would stop
     forwarding the card and present as "my card does nothing". */
  const src = read("lib/useLive.ts");
  const fetcherIn = (hook: string): string => {
    const at = src.indexOf(`export function ${hook}(`);
    assert.ok(at > 0, `${hook} is gone — this test is stale, not passing`);
    const body = src.slice(at, src.indexOf("\n}", at));
    const m = /(cardFetcherFor|fetcherFor)\(chain\)/.exec(body);
    return m?.[1] ?? "none";
  };
  assert.equal(fetcherIn("useBusinesses"), "fetcherFor");
  assert.equal(fetcherIn("useTraction"), "fetcherFor");
  assert.equal(fetcherIn("useStatement"), "cardFetcherFor");
  assert.equal(fetcherIn("useLedgerAudit"), "cardFetcherFor");
});

test("a refused read is not retried", () => {
  /* A card the press has refused will be refused identically six more times
     over about two minutes, and the reader watches a spinner where the sentence
     telling them what to claim should be. Scanned rather than simulated because
     the policy is an object literal, not a function anybody can call. */
  const src = read("lib/useLive.ts");
  assert.match(src, /isRefusal\(err\.status\)\)\s*return;/, "RETRY must bail out on 401/403");
});

test("filenameFrom takes the press's name, and only a basename", () => {
  assert.equal(filenameFrom('attachment; filename="acr-fleet.beancount"'), "acr-fleet.beancount");
  assert.equal(filenameFrom("attachment; filename=acr-fleet.beancount"), "acr-fleet.beancount");
  assert.equal(filenameFrom(null), null);
  assert.equal(filenameFrom("attachment"), null);
  // A server-set name reaches a filesystem. The slug fallback is used instead.
  assert.equal(filenameFrom('attachment; filename="../../etc/passwd"'), null);
  assert.equal(filenameFrom('attachment; filename="a/b.beancount"'), null);
});
