"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AddressChip } from "./AddressChip";
import { Ed } from "@/components/Ed";
import { fmt } from "@/lib/format";
import type { FuturesDeskRow } from "@/lib/types";
import { deskPhase, type DeskPhase } from "@/lib/deskPhase";

/* The Public Desk — the reader takes a REAL position on ACRFutures with a
   Circle user-controlled wallet (SCA on Arc, PIN-secured in Circle's hosted
   UI, Gas Station-sponsored gas). This component owns only UI state: every
   sensitive step is a backend-minted challengeId the reader authorizes with
   their PIN via @circle-fin/w3s-pw-web-sdk. Guardrails (faucet caps, qty
   clamps, roster headroom) are server-side.

   Demo-grade session persistence: the desk user id + step flags live in
   localStorage so a revisit resumes; tokens are re-minted per session. */

// The phase machine lives in lib/deskPhase so the decision a returning
// reader depends on can be unit-tested; see deskPhase.test.ts.
type Phase = DeskPhase;

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

/** One series this wallet holds collateral in. */
interface ExitRow {
  series_id: number;
  index_id: string;
  settled: boolean;
  expired: boolean;
  collateral_usdc: number;
  contracts: number;
  free_usdc: number;
}

/** Everything the venue will let this wallet take back out. Spans EVERY series
 *  it holds collateral in, including expired and settled ones — the exit has to
 *  keep working after the market you entered stops trading, and a series roll
 *  leaves a returning reader holding a stake in the old one. */
interface Withdrawable {
  series: ExitRow[];
  total_free_usdc: number;
}

/** Server-computed size caps: the largest trade each way that clears BOTH the
 *  taker's and the auto-mirrored maker's margin check on ACRFutures. */
interface Limits {
  mark: number;
  max_buy: number;
  max_sell: number;
  collateral_usdc: number;
  contracts: number;
}

const USER_KEY = "acr-desk-user";
const COLLAT_KEY = "acr-desk-collateralized";
/** Below this the contract's margin check leaves nothing worth trading. */
const MIN_TRADE = 0.05;
/** Below this a withdrawal is not worth a PIN ceremony (mirrors the server). */
const MIN_WITHDRAW = 0.01;
/** How long to wait on the wallet SDK's completion callback before falling
 *  back to reading the venue. Comfortably longer than a confirmed Arc tx. */
const SDK_CALLBACK_TIMEOUT_MS = 75_000;

