"use client";

import { useEffect, useRef, useState } from "react";

import { AddressChip } from "@/components/chain/AddressChip";
import { Ed } from "@/components/Ed";
import { ageWordsAt, fmtInt } from "@/lib/format";
import { LOOP_NODES, type LoopNode } from "@/lib/loop";
import { applyReroute, describe } from "@/lib/reroute";
import { bp, followedReroute, type TapeRecentRow, type TcaCard } from "@/lib/tape";
import { useCatalog, useMarketReceipts, useTape } from "@/lib/useLive";
import { useNow } from "@/lib/useNow";
import { WakeNote, type WakeState } from "./Wake";

/* The loop, with a driver's seat.
 *
 * Six stations in the order the data travels: a Circle Gateway payment lands,
 * the mirror records it on Arc, the subgraph indexes it and benchmarks it in the
 * mapping, TCA reads the bill, the reroute decides, and the next payment lands
 * where the decision said. Every station prints a live number from the same
 * routes /tape renders. "Drive it" lights them in order and, at DECIDE, runs the
 * agent's own decision function (lib/reroute.ts, a verbatim port of
 * apps/agent/src/reroute.ts) over the live catalog and this payer's live card —
 * then prints the exact line the agent logs. The slider is the agent's
 * `--reroute-min-bp`; move it past the saving and the decision flips to hold.
 * Nothing here spends; it shows what the agent would do next, and why.
 */

const FLEET_PAYER = "0x674055533B05Ec3fD135fC21c4d91a4A2D3193d3";
const CI_PAYER = "0x784e6d2d4870174ad1aea3d7446f2377d0c6a05d";
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const STEP_MS = 650;

type Picker = "fleet" | "ci" | "busiest" | "custom";

