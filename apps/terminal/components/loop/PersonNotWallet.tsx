"use client";

import { useState } from "react";

import { AddressChip } from "@/components/chain/AddressChip";
import { Ed } from "@/components/Ed";
import { money } from "@/lib/format";
import { boundMultiple, logFrac, windowEndsInS } from "@/lib/loop";
import { useClusters, useHumanId } from "@/lib/useLive";
import { useNow } from "@/lib/useNow";
import type { TerminalData } from "@/lib/types";

/* A person, not a wallet — World's AgentKit, drawn and driven.
 *
 * The path: a World credential → the agent's wallet signs the gate's challenge →
 * AgentBook says whose wallet it is → HumanIdMirror has that person's cluster for
 * THIS 7-day window, an opaque keccak of the nullifier, a committed salt and the
 * window → one bill across every wallet the person owns. Every cluster the tape
 * holds this window is drawn as a ring of wallet dots. Prove as the fleet and
 * three dots fold into one bill; prove as the solo human and one dot does. Both
 * are Sandbox identities, flagged onto the chain and into every count, and the
 * keys derive from public labels on the server — a visitor's key is never asked
 * for. Below, the bound the adversary model changes: sybils are free, people are
 * not, and the chain prints both prices.
 */

type Who = "fleet" | "solo";