function deskUserId(): string {
  let id = localStorage.getItem(USER_KEY);
  if (!id) {
    // A session id is a bearer credential: whoever knows it can open the
    // session. Math.random() is not a CSPRNG, so use one (with a fallback for
    // any context where crypto.randomUUID is unavailable).
    id = `acr-desk-${
      globalThis.crypto?.randomUUID?.() ??
      Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    }`;
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
  const [limits, setLimits] = useState<Limits | null>(null);
  const [exit, setExit] = useState<Withdrawable | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sdkRef = useRef<{ setAuthentication: (a: object) => void; execute: (id: string, cb: (e: unknown) => void) => void } | null>(null);

  const tradable = Object.keys(desks ?? {});
  const desk = (desks ?? {})[indexId];
  // Offer the full feasible size; before the first /limits answer, offer the
  // floor — the server re-clamps every challenge anyway.
  const buySize = limits ? limits.max_buy : MIN_TRADE;
  const sellSize = limits ? limits.max_sell : MIN_TRADE;

  useEffect(() => {
    if (tradable.length && !tradable.includes(indexId)) setIndexId(tradable[0]);
  }, [tradable, indexId]);

  // The wallet refresher is identity-stable (it runs inside poll loops), so it
  // reads the selected index through a ref rather than closing over it.
  const indexRef = useRef(indexId);
  useEffect(() => {
    indexRef.current = indexId;
  }, [indexId]);

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

  /** Run one challenge through Circle's PIN ceremony.
   *
   *  Resolves on the SDK's callback — but ALSO resolves on a timeout, because
   *  the callback is not reliable: the hosted UI can complete a transaction
   *  (Circle reports it COMPLETE, it is on-chain) and still never invoke the
   *  callback, which would otherwise hang the desk forever on an action that
   *  actually succeeded. A rejection still means a real, reported failure. The
   *  caller confirms the outcome against the venue either way. */
  const executeChallenge = useCallback(
    async (s: Session, challengeId: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, SDK_CALLBACK_TIMEOUT_MS);
        const done = (fn: () => void) => {
          clearTimeout(timer);
          fn();
        };
        void sdk(s.app_id).then((w3s) => {
          if (!w3s) return done(() => reject(new Error("wallet SDK unavailable")));
          w3s.setAuthentication({ userToken: s.user_token, encryptionKey: s.encryption_key });
          w3s.execute(challengeId, (error: unknown) =>
            error
              ? done(() =>
                  reject(
                    error instanceof Error
                      ? error
                      : new Error(String((error as { message?: string })?.message ?? "declined")),
                  ),
                )
              : done(resolve),
          );
        }, (e) => done(() => reject(e)));
      }),
    [sdk],
  );

  /** Re-read the wallet + its stake. Returns the fresh balance so pollers can
   *  test THIS value — reading the `usdc` state inside a loop would test the
   *  render-time capture, which never updates while the loop runs. */
  const refreshWallet = useCallback(async (s: Session) => {
    const w = await api<{ wallet: Session["wallet"]; usdc: number | null }>("/api/desk/wallet", {
      user_token: s.user_token,
    });
    if (w.wallet) {
      const { address } = w.wallet;
      setSession({ ...s, wallet: w.wallet });
      setUsdc(w.usdc);
      const collateralized = localStorage.getItem(COLLAT_KEY) === address;
      setPhase(deskPhase({ usdc: w.usdc, collateralized }));
      // If localStorage was cleared (or this is a different browser), ask the
      // venue rather than stranding a reader whose money is demonstrably
      // posted.
      if (!(w.usdc && w.usdc > 0) && !collateralized) {
        const live = await api<Limits>("/api/desk/limits", {
          address,
          index_id: indexRef.current,
        }).catch(() => null);
        if (live?.collateral_usdc) {
          setLimits(live);
          localStorage.setItem(COLLAT_KEY, address);
          setPhase("trading");
        }
      }
    }
    return w;
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
      // Circle provisions the SCA after the PIN ceremony — it is deploying a
      // contract wallet, not writing a row, so give it a real minute.
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        if ((await refreshWallet(session)).wallet) return;
      }
      setNote("wallet still provisioning — reopen the desk in a moment");
    });

  const stake = () =>
    step(async () => {
      if (!session?.wallet) return;
      // The drip is fire-and-forget server-side (Circle's confirm outlives the
      // request), so the balance IS the completion signal — poll for it.
      await api("/api/desk/faucet", { user_token: session.user_token });
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 2500));
        const w = await refreshWallet(session);
        if (w.usdc && w.usdc > 0) return;
      }
      setNote("the stake is still settling — give it a moment and reopen the desk");
    });

  const refreshExit = useCallback(async (address: string) => {
    try {
      const w = await api<Withdrawable>("/api/desk/withdrawable", { address });
      setExit(w);
      return w;
    } catch {
      setExit(null); // throttled — the button just stays hidden this tick
      return null;
    }
  }, []);

  const refreshLimits = useCallback(async (address: string, id: string) => {
    try {
      const l = await api<Limits>("/api/desk/limits", { address, index_id: id });
      setLimits(l);
      return l;
    } catch {
      setLimits(null); // throttled or no margin yet — the buttons fall back
      return null;
    }
  }, []);

  const collateralize = () =>
    step(async () => {
      if (!session?.wallet) return;
      const { address } = session.wallet;
      try {
        for (const action of ["approve", "collateral"] as const) {
          const ch = await api<{ challenge_id: string }>("/api/desk/challenge", {
            user_token: session.user_token,
            wallet_id: session.wallet.wallet_id,
            action,
            index_id: indexId,
            address,
          });
          await executeChallenge(session, ch.challenge_id);
        }
      } catch (e) {
        // The wallet SDK's callback is not the source of truth — the chain is.
        // A dropped callback on a transaction that actually landed must not
        // strand a reader whose collateral is already posted, so fall through
        // to the on-chain check and only surface the error if it really failed.
        const posted = await refreshLimits(address, indexId);
        if (!posted?.collateral_usdc) throw e;
      }
      const live = await refreshLimits(address, indexId);
      if (!live?.collateral_usdc) {
        setNote("collateral is still confirming — give it a moment");
        return;
      }
      localStorage.setItem(COLLAT_KEY, address);
      setPhase("trading");
    });

  const trade = (qty: number) =>
    step(async () => {
      if (!session?.wallet) return;
      const { address } = session.wallet;
      const before = (await refreshLimits(address, indexId))?.contracts ?? 0;
      const ch = await api<{ challenge_id: string }>("/api/desk/challenge", {
        user_token: session.user_token,
        wallet_id: session.wallet.wallet_id,
        action: "trade",
        index_id: indexId,
        qty,
        address,
      });
      await executeChallenge(session, ch.challenge_id);
      setNote(null);
      // The fill is real when the VENUE says the position moved, not when the
      // wallet SDK says so — poll past the challenge for the position change.
      for (let i = 0; i < 12; i++) {
        const live = await refreshLimits(address, indexId);
        if (live && Math.abs(live.contracts - before) > 1e-9) {
          // AWAIT the exit refresh: opening a position pins most of the stake
          // as margin, so the withdraw button's number is wrong the instant
          // the fill lands. Fire-and-forget left it showing the pre-trade
          // figure — a real run offered "WITHDRAW 0.50 USDC" two seconds
          // after a trade that had left only 0.05 free. The server re-reads
          // and withdraws the correct amount, so the money was never at risk;
          // the button was just making a promise the venue would not keep.
          await refreshExit(address);
          return;
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      setNote("the fill is still confirming — the tape above will show it");
    });

  /** Take collateral back out of one series. Works on a settled or expired
   *  series too — that is the whole point, so it is deliberately not gated on
   *  `phase`. */
  const withdraw = (row: ExitRow) =>
    step(async () => {
      if (!session?.wallet) return;
      const { address } = session.wallet;
      const ch = await api<{ challenge_id: string }>("/api/desk/challenge", {
        user_token: session.user_token,
        wallet_id: session.wallet.wallet_id,
        action: "withdraw",
        index_id: row.index_id,
        series_id: row.series_id,
        address,
      });
      await executeChallenge(session, ch.challenge_id);
      // Same rule as every other step: the chain decides, not the SDK callback.
      for (let i = 0; i < 12; i++) {
        const [w, after] = await Promise.all([refreshWallet(session), refreshExit(address)]);
        const still = after?.series.find((r) => r.series_id === row.series_id);
        if ((still?.free_usdc ?? 0) < MIN_WITHDRAW || (w.usdc ?? 0) > 0) {
          localStorage.removeItem(COLLAT_KEY);
          return;
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      setNote("the withdrawal is still confirming — your balance will update");
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

  // Size caps follow the mark, so re-read them with the position.
  useEffect(() => {
    if (phase !== "trading" || !session?.wallet) return;
    void refreshLimits(session.wallet.address, indexId);
  }, [phase, session, indexId, refreshLimits]);

  // The exit is read for ANY wallet at ANY phase — a reader whose series
  // settled while they were away should land straight on the withdraw button.
  useEffect(() => {
    if (!session?.wallet) return;
    void refreshExit(session.wallet.address);
  }, [session, phase, refreshExit]);

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
          x="Open a Circle user-controlled wallet (SCA on Arc — your PIN, Circle custody tech, our gas sponsorship), stake $0.50 USDC, and take a real position on ACRFutures. Withdraw it whenever you like."
          p="Make a small wallet secured by a PIN, get 50 cents of test money, and place a real trade on the blockchain — fees are covered, and you can take your money back out whenever you want."
        />
      </p>

      {/* Say whose book this is. The wallet, the PIN, the margin maths, the
          settlement and every transaction are real; the counterparty and the
          stake are ours. A reader should not have to infer that. */}
      <p className="muted" style={{ maxWidth: 620 }}>
        <Ed
          x="Honest framing: the stake is a testnet grant from us, and the maker on the other side of your fill is our own market-making bot, funded by us. What is real is everything else — the wallet is yours alone, the PIN is the only thing that can sign, and the collateral, fills and settlement are on-chain."
          p="To be straight with you: the 50 cents is a gift from us for testing, and the trader on the other side of your trade is also us. Everything else is real — only your PIN can move your money, and the trade itself really happens on the blockchain."
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
          {/* Sizes come from the server's live margin math, never a hardcoded 1:
              $0.50 of collateral buys well under a contract on a 10× index, and
              an oversized order would revert AFTER the reader entered their PIN. */}
          <button
            className="btn"
            onClick={() => trade(buySize)}
            disabled={busy || buySize < MIN_TRADE}
          >
            <Ed x={`BUY ${buySize}`} p={`BUY ${buySize}`} />
          </button>
          <button
            className="btn"
            onClick={() => trade(-sellSize)}
            disabled={busy || sellSize < MIN_TRADE}
          >
            <Ed x={`SELL ${sellSize}`} p={`SELL ${sellSize}`} />
          </button>
          {limits && (
            <span className="muted mono">
              <Ed
                x={`${limits.collateral_usdc.toFixed(2)} USDC margin @ ${fmt(limits.mark)} mark`}
                p={`${limits.collateral_usdc.toFixed(2)} dollars backing your trade`}
              />
            </span>
          )}
          {position && position.contracts !== 0 ? (
            <span className="mono">
              {position.contracts > 0 ? "long" : "short"} {Math.abs(position.contracts).toFixed(2)} @ {fmt(position.avg_price)}{" "}
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

      {/* The exit — one row per series. Rendered independently of `phase`:
          collateral outlives the market it was posted to, and after a roll a
          returning reader holds a stake in the OLD series and none in the new
          one. Showing only the richest would read as money vanishing. */}
      {exit?.series.map((row) =>
        row.free_usdc >= MIN_WITHDRAW ? (
          <p
            key={row.series_id}
            style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}
          >
            <button className="btn" onClick={() => withdraw(row)} disabled={busy}>
              <Ed
                x={busy ? "confirming…" : `withdraw ${row.free_usdc.toFixed(2)} USDC`}
                p={busy ? "sending…" : `take back my ${row.free_usdc.toFixed(2)} dollars`}
              />
            </button>
            <span className="muted">
              {row.settled ? (
                <Ed
                  x={`${row.index_id} series ${row.series_id} settled — your cleared balance is free`}
                  p="this market has finished — your money is ready to take back"
                />
              ) : row.expired ? (
                <Ed
                  x={`${row.index_id} series ${row.series_id} expired — awaiting settlement`}
                  p="this market has closed — waiting for the final price"
                />
              ) : (
                <Ed
                  x={`${row.index_id} — free margin above your position`}
                  p="the part not backing a trade"
                />
              )}
            </span>
          </p>
        ) : row.contracts !== 0 ? (
          <p className="muted" key={row.series_id}>
            <Ed
              x={`${row.collateral_usdc.toFixed(2)} USDC is margining your ${row.index_id} position — it frees up when you close it or the series settles`}
              p={`your ${row.collateral_usdc.toFixed(2)} dollars is backing the trade you have open — close it, or wait for this market to finish, and you can take it back`}
            />
          </p>
        ) : null,
      )}

      {note && <p className="muted vermilion">{note}</p>}
    </section>
  );
}
