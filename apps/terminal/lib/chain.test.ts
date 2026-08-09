import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SETTLE_AGE_S } from "./chain";
import { CLASS_BY_CODE, SERVICE_BY_CODE, schemaFromBytes32 } from "./registryCodec";

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
});
