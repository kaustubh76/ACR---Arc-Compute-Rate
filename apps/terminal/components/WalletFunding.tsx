"use client";

/* The visitor's wallet, funded or not, and the ONE thing to do next.
 *
 * Every purchase path in the terminal ends in "pay from Gateway", and a
 * community tester arrives with USDC on Base, or nowhere. This is the state
 * machine between those two facts: no USDC on Arc → bridge some in (CCTP, from
 * the wallet, inside this row); USDC but a short Gateway → deposit; enough →
 * the caller's buy button is live. Woven into whichever row owns the wallet
 * (the developers console, a shop-floor listing); it is not a panel. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Ed } from "@/components/Ed";
import { bridgePlan, bridgeToArc, readableWalletError, type BridgeProgress, type BridgeSource } from "@/lib/bridge";
import type { chainFacts } from "@/lib/chain";
import { txUrl } from "@/lib/chain";
import { depositToGateway, type FundingStep, type WalletSession } from "@/lib/walletPayer";

type Facts = ReturnType<typeof chainFacts>;

export interface WalletBalances {
  usdc_wallet: number;
  usdc_gateway: number;
  next: FundingStep;
}

export async function readBalances(address: string, price: number): Promise<WalletBalances | null> {
  try {
    const r = await fetch(`/api/wallet/balances?address=${address}&price=${price}`, { cache: "no-store" });
    return r.ok ? ((await r.json()) as WalletBalances) : null;
  } catch {
    return null;
  }
}

function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function WalletFunding({
  wallet,
  facts,
  price,
  onChange,
  refreshKey = 0,
}: {
  wallet: WalletSession;
  facts: Facts;
  /** The price the caller wants to pay next; 0 = any Gateway balance counts. */
  price: number;
  /** Fires with fresh balances after every read, so the owner can enable its buy button. */
  onChange?: (b: WalletBalances) => void;
  /** Bump after a payment: balances re-read without losing the bridge's progress. */
  refreshKey?: number;
}) {
  const [bal, setBal] = useState<WalletBalances | null>(null);
  const [busy, setBusy] = useState<"deposit" | "bridge" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [depositAmt, setDepositAmt] = useState("0.05");
  const plan = bridgePlan(facts);
  const [source, setSource] = useState<BridgeSource | null>(plan?.sources[0] ?? null);
  const [bridgeAmt, setBridgeAmt] = useState("1");
  const [steps, setSteps] = useState<BridgeProgress[]>([]);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const refresh = useCallback(async () => {
    const b = await readBalances(wallet.address, price);
    if (b && alive.current) {
      setBal(b);
      onChange?.(b);
    }
    return b;
  }, [wallet.address, price, onChange]);
  useEffect(() => void refresh(), [refresh, refreshKey]);

  // Gateway credits a deposit after finality; a mint lands after attestation.
  // Poll a few times rather than claim a balance the chain has not shown yet.
  const settle = useCallback(async (until: (b: WalletBalances) => boolean, tries = 8) => {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const b = await refresh();
      if (b && until(b)) return;
    }
  }, [refresh]);

  const deposit = useCallback(async () => {
    setBusy("deposit");
    setErr(null);
    try {
      await depositToGateway(wallet, facts, depositAmt);
      await settle((b) => b.next === "ready");
    } catch (e) {
      setErr(readableWalletError(e));
    } finally {
      setBusy(null);
    }
  }, [wallet, facts, depositAmt, settle]);

  const bridge = useCallback(async () => {
    if (!source) return;
    setBusy("bridge");
    setErr(null);
    setSteps([]);
    try {
      const out = await bridgeToArc(facts, source, bridgeAmt, (p) =>
        setSteps((s) => [...s.filter((x) => x.name !== p.name), p]),
      );
      if (!out.ok) setErr("the bridge did not complete; the steps above say where it stopped");
      await settle((b) => b.usdc_wallet > 0, 12);
    } catch (e) {
      setErr(readableWalletError(e));
    } finally {
      setBusy(null);
    }
  }, [facts, source, bridgeAmt, settle]);

  const next = bal?.next ?? null;
  return (
    <div className="lab-note wallet-funding" style={{ marginTop: 4 }}>
      <Ed
        x={
          <>
            <b>{short(wallet.address)}</b> on {facts.name}
            {bal ? ` · wallet ${bal.usdc_wallet.toFixed(4)} USDC · Gateway ${bal.usdc_gateway.toFixed(4)} USDC` : " · reading balances…"}
            . x402 pays from the Gateway balance.
          </>
        }
        p={
          <>
            <b>{short(wallet.address)}</b> on {facts.name}
            {bal ? ` · in wallet ${bal.usdc_wallet.toFixed(4)} · ready to spend ${bal.usdc_gateway.toFixed(4)}` : " · checking…"}
            . Payments come from the ready-to-spend part.
          </>
        }
      />
      {next === "deposit" && (
        <span className="deposit-row">
          <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} aria-label="USDC to deposit" style={{ width: 80 }} />
          <button className="btn btn-quiet" onClick={deposit} disabled={busy !== null}>
            {busy === "deposit" ? (
              <Ed x="two signatures, then finality…" p="two signatures, then a short wait…" />
            ) : (
              <Ed x="Deposit to Gateway" p="Move it to ready-to-spend" />
            )}
          </button>
        </span>
      )}
      {next === "bridge" && plan && source && (
        <>
          <span className="deposit-row">
            <select value={source.key} onChange={(e) => setSource(plan.sources.find((s) => s.key === e.target.value) ?? source)} aria-label="bridge from">
              {plan.sources.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
            <input value={bridgeAmt} onChange={(e) => setBridgeAmt(e.target.value)} aria-label="USDC to bridge" style={{ width: 64 }} />
            <button className="btn btn-quiet" onClick={bridge} disabled={busy !== null}>
              {busy === "bridge" ? (
                <Ed x="bridging…" p="moving it over…" />
              ) : (
                <Ed x={`Bring USDC from ${source.label} to ${facts.name} →`} p={`Bring USDC over from ${source.label} →`} />
              )}
            </button>
          </span>
          <span className="muted" style={{ fontSize: 12.5 }}>
            <Ed
              x="No USDC on this chain yet. CCTP burns on the source chain and mints here; two signatures there, then a wait."
              p="You have no USDC on this chain yet. This moves some over: you sign twice on the other chain, then wait a few minutes."
            />
          </span>
        </>
      )}
      {steps.length > 0 && (
        <ul className="bridge-steps">
          {steps.map((s) => (
            <li key={s.name} className={s.state === "error" ? "vermilion" : undefined}>
              {s.message ?? s.name}
              {s.txHash ? (
                <>
                  {" · "}
                  <a href={s.explorerUrl ?? txUrl(s.txHash, facts.explorer)} target="_blank" rel="noreferrer">
                    {s.txHash.slice(0, 10)}…
                  </a>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {err && <pre className="vermilion">{err}</pre>}
    </div>
  );
}
