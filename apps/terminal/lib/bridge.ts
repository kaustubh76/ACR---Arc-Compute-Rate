/* Bring USDC onto Arc from the chain a visitor already holds it on.
 *
 * Arc ships no hosted bridge, and Circle's onramp needs KYB, so without this a
 * community tester with USDC on Base has no way to buy anything here. Circle's
 * Bridge Kit wraps CCTP and runs from a browser wallet with no kit key: approve
 * on the source chain, burn, wait for Circle's attestation, mint on Arc. The
 * kit is loaded lazily (it is heavy) and only on the client.
 *
 * Pure decisions — which sources are offered on which Arc, how a step reads,
 * how a wallet error reads — are exported so they are tested without a wallet. */

import type { chainFacts } from "./chain";
import { isMainnet } from "./chain";

type Facts = ReturnType<typeof chainFacts>;

/** A source chain a visitor can bridge from, keyed by the kit's Blockchain name. */
export interface BridgeSource {
  /** The kit's identifier (`Blockchain` enum literal). */
  key: string;
  /** What the visitor sees. */
  label: string;
  /** EVM chain id, to tell the wallet where to switch. */
  chainId: number;
}

/** Gateway's mainnet chain list ∩ Bridge Kit, EVM only; the Sepolia twins on
 *  testnet so the same control is exercised today. Order = where USDC usually is. */
export const MAINNET_SOURCES: BridgeSource[] = [
  { key: "Base", label: "Base", chainId: 8453 },
  { key: "Ethereum", label: "Ethereum", chainId: 1 },
  { key: "Arbitrum", label: "Arbitrum", chainId: 42161 },
  { key: "Optimism", label: "OP Mainnet", chainId: 10 },
  { key: "Polygon", label: "Polygon", chainId: 137 },
  { key: "Avalanche", label: "Avalanche", chainId: 43114 },
  { key: "Unichain", label: "Unichain", chainId: 130 },
];
export const TESTNET_SOURCES: BridgeSource[] = [
  { key: "Base_Sepolia", label: "Base Sepolia", chainId: 84532 },
  { key: "Ethereum_Sepolia", label: "Ethereum Sepolia", chainId: 11155111 },
  { key: "Arbitrum_Sepolia", label: "Arbitrum Sepolia", chainId: 421614 },
  { key: "Optimism_Sepolia", label: "OP Sepolia", chainId: 11155420 },
  { key: "Polygon_Amoy_Testnet", label: "Polygon Amoy", chainId: 80002 },
  { key: "Avalanche_Fuji", label: "Avalanche Fuji", chainId: 43113 },
];

/** Where to bridge FROM, and the kit's name for the Arc we are on. */
export function bridgePlan(f: Facts): { sources: BridgeSource[]; arc: string } | null {
  if (isMainnet(f)) return { sources: MAINNET_SOURCES, arc: "Arc" };
  if (f.chainId === 5042002) return { sources: TESTNET_SOURCES, arc: "Arc_Testnet" };
  return null; // anvil and unknown chains: nothing to bridge to
}

/** One step of a bridge as the visitor should read it. */
export interface BridgeProgress {
  name: string;
  state: "pending" | "success" | "error" | "noop";
  txHash?: string;
  explorerUrl?: string;
  message?: string;
}

const STEP_WORDS: Record<string, string> = {
  approve: "approving USDC on the source chain",
  burn: "burning on the source chain",
  fetchAttestation: "waiting for Circle's attestation",
  attestation: "waiting for Circle's attestation",
  mint: "minting on Arc",
  forward: "minting on Arc",
};

/** The kit's step names in the words a visitor should read. Unknown steps keep their name. */
export function describeStep(step: { name: string; state: string; errorMessage?: string }): string {
  const what = STEP_WORDS[step.name] ?? step.name;
  if (step.state === "error") return `${what}: ${step.errorMessage ?? "failed"}`;
  if (step.state === "success") return `${what} · done`;
  if (step.state === "noop") return `${what} · not needed`;
  return `${what}…`;
}

/** A sentence for the wallet errors a visitor actually meets. Everything else
 *  keeps its own message, so a real bug is not hidden behind a friendly one. */
export function readableWalletError(e: unknown): string {
  const err = e as { code?: number; message?: string; shortMessage?: string; cause?: { code?: number } };
  const code = err?.code ?? err?.cause?.code;
  const msg = (err?.shortMessage ?? err?.message ?? "").toString();
  if (code === 4001 || /user rejected|user denied|rejected the request/i.test(msg)) {
    return "you declined in your wallet; nothing was sent";
  }
  if (code === -32002) return "your wallet already has a request open; finish it there first";
  if (code === 4902) return "your wallet does not know this chain yet; press connect again to add it";
  if (/insufficient funds/i.test(msg)) return "not enough USDC for this transaction and its gas (gas on Arc is USDC too)";
  if (/chain mismatch|wrong chain|does not match/i.test(msg)) return "your wallet is on another chain; switch and press again";
  if (!msg) return "the wallet returned no reason";
  return msg.length > 160 ? `${msg.slice(0, 157)}…` : msg;
}

export interface BridgeOutcome {
  ok: boolean;
  steps: BridgeProgress[];
  /** Amount minted on Arc, as the kit reports it. */
  amount: string;
}

/** Bridge `amountUsdc` from `source` to Arc, from the injected wallet. The wallet
 *  is switched to the source chain by the kit; the visitor signs approve + burn
 *  there; attestation and mint need nothing from them. `onStep` fires per step. */
export async function bridgeToArc(
  f: Facts,
  source: BridgeSource,
  amountUsdc: string,
  onStep?: (p: BridgeProgress) => void,
): Promise<BridgeOutcome> {
  const plan = bridgePlan(f);
  if (!plan) throw new Error(`${f.name} is not a chain USDC can be bridged to`);
  const eth = (globalThis as { window?: { ethereum?: unknown } }).window?.ethereum;
  if (!eth) throw new Error("no wallet found in this browser");
  const [{ BridgeKit }, { createViemAdapterFromProvider }] = await Promise.all([
    import("@circle-fin/bridge-kit"),
    import("@circle-fin/adapter-viem-v2"),
  ]);
  const adapter = await createViemAdapterFromProvider({ provider: eth as never });
  const kit = new BridgeKit();
  const seen: BridgeProgress[] = [];
  const relay = (payload: unknown) => {
    const p = payload as { method?: string; values?: { txHash?: string; explorerUrl?: string } };
    const name = p?.method ?? "";
    if (!name) return;
    const step: BridgeProgress = { name, state: "success", ...p.values, message: describeStep({ name, state: "success" }) };
    seen.push(step);
    onStep?.(step);
  };
  kit.on("*", relay as never);
  try {
    const result = await kit.bridge({
      from: { adapter, chain: source.key as never },
      to: { adapter, chain: plan.arc as never },
      amount: amountUsdc,
    });
    const steps: BridgeProgress[] = result.steps.map((s) => ({
      name: s.name,
      state: s.state,
      txHash: s.txHash,
      explorerUrl: s.explorerUrl,
      message: describeStep(s),
    }));
    for (const s of steps) onStep?.(s);
    return { ok: result.state === "success", steps, amount: result.amount };
  } finally {
    kit.off("*", relay as never);
  }
}
