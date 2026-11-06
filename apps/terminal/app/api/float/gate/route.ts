import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";

import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import { floatConfig } from "@/lib/floatOnchain";
import type { WorldGateState } from "@/lib/worldGate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/* Is the World ID gate armed on chain.

   WHY THIS READS THE CHAIN RATHER THAN THE PRESS. Every other approval surface
   proxies `/float/checkpoints`, and when the press cannot answer the page can
   only say so -- which is what a visitor currently sees, and it tells them
   nothing about an integration that does work. These four slots live on the
   vault itself, so they are readable whether or not any press is running, and
   they are the honest answer to "where does this actually stand".

   THE POINT IS THAT IT MOVES BY ITSELF. Nothing here is configured or
   hardcoded. When the owner sends the rotations and the binding, the next read
   returns different values and the page changes with it, so the UI is the
   witness for the go-live rather than a description of it.

   MEMOIZED, BECAUSE THE ARC LIMITER IS PER SOURCE ADDRESS and shared with
   another session on this machine. These values change only when an owner
   transaction lands -- a handful of times, ever -- so a minute of staleness
   costs nothing and an unthrottled poll would be rude to every other reader on
   the same host. `Promise.all` over a `batch: true` transport puts all five
   reads in one JSON-RPC round. */

const MEMO_MS = 60_000;
const TIMEOUT_MS = 9_000;

const ABI = [
  { type: "function", name: "treasurerBinding", inputs: [], outputs: [{ type: "bytes32" }], stateMutability: "view" },
  { type: "function", name: "humanApprover", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "guestRegistrar", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "paused", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const;

type Memo = { at: number; state: WorldGateState };
const memo = new Map<string, Memo>();

export async function GET(req: Request) {
  const chain = requestChain(req);
  const cfg = floatConfig(chain);
  if (typeof cfg === "string") {
    /* A vault on another chain and a host with no RPC are different facts, and
       `floatConfig` already words both. Pass its sentence through rather than
       inventing a second vocabulary for the same conditions. */
    return NextResponse.json(envelope({ status: "pending", reason: cfg }, { live: false, chain }), {
      headers: refusalHeaders(),
    });
  }

  const hit = memo.get(chain);
  if (hit && Date.now() - hit.at < MEMO_MS) {
    return NextResponse.json(envelope({ status: "ok", gate: hit.state }, { live: true, chain }), {
      headers: refusalHeaders(),
    });
  }

  try {
    const client = createPublicClient({
      transport: http(cfg.rpc, { batch: true, timeout: TIMEOUT_MS }),
    });
    const read = (functionName: (typeof ABI)[number]["name"]) =>
      client.readContract({ address: cfg.vault, abi: ABI, functionName });

    const [binding, approver, registrar, owner, paused, chainId] = await Promise.all([
      read("treasurerBinding"),
      read("humanApprover"),
      read("guestRegistrar"),
      read("owner"),
      read("paused"),
      client.getChainId(),
    ]);

    const state: WorldGateState = {
      vault: cfg.vault,
      chainId: Number(chainId),
      treasurerBinding: String(binding),
      humanApprover: String(approver),
      guestRegistrar: String(registrar),
      owner: String(owner),
      paused: Boolean(paused),
    };
    memo.set(chain, { at: Date.now(), state });
    return NextResponse.json(envelope({ status: "ok", gate: state }, { live: true, chain }), {
      headers: refusalHeaders(),
    });
  } catch {
    /* A chain that did not answer is not a gate that is unarmed, and saying so
       would be the more flattering of the two readings. Never guess here. */
    return NextResponse.json(
      envelope(
        { status: "pending", reason: "the vault's chain did not answer, so its gate cannot be read" },
        { live: false, chain },
      ),
      { headers: refusalHeaders() },
    );
  }
}
