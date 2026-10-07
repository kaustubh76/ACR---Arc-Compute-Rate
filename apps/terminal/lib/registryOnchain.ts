import "server-only";

import { createPublicClient, http } from "viem";

import { CHAIN } from "./chain";
import { bundleSection } from "./api";
import { CLASS_BY_CODE, SERVICE_BY_CODE, nameFor, schemaFromBytes32 } from "./registryCodec";
import { ok, unread, type Read } from "./readResult";
import type { RegistryDirectRead } from "./types";

/* Reading `AttestationRegistry` straight off Arc, on demand.
 *
 * Every other number on the page arrives via the Python press, which means a
 * reader has to take the card's "4 sellers attested" on our word. This is the
 * one path that does not: the reader presses a button, we ask Arc, and the
 * answer comes back stamped with the block height it was read at. That is the
 * page's own stated claim ("check it yourself") made executable.
 *
 * `server-only` is load-bearing, not decoration. viem is absent from the client
 * bundle today (verified by grepping .next/static), and it must stay absent —
 * this import turns an accidental client import into a build error rather than
 * ~400KB of silent JavaScript. It is also why the payload type lives in
 * types.ts instead of here.
 */

/** The four views this reads. Ported from REGISTRY_ABI in
 *  packages/acr_oracle_client/acr_oracle_client/registry.py — same fragments,
 *  same tuple order. Only the reads: nothing here can write. */
