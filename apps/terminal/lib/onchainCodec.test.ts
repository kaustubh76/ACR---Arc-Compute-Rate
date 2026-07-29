import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePrint, fromUsdc6, fromWad, indexIdBytes32 } from "./onchainCodec";

test("indexIdBytes32 matches the python poster's encoding", () => {
  // "ACR-INF".encode("utf-8").ljust(32, b"\x00")
  assert.equal(indexIdBytes32("ACR-INF"), "0x" + "4143522d494e46".padEnd(64, "0"));
  assert.equal(
    indexIdBytes32("ACR-GPU"),
    "0x" + Buffer.from("ACR-GPU").toString("hex").padEnd(64, "0"),
  );
});

test("indexIdBytes32 is always 32 bytes of hex", () => {
  for (const id of ["ACR-INF", "ACR-GPU", "ACR-DATA", "x"]) {
    assert.equal(indexIdBytes32(id).length, 2 + 64);
  }
});

test("indexIdBytes32 rejects ids longer than 32 bytes", () => {
  assert.throws(() => indexIdBytes32("a".repeat(33)));
});

test("WAD descaling", () => {
  assert.equal(fromWad(10n ** 18n), 1);
  assert.equal(fromWad(25n * 10n ** 14n), 0.0025);
  assert.equal(fromWad(0n), 0);
});

test("USDC 1e6 descaling", () => {
  assert.equal(fromUsdc6(1_000_000n), 1);
  assert.equal(fromUsdc6(1_250n), 0.00125);
});

test("decodePrint maps the struct into the terminal's OnchainPrint shape", () => {
  const p = decodePrint(
    "ACR-INF",
    {
      value: 2_500_000_000_000_000n, // 0.0025 WAD
      ciLo: 2_400_000_000_000_000n,
      ciHi: 2_600_000_000_000_000n,
      attackCostPerBp: 1_250_000n, // 1.25 USDC/bp
      timestamp: 1_700_000_000n,
      postedAt: 1_700_000_100n,
      exists: true,
    },
    42n,
  );
  assert.ok(p);
  assert.equal(p.index_id, "ACR-INF");
  assert.equal(p.value, 0.0025);
  assert.equal(p.ci_lo, 0.0024);
  assert.equal(p.ci_hi, 0.0026);
  assert.equal(p.attack_cost_per_bp, 1.25);
  assert.equal(p.timestamp, 1_700_000_000);
  assert.equal(p.posted_at, 1_700_000_100);
  assert.equal(p.age_s, 42);
});

test("decodePrint returns null for a non-existent print", () => {
  const p = decodePrint(
    "ACR-INF",
    {
      value: 0n,
      ciLo: 0n,
      ciHi: 0n,
      attackCostPerBp: 0n,
      timestamp: 0n,
      postedAt: 0n,
      exists: false,
    },
    0n,
  );
  assert.equal(p, null);
});
