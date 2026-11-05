import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toVaultPolicy, usdcUnits, validate } from "./policy.ts";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "policy.schema.json");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
  required: string[];
  properties: Record<string, { type?: string; minimum?: number; maximum?: number }>;
};

const GOOD = {
  bufferHours: 48,
  maxPremiumBps: 100,
  humanMaxPremiumBps: 2000,
  maxPrintAge: 1800,
  upperBandBps: 1500,
  lowerBandBps: 1000,
  minTicketUsdc: "1",
  workingShareBps: 10000,
  agents: {
    scout: { dailyCapUsdc: "25", perRequestUsdc: "5", frozen: false },
    waster: { dailyCapUsdc: "25", perRequestUsdc: "5", frozen: false },
  },
};

const withPolicy = (over: Record<string, unknown>) => ({ ...GOOD, ...over });

test("the seed policy is valid", () => {
  const r = validate(GOOD);
  assert.equal(r.ok, true, r.ok ? "" : r.errors.join("; "));
});

/**
 * THE DRIFT GATE. `policy.schema.json` is what Arc Studio is pointed at;
 * `PolicySchema` is what runs before a transaction is built. Two sources of
 * truth would normally diverge silently, with the published contract promising
 * one thing and the code enforcing another — so every numeric bound in the
 * published file is driven through the runtime validator here. Widen one
 * without the other and this fails.
 */
test("every bound in the published schema is the bound the validator enforces", () => {
  for (const [field, spec] of Object.entries(schema.properties)) {
    if (spec.type !== "integer" || spec.minimum === undefined || spec.maximum === undefined) continue;

    const atMin = validate(withPolicy({ [field]: spec.minimum }));
    const atMax = validate(withPolicy({ [field]: spec.maximum }));
    const belowMin = validate(withPolicy({ [field]: spec.minimum - 1 }));
    const aboveMax = validate(withPolicy({ [field]: spec.maximum + 1 }));

    // `maxPremiumBps` at its maximum breaks the cross-field rule against the
    // seed's human band, which is the rule working rather than a bound
    // mismatch — so only the out-of-range directions are asserted for it.
    // Both band fields are cross-coupled by the widening rule, so at their
    // extremes they break THAT rule rather than their own bound. Only the
    // out-of-range directions are a bound assertion for them.
    if (field !== "maxPremiumBps" && field !== "humanMaxPremiumBps") {
      assert.equal(atMin.ok, true, `${field} should accept its published minimum ${spec.minimum}`);
      assert.equal(atMax.ok, true, `${field} should accept its published maximum ${spec.maximum}`);
    }
    assert.equal(belowMin.ok, false, `${field} should reject ${spec.minimum - 1}`);
    assert.equal(aboveMax.ok, false, `${field} should reject ${spec.maximum + 1}`);
  }
});

test("every field the published schema requires is required by the validator", () => {
  for (const field of schema.required) {
    const partial: Record<string, unknown> = { ...GOOD };
    delete partial[field];
    const r = validate(partial);
    assert.equal(r.ok, false, `omitting ${field} should be refused`);
  }
});

// --- the refusals -----------------------------------------------------------

test("an approval may not narrow the band", () => {
  const r = validate(withPolicy({ maxPremiumBps: 2000, humanMaxPremiumBps: 100 }));
  assert.equal(r.ok, false);
  assert.ok(
    !r.ok && r.errors.some((e) => e.includes("widen the band")),
    `expected the widening rule, got ${!r.ok ? r.errors.join("; ") : ""}`,
  );
});

test("an unreachable per-request threshold is refused with the reason", () => {
  const r = validate(
    withPolicy({ agents: { scout: { dailyCapUsdc: "5", perRequestUsdc: "25", frozen: false } } }),
  );
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.includes("unreachable")));
});

test("a zero cap is refused, because freezing says it instead", () => {
  const r = validate(
    withPolicy({ agents: { scout: { dailyCapUsdc: "0", perRequestUsdc: "0", frozen: false } } }),
  );
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.includes("freeze the agent instead")));
});

test("an unknown field is refused rather than ignored", () => {
  // A typo'd key silently dropped is a policy the treasurer believes they set.
  const r = validate({ ...GOOD, maxPremium: 100 });
  assert.equal(r.ok, false);
});

test("an amount that is not a 6dp decimal string is refused", () => {
  for (const bad of ["1.0000001", "2,50", "1e6", "-5", "", "abc"]) {
    const r = validate(
      withPolicy({ agents: { scout: { dailyCapUsdc: bad, perRequestUsdc: "1", frozen: false } } }),
    );
    assert.equal(r.ok, false, `${bad} should be refused`);
  }
});

test("a numeric amount is refused, so money never arrives as a float", () => {
  const r = validate(
    withPolicy({ agents: { scout: { dailyCapUsdc: 25, perRequestUsdc: 5, frozen: false } } }),
  );
  assert.equal(r.ok, false);
});

test("a policy with no agents is refused", () => {
  const r = validate(withPolicy({ agents: {} }));
  assert.equal(r.ok, false);
});

test("every problem is reported, not just the first", () => {
  const r = validate(withPolicy({ bufferHours: 0, maxPrintAge: 1, workingShareBps: 99999 }));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.length >= 3, `expected at least 3 errors, got ${!r.ok ? r.errors.length : 0}`);
});

// --- the conversion ---------------------------------------------------------

test("a USDC string converts to 6dp units exactly", () => {
  assert.equal(usdcUnits("25"), 25_000_000n);
  assert.equal(usdcUnits("2.5"), 2_500_000n);
  assert.equal(usdcUnits("0.000001"), 1n);
  assert.equal(usdcUnits("1.05525"), 1_055_250n);
});

test("the vault tuple carries the policy in the contract's own field order", () => {
  const r = validate(GOOD);
  assert.ok(r.ok);
  const v = toVaultPolicy(r.policy);
  assert.deepEqual(Object.keys(v), [
    "maxPremiumBps",
    "humanMaxPremiumBps",
    "maxPrintAge",
    "upperBandBps",
    "lowerBandBps",
    "workingShareBps",
    "bufferHours",
    "minTicketUsdc",
  ]);
  assert.equal(v.minTicketUsdc, 1_000_000n);
});
