/* Pure codec for ACROracle reads: index-id encoding and struct descaling.
   No imports, no I/O — unit-tested in onchainCodec.test.ts. The viem wiring
   lives in lib/onchain.ts (server-only). */

import type { OnchainPrint } from "./types";

export const WAD = 10n ** 18n;
export const USDC6 = 10n ** 6n;

/** UTF-8, right-padded with zero bytes to 32 — must match
 *  acr_oracle_client.index_id_to_bytes32 (client.py) and the poster. */
export function indexIdBytes32(id: string): `0x${string}` {
  const raw = new TextEncoder().encode(id);
  if (raw.length > 32) throw new Error(`index id too long for bytes32: ${id}`);
  const padded = new Uint8Array(32);
  padded.set(raw);
  let hex = "0x";
  for (const b of padded) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

/** WAD (1e18) → number. Values are small unit prices (≪ 2^53/1e18 after the
 *  division), so double precision is ample for display. */
export function fromWad(v: bigint): number {
  return Number(v) / 1e18;
}

/** USDC 1e6 → number. */
export function fromUsdc6(v: bigint): number {
  return Number(v) / 1e6;
}

/** The Print struct as viem decodes it (named tuple components). */
export interface RawPrint {
  value: bigint;
  ciLo: bigint;
  ciHi: bigint;
  attackCostPerBp: bigint;
  timestamp: bigint;
  postedAt: bigint;
  exists: boolean;
}

export function decodePrint(
  indexId: string,
  p: RawPrint,
  ageS: bigint,
): (OnchainPrint & { age_s: number }) | null {
  if (!p.exists) return null;
  return {
    index_id: indexId,
    value: fromWad(p.value),
    ci_lo: fromWad(p.ciLo),
    ci_hi: fromWad(p.ciHi),
    attack_cost_per_bp: fromUsdc6(p.attackCostPerBp),
    timestamp: Number(p.timestamp),
    posted_at: Number(p.postedAt),
    age_s: Number(ageS),
  };
}
