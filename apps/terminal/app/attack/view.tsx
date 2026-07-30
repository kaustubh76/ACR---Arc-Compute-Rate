"use client";

import { useState } from "react";
import { AttackChart } from "@/components/charts/AttackChart";
import { TickerNumber } from "@/components/TickerNumber";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { useAttackRun, useTerminal } from "@/lib/useLive";
import { fmt, fmtInt, money, pct } from "@/lib/format";
import type { Envelope, TerminalData } from "@/lib/types";

const BUDGETS = [2000, 8000, 20000];
const MULTS = [1.5, 2.5, 4.0];

export function AttackView({ initial }: { initial: Envelope<TerminalData> }) {
  const env = useTerminal(initial);
  const { status, refresh } = useAttackRun();
  const [budget, setBudget] = useState(8000);
  const [mult, setMult] = useState(2.5);
  const [seed, setSeed] = useState("");
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);

  const st = status?.data;
  const labLive = status ? status.live : env.live;
  const running = st?.state === "running";
  const done = st?.state === "done" && st.series.length > 0;
  const errored = st?.state === "error";
  // `run` is the narrowed handle for every stage read below — non-null exactly
  // when there is a run worth drawing (no `!` assertions on a polled payload).
  const run = st && (running || done || (errored && st.series.length > 0)) ? st : null;

  async function commence() {
    setStarting(true);
    setStartErr(null);
    try {
      const body: Record<string, number> = { budget_usdc: budget, target_multiplier: mult };
      if (seed.trim() !== "" && Number.isFinite(Number(seed))) body.seed = Number(seed);
      const res = await fetch("/api/attack/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status !== 409) {
        const j = await res.json().catch(() => null);
        setStartErr(j?.detail ?? "the run could not be started");
      }
      await refresh();
    } finally {
      setStarting(false);
    }
  }

  const stageSeries = run ? run.series : env.data.attack.series;

  return (
    <>
      <div className="standfirst-block" style={{ marginTop: 40 }}>
        <Ed
          as="p"
          className="standfirst"
          style={{ margin: 0 }}
          x="Try to move my number — here’s the bill. Fund a wash-flow bot, point it at the tape, and watch what each statistic does with the poison."
          p="Try to move my number — here’s the bill. Give a cheating bot a budget, let it flood the market with fake trades, and watch a plain average fall for it while ACR holds."
        />
      </div>

      <div className="lab">
        <div className="lab-controls">
          <div>
            <div className="label" style={{ marginBottom: 10 }}>
              <Ed x="The adversary — budget" p="The cheat’s budget" />
            </div>
            <div className="lab-presets">
              {BUDGETS.map((b) => (
                <button
                  key={b}
                  className={b === budget ? "on" : ""}
                  onClick={() => setBudget(b)}
                  disabled={running}
                >
                  {money(b, 0)}
                </button>
              ))}
            </div>
          </div>

          <details className="disclosure">
            <summary>
              <Ed x="Adversary parameters" p="Fine-tune the cheat" />
            </summary>
            <div className="disclosure-body" style={{ display: "grid", gap: 14 }}>
              <div>
                <div className="label" style={{ marginBottom: 8 }}>
                  <Ed x="Target multiplier" p="How far above the real price it aims" />
                </div>
                <div className="lab-presets">
                  {MULTS.map((m) => (
                    <button
                      key={m}
                      className={m === mult ? "on" : ""}
                      onClick={() => setMult(m)}
                      disabled={running}
                    >
                      {m.toFixed(1)}×
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="label" style={{ marginBottom: 8 }}>
                  <Ed x="Seed (optional)" p="Dice roll (optional — same seed, same run)" />
                </div>
                <input
                  className="mono"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  disabled={running}
                  placeholder="random"
                  inputMode="numeric"
                  style={{
                    background: "transparent",
                    border: "1px solid var(--rule)",
                    borderRadius: 2,
                    color: "var(--ink)",
                    fontSize: 12,
                    padding: "8px 10px",
                    width: 120,
                  }}
                />
              </div>
            </div>
          </details>

          <button
            className="btn btn-adversary"
            onClick={commence}
            disabled={!labLive || running || starting}
          >
            {running ? (
              "Attack in progress…"
            ) : done ? (
              "Run it again"
            ) : (
              <Ed x="Commence attack" p="Launch the attack" />
            )}
          </button>
          {!labLive && (
            <div className="label">
              <Ed
                x="The lab requires the live index API — run `make api`."
                p="The lab needs our live server — start it with `make api`."
              />
            </div>
          )}
          {startErr && <div className="label vermilion">{startErr}</div>}
          {errored && <div className="label vermilion">The run failed: {st?.error}</div>}

          <Ed
            as="p"
            className="lab-note"
            x="The bot spends its budget on wash prints between sybil identities: self-deals at an inflated target price, reciprocal funding legs to look organic, and a ring of fresh addresses to spread the flow. Naive VWAP averages whatever it is fed. ACR deconvolves the batching, traces the funding graph, and trims what remains."
            p={
              <>
                The bot spends its budget on <Term k="wash-trade">fake trades</Term> between
                accounts it secretly controls: selling to itself at inflated prices, passing the
                same dollars back and forth to look organic, and fanning the flow across fresh
                addresses. A plain average swallows whatever it is fed. ACR{" "}
                <Term k="deconvolution">un-blurs the timing</Term>, maps who funds whom, and
                ignores the extremes.
              </>
            }
          />
        </div>

        <div className="lab-stage">
          {run ? (
            <>
              <div className="lab-counters">
                <div>
                  <div className="counter-value vermilion">
                    <TickerNumber text={money(run.usdc_burned, 0)} />
                  </div>
                  <div className="counter-label label">
                    <Ed x="USDC burned" p="Dollars burned" />
                  </div>
                </div>
                <div>
                  <div className="counter-value">
                    <TickerNumber text={fmtInt(run.n_adversarial)} />
                  </div>
                  <div className="counter-label label">
                    <Ed x="Wash prints" p="Fake trades" />
                  </div>
                </div>
                <div>
                  <div className="counter-value">
                    <TickerNumber text={`${run.hour}/${run.hours_total}`} />
                  </div>
                  <div className="counter-label label">Hour</div>
                </div>
              </div>
              <AttackChart series={run.series} hoursTotal={run.hours_total} />
            </>
          ) : (
            <>
              <div className="label" style={{ marginBottom: 12 }}>
                <Ed x="Previous exercise — bundled" p="A previous run — saved copy" />
              </div>
              <AttackChart series={stageSeries} faded />
            </>
          )}

          {run && done && run.verdict && (
            <div className="section" style={{ marginTop: 40 }}>
              <div className="section-head">
                <span className="label">The verdict</span>
              </div>
              <Ed
                as="p"
                className="verdict"
                style={{ margin: 0 }}
                x={
                  <>
                    VWAP dragged <b className="vermilion">{pct(run.verdict.vwap_swing_pct, 0)}</b>.
                    ACR moved <b className="gold">{pct(run.verdict.acr_swing_pct, 2)}</b>. The
                    attacker burned <b>{money(run.usdc_burned, 0)}</b> across{" "}
                    <b>{fmtInt(run.n_adversarial)}</b> wash prints —{" "}
                    <b>{fmtInt(run.verdict.resistance)}×</b> the resistance.
                  </>
                }
                p={
                  <>
                    The plain average was dragged{" "}
                    <b className="vermilion">{pct(run.verdict.vwap_swing_pct, 0)}</b>. ACR moved
                    just <b className="gold">{pct(run.verdict.acr_swing_pct, 2)}</b>. The cheat
                    burned <b>{money(run.usdc_burned, 0)}</b> on{" "}
                    <b>{fmtInt(run.n_adversarial)}</b> fake trades — ACR held{" "}
                    <b>{fmtInt(run.verdict.resistance)}×</b> firmer.
                  </>
                }
              />
              <div className="table-scroll" style={{ marginTop: 24 }}>
                <table className="sheet">
                  <thead>
                    <tr>
                      <th>
                        <Ed x="Statistic" p="Method" />
                      </th>
                      <th>
                        <Ed x="Peak error (bp)" p="Worst error (bp)" />
                      </th>
                      <th>Swing</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="vermilion">
                        <Ed x="Naive VWAP" p="Plain average" />
                      </td>
                      <td>{fmtInt(run.verdict.peak_vwap_err_bp)}</td>
                      <td>{pct(run.verdict.vwap_swing_pct, 1)}</td>
                    </tr>
                    <tr>
                      <td className="gold">ACR</td>
                      <td>{fmt(run.verdict.peak_acr_err_bp, 1)}</td>
                      <td>{pct(run.verdict.acr_swing_pct, 2)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
