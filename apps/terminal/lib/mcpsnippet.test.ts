import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, snippets } from "../components/chain/McpSnippet";

test("the MCP config names the API this page looks at, and is JSON a host can paste", () => {
  const s = snippets("https://acr.test");
  assert.match(s.config, /"ACR_API": "https:\/\/acr.test"/);
  assert.ok(JSON.parse(s.config).mcpServers["acr-tca"], "the config must be valid JSON a host can paste");

  // The paying tab is prose around JSON, so parse the braces out of it.
  const payJson = s.pay.slice(s.pay.indexOf("{"), s.pay.lastIndexOf("}") + 1);
  assert.match(payJson, /"ACR_API": "https:\/\/acr.test"/);
  assert.ok(JSON.parse(payJson).mcpServers["acr-tca"], "the paying config must parse too");
});

test("the config installs the published package, with no path for a visitor to edit", () => {
  const s = snippets("https://acr.test");
  for (const tab of [s.config, s.pay]) {
    assert.match(tab, /"npx"/);
    assert.match(tab, /"-y", "acr-mcp"/, "the published package name, so there is nothing to clone");
    // It used to say `["tsx", "/path/to/ACR/mcp/src/server.ts"]`: a placeholder
    // path, in a package that was `private: true` and had no bin, so pasting this
    // could not work without first cloning the monorepo and editing the string.
    assert.ok(!tab.includes("/path/to/"), "a placeholder path is not a config a visitor can paste");
    assert.ok(!/\.ts"/.test(tab), "a host runs the built binary, not TypeScript source");
  }
});

test("every tool the server registers is named on this page", () => {
  const s = snippets("https://acr.test");
  // Deliberately NOT `s.ask + s.config + TOOLS.join()`: that third term satisfies
  // every match on its own, so the assertion could not fail. The tool list is
  // rendered from TOOLS, so what needs proving is that the WORKED EXAMPLES
  // exercise the tools worth demonstrating.
  for (const t of [
    "can_i_pay",
    "wallet_tca",
    // The tool the page exists to teach now: check_spend answers one bill and
    // spend_report answers the question behind it, so an example that shows the
    // first without the second teaches half a product.
    "spend_report",
    "reroute_suggestion",
    "seller_rating",
    "query_tape",
  ]) {
    assert.match(s.ask, new RegExp(t), `the examples should demonstrate ${t}`);
  }
  assert.match(s.pay, /pay_and_read/, "the paying tab must name the tool it unlocks");
});

test("the tools this page teaches ARE the tools the server registers", () => {
  /* READ FROM mcp/src/tools.ts, not pinned as a second list.
     
     This test used to assert a hardcoded array of names. That is a snapshot, not
     a cross-check: when `check_spend` was added to the plugin, this file went on
     passing against its own stale copy and the page quietly taught nine tools of
     ten. A literal list in a test cannot catch the drift it exists to catch.
     
     So it reads the other language's source, which is the discipline
     `tests/test_canonical_host.py` and `lib/mainnetOnly.test.ts` already use:
     when the alternative is a second copy of the truth, read the first one.
     `pay_and_read` is included because the plugin HAS it — the server withholds
     it at runtime until a payer key is set (`toolsFor`), which is a different
     question from whether it exists. */
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mcp", "src", "tools.ts"), "utf8");
  // The `TOOLS` array's entries, each `name: "…"` at the head of a tool record.
  const registered = [...src.matchAll(/^\s{4}name: "([a-z_]+)",$/gm)].map((m) => m[1]);
  assert.ok(registered.length >= 9, `expected to find the tool names, found ${registered.length}`);
  assert.deepEqual([...TOOLS].sort(), registered.sort(), "the page and the plugin must agree");
});

test("the paying tab states the cap and which balance a settlement spends", () => {
  const s = snippets("https://acr.test");
  assert.match(s.pay, /ACR_MAX_SPEND_USDC/, "a $0.0001 call is what makes a loop expensive quietly");
  assert.match(s.pay, /GATEWAY balance, not the wallet/, "the rung that surprises people");
  assert.match(s.pay, /ACR_PAYER_PRIVATE_KEY/);
  assert.ok(
    !s.config.includes("ACR_PAYER_PRIVATE_KEY"),
    "the default config must not invite a spending key into a host that only wants reads",
  );
});

test("the worked examples use addresses that have rows at the plugin's default window", () => {
  const s = snippets("https://acr.test");
  // Measured 2026-10-09 on the press this page calls: this payer has 3 purchases
  // at -1139.8 bp over 30 days, and this seller answers Unrated with its reason
  // given. BOTH reported zero over 7 days, which is what the page used to
  // demonstrate. `mcp/scripts/smoke.ts` probes the same two addresses, so a press
  // that stops answering for them fails there rather than quietly here.
  assert.match(s.ask, /0xc2903b52a3ad365fd237b78389a2fde99e886999/);
  assert.match(s.ask, /0xefe0E4625AFf072c3FCff230b47f8150A17aDF19/);
  assert.ok(
    !s.ask.includes("0x674055533B05Ec3fD135fC21c4d91a4A2D3193d3"),
    "that payer has no rows on the host this page calls — an example that demonstrates nothing",
  );
  assert.ok(!/this week/.test(s.ask), "the default window is 30 days, so the question must not say a week");
});
