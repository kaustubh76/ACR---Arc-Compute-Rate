"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AddressChip } from "./AddressChip";
import { Ed } from "@/components/Ed";
import { fmt } from "@/lib/format";
import type { FuturesDeskRow } from "@/lib/types";

/* The Public Desk — the reader takes a REAL position on ACRFutures with a
   Circle user-controlled wallet (SCA on Arc, PIN-secured in Circle's hosted
   UI, Gas Station-sponsored gas). This component owns only UI state: every
   sensitive step is a backend-minted challengeId the reader authorizes with
   their PIN via @circle-fin/w3s-pw-web-sdk. Guardrails (faucet caps, qty
   clamps, roster headroom) are server-side.

   Demo-grade session persistence: the desk user id + step flags live in
   localStorage so a revisit resumes; tokens are re-minted per session. */

type Phase = "closed" | "opening" | "pin" | "unfunded" | "collateral" | "trading";

interface Session {
  app_id: string;
  user_token: string;
  encryption_key: string;
  challenge_id: string | null;
  wallet: { wallet_id: string; address: string } | null;
}

interface Position {
  contracts: number;
  avg_price: number;
  upnl_usdc: number;
}

const USER_KEY = "acr-desk-user";
const COLLAT_KEY = "acr-desk-collateralized";