export function LoopFlow({ wake }: { wake: WakeState }) {
  const [picker, setPicker] = useState<Picker>("fleet");
  const [custom, setCustom] = useState("");
  const payer = picker === "fleet" ? FLEET_PAYER : picker === "ci" ? CI_PAYER : picker === "custom" && ADDR.test(custom) ? custom : undefined;
  const { tape } = useTape(payer);
  const { tape: ledger } = useMarketReceipts();
  const catalog = useCatalog();
  const nowS = useNow();

  const data = tape?.data;
  const card = data?.tca && data.tca.available ? (data.tca as TcaCard) : null;
  const recent: TapeRecentRow[] = data?.recent ?? [];
  const meta = data?.meta ?? null;
  const receipts = ledger?.data?.receipts ?? [];
  const newest = receipts[0];
  const verdict = followedReroute(recent, card?.reroute);

  const [minBp, setMinBp] = useState(25);
  const [lit, setLit] = useState<number>(-1);
  const [driving, setDriving] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  function drive() {
    if (driving) return;
    setDriving(true);
    setLit(0);
    let i = 0;
    timer.current = setInterval(() => {
      i += 1;
      if (i >= LOOP_NODES.length) {
        if (timer.current) clearInterval(timer.current);
        setDriving(false);
        return;
      }
      setLit(i);
    }, STEP_MS);
  }

  // The decision, recomputed live as the slider moves — the agent's function, the
  // live catalog, this payer's live card.
  const items = catalog?.data?.items ?? [];
  const targets = items.map((i) => i.resource);
  const decision = card
    ? applyReroute(targets, items, { available: true, reroute: card.reroute }, { minBp }).decision
    : applyReroute(targets, items, { available: false, reason: data?.tca && !data.tca.available ? (data.tca as { reason?: string }).reason ?? "unavailable" : "tape unread" }, { minBp }).decision;

  const on = (n: LoopNode) => (lit >= LOOP_NODES.indexOf(n) ? " lit" : "");

  return (
    <section className="section">
      <div className="section-head">
        <Ed x="The loop you can drive" p="The loop, with you at the wheel" className="label" />
        <span className="label muted">
          <Ed x="live from the tape" p="live from the public record" />
        </span>
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, maxWidth: 68 * 9, marginTop: 0 }}
        x="A payment lands, the mirror records it, the subgraph benchmarks it, TCA reads the bill, the reroute decides, and the next payment goes where the decision said. Six stations, one wallet, every number live."
        p="A payment lands, is recorded, is checked against the going rate, the robot reads its bill, decides, and pays the better shop next."
      />

      <div className="flow-controls">
        <span className="label">
          <Ed x="whose loop" p="which buyer" />
        </span>
        {(
          [
            ["fleet", "the fleet's buyer-1", "the test fleet's wallet"],
            ["ci", "CI's buyer", "the automated buyer"],
            ["busiest", "busiest on the tape", "the busiest buyer"],
            ["custom", "an address", "type one in"],
          ] as [Picker, string, string][]
        ).map(([k, x, p]) => (
          <button key={k} type="button" className={`chip${picker === k ? " chip-gold" : ""}`} onClick={() => setPicker(k)} aria-pressed={picker === k}>
            <Ed x={x} p={p} />
          </button>
        ))}
        {picker === "custom" ? (
          <input className="mono" placeholder="0x…" value={custom} onChange={(e) => setCustom(e.target.value.trim())} aria-label="payer address" style={{ minWidth: 300 }} />
        ) : null}
      </div>

      <div className="flow" role="list" aria-label="the loop">
        <Station node="pay" cls={on("pay")} label={<Ed x="1 · pay" p="1 · pay" />}>
          <span className="flow-value">{receipts.length ? fmtInt(receipts.length) : "…"}</span>
          <span className="flow-cap">
            <Ed x="settlements on the ledger, Circle Gateway" p="tiny payments recorded" />
            {newest?.tier ? (
              <>
                {" · "}
                <Ed x="newest" p="latest" /> <span className={newest.tier === "human" ? "gold" : "green"}>{newest.tier}</span>
              </>
            ) : null}
          </span>
        </Station>
        <Station node="mirror" cls={on("mirror")} label={<Ed x="2 · mirror" p="2 · record" />}>
          <span className="flow-value">{recent[0] ? ageWordsAt(recent[0].settledAt, nowS) ?? "…" : "…"}</span>
          <span className="flow-cap">
            <Ed x="this wallet's newest settlement, on ReceiptMirror" p="this wallet's newest purchase, written to the chain" />
          </span>
        </Station>
        <Station node="index" cls={on("index")} label={<Ed x="3 · index" p="3 · check" />}>
          <span className="flow-value">{meta ? fmtInt(meta.block) : "…"}</span>
          <span className="flow-cap">
            <Ed x="block indexed by The Graph; slippage benchmarked in the mapping" p="the public record is up to this block; every cost checked as it lands" />
          </span>
        </Station>
        <Station node="measure" cls={on("measure")} label={<Ed x="4 · measure" p="4 · the bill" />}>
          <span className="flow-value">{card?.vw_slippage_bp != null ? bp(card.vw_slippage_bp, 1) : "…"}</span>
          <span className="flow-cap">
            {card ? (
              <>
                {card.purchases} <Ed x="purchases · overpaid" p="buys · paid too much by" /> ${card.overpaid_usdc.toFixed(5)}
              </>
            ) : (
              <Ed x="no priced fills for this wallet yet" p="no checked buys for this wallet yet" />
            )}
          </span>
        </Station>
        <Station node="decide" cls={on("decide") + (lit >= 4 ? (decision.kind === "reroute" ? " passed" : " dim") : "")} label={<Ed x="5 · decide" p="5 · decide" />}>
          <span className="flow-value">
            {card?.reroute ? (
              <>
                <AddressChip address={card.reroute.from} copy={false} /> → <AddressChip address={card.reroute.to} copy={false} />
              </>
            ) : (
              "…"
            )}
          </span>
          <span className="flow-cap">
            {card?.reroute ? (
              <>
                {bp(card.reroute.saving_bp, 0)} <Ed x="cheaper on past fills" p="cheaper, going by past buys" />
              </>
            ) : (
              <Ed x="nothing to reroute between" p="nothing to switch between" />
            )}
          </span>
        </Station>
        <Station node="again" cls={on("again") + (lit >= 5 ? (verdict === "followed" ? " passed" : "") : "")} label={<Ed x="6 · pay again" p="6 · pay again" />}>
          <span className="flow-value">
            {verdict === "followed" ? (
              <Ed x="followed" p="switched" />
            ) : verdict === "ignored" ? (
              <Ed x="not yet" p="not yet" />
            ) : verdict === "elsewhere" ? (
              <Ed x="elsewhere" p="elsewhere" />
            ) : (
              "…"
            )}
          </span>
          <span className="flow-cap">
            {verdict === "followed" ? (
              <Ed x="the newest purchase went to the suggested seller" p="the newest buy went to the better shop" />
            ) : (
              <Ed x="read off the wallet's newest purchase, never assumed" p="read from the newest buy, not assumed" />
            )}
          </span>
        </Station>
      </div>

      <div className="flow-controls">
        <button type="button" className="chip chip-gold" onClick={drive} disabled={driving || !card} style={{ cursor: driving ? "default" : "pointer" }}>
          {driving ? <span className="dot breathe" aria-hidden /> : null}
          <Ed x="Drive it" p="Run it" />
        </button>
        <WakeNote wake={wake} />
        {!card && !wake.waking ? (
          <span className="mono muted" style={{ fontSize: 12.5 }}>
            {data?.tca && !data.tca.available ? (
              <Ed x="no priced fills for this wallet yet: pick another, or buy something" p="no checked buys for this wallet yet: pick another" />
            ) : (
              <Ed x="reading the tape…" p="reading the record…" />
            )}
          </span>
        ) : null}
        <label className="mono muted" style={{ fontSize: 12.5, display: "inline-flex", gap: 10, alignItems: "center" }}>
          <Ed x="threshold" p="only switch if it saves" />
          <input type="range" min={0} max={5000} step={25} value={minBp} onChange={(e) => setMinBp(Number(e.target.value))} aria-label="reroute threshold in basis points" />
          <b style={{ color: "var(--sand)" }}>{minBp} bp</b>
        </label>
      </div>

      <div className="flow-log" role="status" aria-live="polite">
        {describe(decision)}
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 12.5, marginTop: 8, maxWidth: 68 * 9 }}
        x="That line is the buyer agent's own log line, from the same function it runs with --reroute before it pays. Slide the threshold past the saving and the decision holds; nothing here spends."
        p="That line is exactly what the buying robot prints before it pays; slide the bar past the saving and it stays put. Nothing spends."
      />
    </section>
  );
}

function Station({ node, cls, label, children }: { node: LoopNode; cls: string; label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flow-station" role="listitem" data-node={node}>
      <div className={`flow-node${cls}`}>
        <span className="label">{label}</span>
        {children}
      </div>
      <span className="flow-arrow" aria-hidden />
    </div>
  );
}
