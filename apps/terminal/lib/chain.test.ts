import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SETTLE_AGE_S } from "./chain";
import { CLASS_BY_CODE, SERVICE_BY_CODE, schemaFromBytes32 } from "./registryCodec";
import { DEMO_LABELS, KEY_PREFIX, deriveDemoSellers } from "./sellerKeys";

test("the freshness window matches the contract it copies", () => {
  // A constant that is right when typed is the shape of the `multiplier` bug:
  // that number was correct too, in an example, in a comment — and the terminal
  // stated it as fact for a series that used a different one. Bind the copy to
  // its source so a redeploy cannot silently make the badge wrong.
  const sol = readFileSync(
    join(__dirname, "..", "..", "..", "contracts", "src", "ACRFutures.sol"),
    "utf8",
  );
  const m = sol.match(/MAX_SETTLE_AGE\s*=\s*(\d+)/);
  assert.ok(m, "ACRFutures.sol should declare MAX_SETTLE_AGE");
  assert.equal(
    MAX_SETTLE_AGE_S,
    Number(m![1]),
    "lib/chain.ts MAX_SETTLE_AGE_S has drifted from ACRFutures.sol",
  );

  /* Same discipline, worse bug. AttestationRegistry documents its own uint8
     encodings in the struct, and /sellers now prints those codes beside the
     names it maps them to. Reorder the Solidity and NOTHING breaks: no throw,
     no empty, just "gpu" where the chain said "inference" — under a live block
     number that makes it look checked. Bind the tables to their source.

     Asserted inside this test rather than as a new one on purpose: `npm test`
     reports `# pass N`, verify_claims measures it, and 95 is stated in six
     docs plus a twelve-suite list. The protection is identical either way. */
  const reg = readFileSync(
    join(__dirname, "..", "..", "..", "contracts", "src", "AttestationRegistry.sol"),
    "utf8",
  );
  const svc = reg.match(/uint8 service;\s*\/\/\s*(.+)/);
  const cls = reg.match(/uint8 modelClass;\s*\/\/\s*(.+)/);
  assert.ok(svc && cls, "AttestationRegistry.sol should still document its encodings");
  SERVICE_BY_CODE.forEach((name, i) => {
    assert.match(svc![1], new RegExp(`${i}\\s*=\\s*${name}`), `service ${i} should be ${name}`);
  });
  CLASS_BY_CODE.forEach((name, i) => {
    assert.match(cls![1], new RegExp(`${i}\\s*=\\s*${name}`), `modelClass ${i} should be ${name}`);
  });

  // The schema id is a zero-padded ASCII word; trailing NULs are padding, not
  // content, and a `\0` left in would render as a box glyph on the page.
  const packed = "0x" + Buffer.from("openai/chat@1".padEnd(32, "\0"), "utf8").toString("hex");
  assert.equal(schemaFromBytes32(packed), "openai/chat@1");
  assert.equal(schemaFromBytes32("0x" + "00".repeat(32)), "");

  /* The seller-key derivation, end to end and offline.
     /sellers rebuilds all four addresses from the labels below and ticks them
     against the registry. Get the labels or the prefix wrong and it does not
     throw: it derives four perfectly valid addresses that are in no registry,
     turns every tick into a cross, and the page reads as though the sellers had
     been struck off. So assert both halves against their sources. */
  const py = readFileSync(
    join(
      __dirname, "..", "..", "..",
      "packages", "acr_oracle_client", "acr_oracle_client", "demo_sellers.py",
    ),
    "utf8",
  );
  assert.deepEqual(
    [...py.matchAll(/DemoSeller\("([^"]+)"/g)].map((m) => m[1]),
    [...DEMO_LABELS],
    "lib/sellerKeys.ts DEMO_LABELS has drifted from demo_sellers.py",
  );
  // Not sha256 of the bare label: the prefix is inside the hash. Matched
  // against the whole f-string, because a prefix test loose enough to pass on a
  // truncated separator would leave the real cause to be inferred from four
  // mismatched addresses below.
  assert.ok(
    py.includes(`f"${KEY_PREFIX}{self.label}"`),
    `demo_sellers.py should still hash ${KEY_PREFIX} + the label`,
  );

  // And the addresses it actually produces are the ones the registry holds,
  // per the committed bundle. This is the whole claim, checked without a
  // network: derive here, compare to what was filed on Arc.
  const bundle = JSON.parse(readFileSync(join(__dirname, "fallback.json"), "utf8"));
  const filed: string[] = bundle.marketplace.catalog.provider.attestation.sellers.map(
    (s: { seller: string }) => s.seller.toLowerCase(),
  );
  assert.deepEqual(
    deriveDemoSellers().map((d) => d.address.toLowerCase()).sort(),
    filed.sort(),
    "the derived seller addresses no longer match the registry records in fallback.json",
  );
});