function deskUserId(): string {
  let id = localStorage.getItem(USER_KEY);
  if (!id) {
    id = `acr-desk-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(USER_KEY, id);
  }
  return id;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { detail?: string };
  if (!res.ok) throw new Error(data.detail ?? `desk error (${res.status})`);
  return data;
}

export function PublicDesk({
  desks,
  live,
  explorer,
}: {
  desks?: Record<string, FuturesDeskRow>;
  live: boolean;
  explorer?: string;
}) {
  const [phase, setPhase] = useState<Phase>("closed");
  const [session, setSession] = useState<Session | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  const [indexId, setIndexId] = useState("ACR-GPU");
  const [position, setPosition] = useState<Position | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sdkRef = useRef<{ setAuthentication: (a: object) => void; execute: (id: string, cb: (e: unknown) => void) => void } | null>(null);

  const tradable = Object.keys(desks ?? {});
  const desk = (desks ?? {})[indexId];

  useEffect(() => {
    if (tradable.length && !tradable.includes(indexId)) setIndexId(tradable[0]);
  }, [tradable, indexId]);

  /** Circle's Web SDK, loaded lazily in the browser only. getDeviceId() is
   *  load-bearing: without it execute() silently no-ops. */
  const sdk = useCallback(async (appId: string) => {
    if (!sdkRef.current) {
      const { W3SSdk } = await import("@circle-fin/w3s-pw-web-sdk");
      const s = new W3SSdk({ appSettings: { appId } });
      await s.getDeviceId();
      sdkRef.current = s as unknown as typeof sdkRef.current;
    }
    return sdkRef.current!;
  }, []);

  const executeChallenge = useCallback(
    async (s: Session, challengeId: string) =>
      new Promise<void>((resolve, reject) => {
        void sdk(s.app_id).then((w3s) => {
          if (!w3s) return reject(new Error("wallet SDK unavailable"));
          w3s.setAuthentication({ userToken: s.user_token, encryptionKey: s.encryption_key });
          w3s.execute(challengeId, (error: unknown) =>
            error ? reject(error instanceof Error ? error : new Error(String((error as { message?: string })?.message ?? "declined"))) : resolve(),
          );
        }, reject);
      }),
    [sdk],
  );

  const refreshWallet = useCallback(async (s: Session) => {
    const w = await api<{ wallet: Session["wallet"]; usdc: number | null }>("/api/desk/wallet", {
      user_token: s.user_token,
    });
    if (w.wallet) {
      setSession({ ...s, wallet: w.wallet });
      setUsdc(w.usdc);
      const collateralized = localStorage.getItem(COLLAT_KEY) === w.wallet.address;
      setPhase(w.usdc && w.usdc > 0 ? (collateralized ? "trading" : "collateral") : "unfunded");
    }
    return w.wallet;
  }, []);

  const step = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setNote(null);
      try {
        await fn();
      } catch (e) {
        setNote(e instanceof Error ? e.message : "something went wrong — try again");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const open = () =>
    step(async () => {
      setPhase("opening");
      const s = await api<Session>("/api/desk/session", { user_id: deskUserId() });
      setSession(s);
      if (s.wallet) {
        await refreshWallet(s);
      } else if (s.challenge_id) {
        setPhase("pin");
      }
    });

  const setPin = () =>
    step(async () => {
      if (!session?.challenge_id) return;
      await executeChallenge(session, session.challenge_id);
      // Circle indexes the new wallet momentarily after the PIN ceremony.
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        if (await refreshWallet(session)) return;
      }
      setNote("wallet still provisioning — reopen the desk in a moment");
    });

  const stake = () =>
    step(async () => {
      if (!session?.wallet) return;
      await api("/api/desk/faucet", { address: session.wallet.address });
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        await refreshWallet(session);
        if (usdc && usdc > 0) return;
      }
    });

  const collateralize = () =>
    step(async () => {
      if (!session?.wallet) return;
      for (const action of ["approve", "collateral"] as const) {
        const ch = await api<{ challenge_id: string }>("/api/desk/challenge", {
          user_token: session.user_token,
          wallet_id: session.wallet.wallet_id,
          action,
          index_id: indexId,
        });
        await executeChallenge(session, ch.challenge_id);
      }
      localStorage.setItem(COLLAT_KEY, session.wallet.address);
      setPhase("trading");
    });

  const trade = (qty: number) =>
    step(async () => {
      if (!session?.wallet) return;
      const ch = await api<{ challenge_id: string }>("/api/desk/challenge", {
        user_token: session.user_token,
        wallet_id: session.wallet.wallet_id,
        action: "trade",
        index_id: indexId,
        qty,
      });
      await executeChallenge(session, ch.challenge_id);
      setNote(null);
    });

  // Position poll while trading (10s, matches the route's CDN window).
  useEffect(() => {
    if (phase !== "trading" || !session?.wallet || !desk) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await api<{ position: Position | null }>(
          `/api/desk/position?series=${desk.series_id}&addr=${session.wallet!.address}`,
        );
        if (alive) setPosition(r.position);
      } catch {
        /* throttled — next tick */
      }
    };
    void poll();
    const t = setInterval(poll, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [phase, session, desk]);

  if (!live) {
    return (
      <section className="section">
        <div className="section-head">
          <span className="label">
            <Ed x="The public desk" p="Trade it yourself" />
          </span>
        </div>
        <p className="muted">
          <Ed
            x="the public desk opens when the press is live — archived editions are read-only"
            p="you can trade here once the live server is awake — the saved edition is read-only"
          />
        </p>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">
          <Ed x="The public desk — trade the curve yourself" p="Trade it yourself — with a real wallet" />
        </span>
        <span className="label">
          <span className="chip chip-teal">
            <Ed x="Circle wallet · gas sponsored" p="Circle wallet · fees covered" />
          </span>
        </span>
      </div>

      <p className="muted" style={{ maxWidth: 620 }}>
        <Ed
          x="Open a Circle user-controlled wallet (SCA on Arc — your PIN, Circle custody tech, our gas sponsorship), stake $0.50 USDC, and take a real position against the maker."
          p="Make a small wallet secured by a PIN, get 50 cents of test money, and place a real trade on the blockchain — fees are covered."
        />
      </p>

      {phase === "closed" || phase === "opening" ? (
        <button className="btn" onClick={open} disabled={busy}>
          <Ed x={busy ? "opening…" : "open a desk account"} p={busy ? "opening…" : "start — make my wallet"} />
        </button>
      ) : null}

      {phase === "pin" && (
        <button className="btn" onClick={setPin} disabled={busy}>
          <Ed x={busy ? "waiting on Circle…" : "set your PIN (Circle's window)"} p={busy ? "waiting…" : "choose a PIN to protect it"} />
        </button>
      )}

      {session?.wallet && phase !== "pin" && (
        <p className="mono" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <AddressChip address={session.wallet.address} explorer={explorer} />
          <span className="muted">
            {usdc != null ? `${usdc.toFixed(4)} USDC` : "…"}
          </span>
        </p>
      )}

      {phase === "unfunded" && (
        <button className="btn" onClick={stake} disabled={busy}>
          <Ed x={busy ? "settling…" : "take your $0.50 stake"} p={busy ? "sending…" : "get my 50 cents"} />
        </button>
      )}

      {phase === "collateral" && (
        <button className="btn" onClick={collateralize} disabled={busy}>
          <Ed
            x={busy ? "two PIN confirmations…" : `post collateral on ${indexId}`}
            p={busy ? "confirm twice with your PIN…" : "put up my stake to trade"}
          />
        </button>
      )}

      {phase === "trading" && desk && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <select
            className="mono"
            value={indexId}
            onChange={(e) => {
              setIndexId(e.target.value);
              localStorage.removeItem(COLLAT_KEY); // collateral is per-series
              setPhase("collateral");
            }}
            aria-label="index to trade"
          >
            {tradable.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => trade(1)} disabled={busy}>
            <Ed x="BUY 1" p="BUY 1" />
          </button>
          <button className="btn" onClick={() => trade(-1)} disabled={busy}>
            <Ed x="SELL 1" p="SELL 1" />
          </button>
          {position && position.contracts !== 0 ? (
            <span className="mono">
              {position.contracts > 0 ? "long" : "short"} {Math.abs(position.contracts).toFixed(0)} @ {fmt(position.avg_price)}{" "}
              <span className={position.upnl_usdc >= 0 ? "green" : "vermilion"}>
                {position.upnl_usdc >= 0 ? "+" : ""}
                {position.upnl_usdc.toFixed(4)} USDC
              </span>
            </span>
          ) : (
            <span className="muted">
              <Ed x="flat — your fills print on the tape above" p="no position yet — your trades appear in the feed above" />
            </span>
          )}
        </div>
      )}

      {note && <p className="muted vermilion">{note}</p>}
    </section>
  );
}