interface Prove {
  status: number | null;
  address: string | null;
  body: {
    available?: boolean;
    reason?: string;
    human?: { cluster?: string; window?: number; wallet_count?: number };
    purchases?: number;
    spent_usdc?: number;
    vw_slippage_bp?: number | null;
    overpaid_usdc?: number;
    detail?: string;
  } | null;
  replay_status: number | null;
  replay_detail: string | null;
  note: string | null;
}

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 10)}…${a.slice(-4)}` : a);

export function PersonNotWallet({ data }: { data: TerminalData }) {
  const info = useHumanId()?.data?.info ?? null;
  const clustersEnv = useClusters();
  const clusters = clustersEnv?.data?.clusters ?? [];
  const window = clustersEnv?.data?.window ?? null;
  const nowS = useNow();
  const endsIn = nowS > 0 ? windowEndsInS(nowS) : null;
  const thisWindow = clusters.filter((c) => c.window === window);
  const stale = clusters.filter((c) => c.window !== window);

  const [who, setWho] = useState<Who>("fleet");
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<Prove | null>(null);

  async function prove() {
    setBusy(true);
    try {
      const res = await fetch("/api/humanid/prove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ as: who }),
      });
      setProof((await res.json()) as Prove);
    } catch {
      setProof({ status: null, address: null, body: null, replay_status: null, replay_detail: null, note: "the browser could not reach the press" });
    } finally {
      setBusy(false);
    }
  }

  const litCluster = proof?.status === 200 ? proof.body?.human?.cluster?.toLowerCase() : undefined;
  const ok = proof?.status === 200 && proof.body;
  const cls = (stage: number) => (!proof ? "" : ok ? " passed" : stage <= 1 ? " lit" : " blocked");

  // The bound in people: every index, two prices on one log scale.
  const prints = Object.values(data.prints ?? {});
  const vals = prints.flatMap((p) => [p.attack_cost_per_bp, p.human_adjusted_bound ?? 0]).filter((v) => v > 0);
  const lo = vals.length ? Math.min(...vals) / 2 : 0.001;
  const hi = vals.length ? Math.max(...vals) * 1.5 : 10;

  return (
    <section className="section">
      <div className="section-head">
        <Ed x="A person, not a wallet · World AgentKit" p="A person, not a wallet · World" className="label" />
        {info ? (
          <span className="label muted">
            {info.backend} · <Ed x="roster" p="known wallets" /> {info.agentbook ?? "…"} · {info.sandbox ? <Ed x="sandbox identities" p="test identities" /> : <Ed x="production identities" p="checked people" />} · {info.verified_proofs} <Ed x="proofs verified" p="proofs checked" />
          </span>
        ) : null}
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, maxWidth: 68 * 9, marginTop: 0 }}
        x="Wallets are free; people are not. A World credential lets the gate resolve a wallet to one person for one week, as an opaque id that names nobody, and bill every wallet that person owns as one."
        p="Anyone can make wallets; nobody can make people. World ties a wallet to one person for a week, unnamed, and bills all their wallets as one."
      />

      <div className="flow" role="list" aria-label="the human path">
        <div className="flow-station" role="listitem">
          <div className={`flow-node${cls(0)}`}>
            <span className="label"><Ed x="1 · world credential" p="1 · World ID" /></span>
            <span className="flow-value">{proof?.address ? short(proof.address) : <Ed x="an agent's wallet" p="a robot's wallet" />}</span>
            <span className="flow-cap"><Ed x="AgentKit: the wallet a verified person delegated to their agent" p="a wallet a real person handed to their robot" /></span>
          </div>
          <span className="flow-arrow" aria-hidden />
        </div>
        <div className="flow-station" role="listitem">
          <div className={`flow-node${cls(1)}`}>
            <span className="label"><Ed x="2 · sign the challenge" p="2 · sign" /></span>
            <span className="flow-value">{proof ? (ok ? <Ed x="single-use nonce, signed" p="one-time code, signed" /> : <span className="vermilion">{proof.status ?? "…"}</span>) : "…"}</span>
            <span className="flow-cap"><Ed x="a signed message bound to this route, this nonce, this minute" p="a signed note that only works here, once, right now" /></span>
          </div>
          <span className="flow-arrow" aria-hidden />
        </div>
        <div className="flow-station" role="listitem">
          <div className={`flow-node${cls(2)}`}>
            <span className="label"><Ed x="3 · agentbook" p="3 · whose wallet" /></span>
            <span className="flow-value">{ok ? <Ed x="registered" p="known" /> : "…"}</span>
            <span className="flow-cap"><Ed x="World's registry answers whose wallet this is, with a nullifier the press never stores" p="World's list says which person this wallet belongs to, without a name" /></span>
          </div>
          <span className="flow-arrow" aria-hidden />
        </div>
        <div className="flow-station" role="listitem">
          <div className={`flow-node${cls(3)}`}>
            <span className="label"><Ed x="4 · humanidmirror" p="4 · the week's cluster" /></span>
            <span className="flow-value">{ok && proof?.body?.human?.cluster ? short(proof.body.human.cluster) : "…"}</span>
            <span className="flow-cap"><Ed x="cluster = keccak(nullifier, salt, window): rotates every 7 days, names nobody" p="a weekly code for one person that reveals nothing about them" /></span>
          </div>
          <span className="flow-arrow" aria-hidden />
        </div>
        <div className="flow-station" role="listitem">
          <div className={`flow-node${cls(4)}`}>
            <span className="label"><Ed x="5 · one bill" p="5 · one bill" /></span>
            <span className="flow-value">
              {ok && proof?.body?.available ? (
                <>{proof.body.human?.wallet_count} <Ed x="wallets" p="wallets" /> · {proof.body.purchases} <Ed x="purchases" p="buys" /> · {money(proof.body.spent_usdc ?? 0, 5)}</>
              ) : ok ? (
                proof?.body?.reason ?? "…"
              ) : (
                "…"
              )}
            </span>
            <span className="flow-cap">
              {ok && proof?.body?.available ? (
                <>{proof.body.vw_slippage_bp ?? "…"} bp <Ed x="over the benchmark · overpaid" p="over the going rate · paid too much by" /> {money(proof.body.overpaid_usdc ?? 0, 6)} · <Ed x="replay" p="used again" />{" "}
                  <span className={proof.replay_status === 401 ? "green" : "vermilion"}>{proof.replay_status ?? "…"}</span></>
              ) : (
                <Ed x="TCA across every wallet the person owns; the list is never returned" p="the bill across all their wallets, without listing them" />
              )}
            </span>
          </div>
        </div>
      </div>

      <div className="flow-controls">
        <span className="label"><Ed x="prove as" p="prove as" /></span>
        <button type="button" className={`chip${who === "fleet" ? " chip-gold" : ""}`} onClick={() => setWho("fleet")} aria-pressed={who === "fleet"}>
          <Ed x="the fleet · one person, three wallets" p="the fleet · one person, three wallets" />
        </button>
        <button type="button" className={`chip${who === "solo" ? " chip-gold" : ""}`} onClick={() => setWho("solo")} aria-pressed={who === "solo"}>
          <Ed x="the solo human · one wallet" p="the solo person · one wallet" />
        </button>
        <button type="button" className="chip chip-gold" onClick={prove} disabled={busy} style={{ cursor: busy ? "default" : "pointer" }}>
          {busy ? <span className="dot breathe" aria-hidden /> : null}
          <Ed x="Prove it" p="Prove it" />
        </button>
        {proof && !ok ? <span className="mono vermilion" style={{ fontSize: 12.5 }}>{proof.note ?? proof.body?.detail ?? "refused"}</span> : null}
      </div>

      <div className="section-head" style={{ marginTop: 28 }}>
        <Ed x="This week's people, as the chain records them" p="This week's people, as the chain has them" className="label" />
        <span className="label muted">
          {window != null ? <><Ed x="window" p="week" /> {window}</> : null}
          {endsIn != null ? <> · <Ed x="rolls in" p="resets in" /> {Math.max(0, Math.round(endsIn / 3600))} h</> : null}
          {info?.salt_matches_commitment === true ? <> · <Ed x="salt matches its on-chain commitment" p="the secret matches its public fingerprint" /></> : null}
        </span>
      </div>
      <div className="rings" aria-label="clusters this window">
        {thisWindow.length === 0 && clustersEnv ? (
          <Ed as="p" className="muted" style={{ fontSize: 13 }} x="No person is resolved for this window yet. The 7-day rotation rolled and the resolver has not run; the ops console is red until it does." p="Nobody is on this week's list yet. The week rolled over and the list has not been redone; the ops page shows it in red." />
        ) : null}
        {thisWindow.map((c) => (
          <div key={c.id} className={`ring${c.sandbox ? " sandbox" : ""}${litCluster === c.id.toLowerCase() ? " lit" : ""}`} title={c.id}>
            <span className="ring-dots" aria-label={`${c.wallets.length} wallets`}>
              {c.wallets.map((w) => (
                <span key={w.id} className="ring-dot" title={w.id} />
              ))}
            </span>
            <span className="mono muted" style={{ fontSize: 11.5 }}>{short(c.id)}</span>
            <span className="mono" style={{ fontSize: 11.5 }}>
              {c.wallets.length} <Ed x="wallets" p="wallets" /> · {c.wallets.reduce((a, w) => a + w.settlements, 0)} <Ed x="fills" p="buys" />
              {c.sandbox ? <span className="muted"> · <Ed x="sandbox" p="test" /></span> : null}
            </span>
          </div>
        ))}
      </div>
      {stale.length ? (
        <p className="mono muted" style={{ fontSize: 12, marginTop: 8 }}>
          {stale.length} <Ed x="cluster(s) from earlier windows have expired: a resolution rotates rather than lingers" p="older weekly codes have expired: they rotate instead of lasting" />
        </p>
      ) : null}
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 12.5, marginTop: 8, maxWidth: 68 * 9 }}
        x="Each ring is one verified person this window; each dot a wallet the chain resolves to them. The id is a hash and the wallet list is public tape data; nothing here walks back to a name."
        p="Each ring is one real person this week; each dot is one of their wallets. The code is a hash and nothing leads back to a name."
      />

      <div className="section-head" style={{ marginTop: 28 }}>
        <Ed x="The bound, in people" p="The cost to cheat, counted in people" className="label" />
        <span className="label muted"><Ed x="from ACROracleV2, every hour" p="from the chain, every hour" /></span>
      </div>
      {prints.map((p) => {
        const human = p.human_adjusted_bound ?? null;
        const mult = boundMultiple(human, p.attack_cost_per_bp);
        return (
          <div key={p.index_id} className="meter-row">
            <span className="mono" style={{ fontSize: 12.5 }}>{p.index_id}</span>
            <div style={{ display: "grid", gap: 6 }}>
              <span className="meter" title="wallet-denominated"><i className="fill-wallet" style={{ width: `${Math.max(2, 100 * logFrac(p.attack_cost_per_bp, lo, hi))}%` }} /></span>
              <span className="meter" title="human-denominated"><i className="fill-human" style={{ width: `${human && human > 0 ? Math.max(2, 100 * logFrac(human, lo, hi)) : 0}%` }} /></span>
            </div>
            <span className="mono num" style={{ fontSize: 12.5, textAlign: "right" }}>
              <span className="muted">{money(p.attack_cost_per_bp, 4)}</span>
              <br />
              {human && human > 0 ? <span className="gold">{money(human, 2)}{mult ? ` · ×${Math.round(mult).toLocaleString()}` : ""}</span> : <span className="muted">…</span>}
            </span>
          </div>
        );
      })}
      <div className="flow-controls" style={{ marginTop: 6 }}>
        <span className="chip"><span className="dot" aria-hidden style={{ background: "var(--clay)" }} /> <Ed x="in wallets" p="counted in wallets" /></span>
        <span className="chip chip-gold"><span className="dot" aria-hidden /> <Ed x="in verified people" p="counted in real people" /></span>
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 12.5, marginTop: 8, maxWidth: 68 * 9 }}
        x="The same move, priced two ways on one log scale: USDC to shift the print one basis point through wallets, and through verified people. Sybils are free; people are not. The chain enforces that the second is never below the first."
        p="The same cheat priced through accounts and through real people: fake accounts are free, people are not, so the second bar is never shorter."
      />
    </section>
  );
}