const REGISTRY_ABI = [
  {
    type: "function",
    name: "sellerCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "sellerAt",
    stateMutability: "view",
    inputs: [{ name: "i", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getAttestation",
    stateMutability: "view",
    inputs: [{ name: "seller", type: "address" }],
    outputs: [
      {
        type: "tuple",
        name: "",
        components: [
          { name: "seller", type: "address" },
          { name: "service", type: "uint8" },
          { name: "modelClass", type: "uint8" },
          { name: "latencySloMs", type: "uint32" },
          { name: "schemaId", type: "bytes32" },
          { name: "timestamp", type: "uint64" },
          { name: "exists", type: "bool" },
        ],
      },
    ],
  },
] as const;

/** Arc's public RPC rate-limits concurrent requests — measured, 3 parallel
 *  reads lose 2 — so every read here is sequential with this gap, exactly as
 *  onchain.ts and futuresOnchain.ts do it. */
const RPC_GAP_MS = 350;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A crawl is 1 + 2N calls. Cap it so a registry that grows past demo size
 *  cannot turn one button press into a minute of paced RPC. */
const MAX_SELLERS = 25;

function registryAddress(): `0x${string}` | null {
  // Same precedence as oracleAddress() in onchain.ts: the env var a deployment
  // sets, else the address baked into the committed bundle, which is real.
  const addr = process.env.ACR_REGISTRY_ADDRESS ?? bundleSection("chain")?.registry_address ?? null;
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as `0x${string}`) : null;
}

function rpcUrl(): string {
  return process.env.ACR_ARC_RPC_URL ?? bundleSection("chain")?.rpc_url ?? CHAIN.rpc;
}

function client() {
  // NOT memoized, unlike onchain.ts. That memo exists to share one round
  // between visitors inside a 30s window; this is a per-press read whose whole
  // product is freshness, and a cached client is one more place staleness can
  // hide. `fetchOptions.cache` is the load-bearing part either way: Next
  // patches global fetch, and without the opt-out viem's RPC POSTs land in the
  // Next Data Cache and the button reports the same block twice. A "read it
  // now" button that repeats a block number is worse than no button at all.
  return createPublicClient({
    transport: http(rpcUrl(), {
      timeout: 6_000,
      retryCount: 1,
      fetchOptions: { cache: "no-store" },
    }),
  });
}

/** Every record in the registry, plus the block it was read at.
 *
 *  Returns a `Read`, never a bare array: an empty registry and an unreachable
 *  RPC are opposite claims, and `[]` for the second is the exact failure
 *  readResult.ts exists to foreclose.
 */
/** The registry's own answer. `records: true` also crawls each attestation.
 *
 *  THE CRAWL IS OPT-IN, and the reason is the one number this read exists to
 *  publish. `RegistryProof` on /developers renders four fields — block,
 *  sellerCount, chain, took_ms — and its entire product is "press it twice and
 *  the block moves, in N ms". The crawl is `sellerAt` + `getAttestation` per
 *  seller, paced at RPC_GAP_MS to stay inside Arc's rate limit: with four
 *  records that is eight extra paced round trips, about 2.8 seconds, added to a
 *  figure the button DISPLAYS. So the button was advertising its own speed and
 *  reporting a time inflated roughly fivefold by work nobody could see.
 *
 *  The records are not dropped — `GET /api/registry?records=1` still returns
 *  them, and they are the substance a future surface would render. They are just
 *  no longer charged to a reader who did not ask. */
export async function readRegistry(
  opts: { records?: boolean } = {},
): Promise<Read<RegistryDirectRead>> {
  const address = registryAddress();
  if (!address) return unread("registry.address");

  const c = client();
  const started = Date.now();
  try {
    // The block first, so the stamp can never be NEWER than the records it
    // describes — reading it last would let a block mined mid-crawl claim
    // records that were read before it existed.
    const block = await c.getBlockNumber();
    await sleep(RPC_GAP_MS);
    const count = Number(await c.readContract({ address, abi: REGISTRY_ABI, functionName: "sellerCount" }));
    const total = Number.isFinite(count) && count >= 0 ? count : 0;

    const sellers: RegistryDirectRead["sellers"] = [];
    const wanted = opts.records ? Math.min(total, MAX_SELLERS) : 0;
    for (let i = 0; i < wanted; i++) {
      await sleep(RPC_GAP_MS);
      const who = (await c.readContract({
        address,
        abi: REGISTRY_ABI,
        functionName: "sellerAt",
        args: [BigInt(i)],
      })) as `0x${string}`;
      await sleep(RPC_GAP_MS);
      const a = (await c.readContract({
        address,
        abi: REGISTRY_ABI,
        functionName: "getAttestation",
        args: [who],
      })) as {
        seller: `0x${string}`;
        service: number;
        modelClass: number;
        latencySloMs: number;
        schemaId: `0x${string}`;
        timestamp: bigint;
        exists: boolean;
      };
      if (!a.exists) continue;
      sellers.push({
        seller: a.seller,
        // Raw codes ride along beside the names. They are what the contract
        // actually returned, and printing both is what makes this a reading
        // rather than a restatement of the card above.
        service_code: Number(a.service),
        service: nameFor(SERVICE_BY_CODE, Number(a.service)),
        class_code: Number(a.modelClass),
        model_class: nameFor(CLASS_BY_CODE, Number(a.modelClass)),
        latency_slo_ms: Number(a.latencySloMs),
        schema_id_hex: a.schemaId,
        schema_id: schemaFromBytes32(a.schemaId),
        attested_at: Number(a.timestamp),
      });
    }

    return ok({
      registry: address,
      chain_id: CHAIN.chainId,
      block: Number(block),
      seller_count: total,
      // Only meaningful when the crawl ran. Reporting `true` on a summary read
      // would claim rows were cut off when none were asked for.
      truncated: opts.records ? total > MAX_SELLERS : false,
      took_ms: Date.now() - started,
      // UNDEFINED when the crawl was skipped, never `[]`. An empty array says
      // "the chain holds no attestations", which is a different fact and the
      // exact collapse `types.ts` warns about for the catalog's own copy.
      sellers: opts.records ? sellers : undefined,
    });
  } catch {
    // No partial answer. A crawl that died halfway would otherwise report
    // "2 records" under a real block number, which reads as the registry
    // having shrunk rather than as a read that did not finish.
    return unread("registry.read");
  }
}
