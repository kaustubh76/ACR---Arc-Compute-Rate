"use client";

import { useState } from "react";
import { AttackChart } from "@/components/charts/AttackChart";
import { AttackTape } from "@/components/chain/AttackTape";
import { TickerNumber } from "@/components/TickerNumber";
import { Ed } from "@/components/Ed";
import { Term } from "@/components/Term";
import { useAttackRun } from "@/lib/useLive";
import { useConnection } from "@/lib/useConnection";
import { fmt, fmtInt, money, pct } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { useEdition } from "@/lib/useEdition";
import type { Envelope, TerminalData } from "@/lib/types";

const BUDGETS = [2000, 8000, 20000];
const MULTS = [1.5, 2.5, 4.0];

export function AttackView({ initial }: { initial: Envelope<TerminalData> }) {
  // The ladder, not just the envelope: the cold-press copy below needs the wake
  // countdown. Safe to call here because this page HAS a server-rendered
  // initial envelope — useConnection without one returns undefined during SSR.
  const conn = useConnection(initial);
  const nowS = useNow();
  const plain = useEdition() === "plain";
  const env = conn.env;
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

  /* What the counters read when nothing is running. The archived exercise is
     fetched on every page load and was never rendered; resting on it beats
     showing three empty slots, and it keeps the row's shape stable when a run
     starts. */
  const archived = env.data.attack;
  const shown = run
    ? {
        usdc_burned: run.usdc_burned,
        usdc_total: run.usdc_total ?? null,
        n_adversarial: run.n_adversarial,
        n_adversarial_total: run.n_adversarial_total ?? null,
        hour: run.hour,
        hours_total: run.hours_total,
      }
    : {
        usdc_burned: archived.usdc_burned,
        usdc_total: null,
        n_adversarial: archived.n_adversarial,
        n_adversarial_total: null,
        hour: archived.series.length,
        hours_total: archived.series.length,
      };

  // Ticks during the run — `verdict` is now recomputed every step server-side.
  const resistance = run?.verdict?.resistance ?? null;

  /* Provenance for every figure above: when they last moved, and what moved
     them. A live run names its seed so the reader can reproduce it — the seed
     is generated server-side when the box is left blank, so without this the
     run they just watched was unrepeatable. */
  const lastMoved = (() => {
    if (run?.params) {
      const age = run.started_at && nowS > 0 ? Math.max(0, nowS - Math.round(run.started_at)) : null;
      const when = age == null ? "" : age < 90 ? " · just now" : ` · ${Math.round(age / 60)} min ago`;
      const el = run.elapsed_s != null ? ` · ${run.elapsed_s.toFixed(0)}s of work` : "";
      return `run ${run.params.seed} · budget ${money(run.params.budget_usdc, 0)} · ×${run.params.target_multiplier}${el}${when}`;
    }
    return plain
      ? "a run we recorded earlier · press the button for a fresh one"
      : "the archived exercise · commence a run for live figures";
  })();

  /* Why the budget preset does not change the outcome. `generate_wash_flow`
     takes min(trade cap, budget / fee), and at a 0.0041 fee every budget on
     offer affords millions of trades — so the 12,000 cap always binds and all
     three presets produce an identical run. Saying so turns a control that
     looks broken into one that explains the model. */
  const capNote = run?.trade_cap && run.budget_affords
    ? `${money(run.params?.budget_usdc ?? budget, 0)} offered · buys ${fmtInt(run.budget_affords)} wash trades · capped at ${fmtInt(run.trade_cap)} per service`
    : null;

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
          x="Try to move my number. Here’s the bill. Fund a wash bot and watch each statistic eat the poison."
          p="Try to move my number. Here’s the bill. Give a cheating bot a budget and watch who bends."
        />
      </div>

      <div className="lab">
        <div className="lab-controls">
          <div>
            <div className="label" style={{ marginBottom: 10 }}>
              <Ed x="The adversary · budget" p="The cheat’s budget" />
            </div>
            {/* Selection was border+text colour only, at 12px, in --breach —
                which a red-green deficiency will not resolve, on the control
                that arms the headline demo. aria-pressed says it outright.
                type="button" because the default is submit. */}
            <div className="lab-presets" role="group" aria-label="adversary budget">
              {BUDGETS.map((b) => (
                <button
                  key={b}
                  type="button"
                  className={b === budget ? "on" : ""}
                  aria-pressed={b === budget}
                  onClick={() => setBudget(b)}
                  disabled={running}
                >
                  {money(b, 0)}
                </button>
              ))}
            </div>
            {/* The knob is honest about being blunt: the attacker's spend is
                bounded by a per-service trade cap long before the budget runs
                out, so every preset buys the same attack. Better to say that
                than to let a reader change it, see no difference, and wonder
                what else on this page is decorative. */}
            <p className="mono muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.5 }}>
              {capNote ?? (
                <Ed
                  x="the trade cap binds before the budget does. Every preset buys the same attack"
                  p="the cheat runs out of allowed trades long before it runs out of money, so all three budgets buy the same attack"
                />
              )}
            </p>
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
                <div className="lab-presets" role="group" aria-label="target multiplier">
                  {MULTS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={m === mult ? "on" : ""}
                      aria-pressed={m === mult}
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
                  <Ed x="Seed (optional)" p="Dice roll (optional: same seed, same run)" />
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
            {/* `starting` used to drive `disabled` and nothing else, so the
                headline button greyed out and said the same words for up to
                25 seconds — and the 25s budget exists precisely for the cold
                press, i.e. the case where the silence is longest. */}
            {starting ? (
              <Ed x="Commencing…" p="Starting…" />
            ) : running && st?.phase === "simulating" ? (
              /* The blocking tape build, which runs BEFORE hour 0 and can take
                 tens of seconds on a free-tier box with the hour counter stuck
                 at zero. It was the longest silence on the site and looked
                 exactly like a hang. */
              <Ed x="Building the tape…" p="Making the fake trades…" />
            ) : running ? (
              <Ed x="Attack in progress…" p="Attack under way…" />
            ) : done ? (
              <Ed x="Run it again" p="Run it again" />
            ) : (
              <Ed x="Commence attack" p="Launch the attack" />
            )}
          </button>
          {/* A public visitor cannot "run make api". Say what is actually
              happening and how long it takes, using the ladder's own estimate. */}
          {!labLive && (
            <div className="label">
              <span className="chip chip-gold">
                <i className="dot breathe" aria-hidden />
                {conn.state === "waking" && conn.wakeRemainingS != null ? (
                  <Ed
                    x={`waking the press · ~${conn.wakeRemainingS}s`}
                    p={`waking our server · about ${conn.wakeRemainingS}s`}
                  />
                ) : (
                  <Ed x="the press is not answering" p="our server is not answering" />
                )}
              </span>
              <Ed
                as="p"
                className="muted"
                style={{ marginTop: 8, maxWidth: 68 * 9 }}
                x="The lab runs on the live press, which sleeps between visits on the free tier. Keep this page open: it retries by itself and the button arms as soon as the press answers. The chart below is the recorded run in the meantime."
                p="Our server naps between visits and wakes on its own, so keep this page open; the chart below is a run we recorded earlier, not live."
              />
            </div>
          )}
          {/* The page only ever showed a chip when it was BROKEN. Saying so
              when it is fine is what makes the broken case believable — and
              the age proves the poll is alive rather than merely configured. */}
          {labLive && (
            <div className="label">
              <span className="chip chip-teal">
                <i className="dot breathe" aria-hidden />
                <Ed x="press live" p="server awake" />
                {status && nowS > 0 ? (
                  <> · {Math.max(0, nowS - Math.floor(status.fetchedAt / 1000))}s ago</>
                ) : null}
              </span>
            </div>
          )}
          {startErr && (
            <div className="label vermilion" role="alert">
              {startErr}
            </div>
          )}
          {errored && <div className="label vermilion">The run failed: {st?.error}</div>}

          <Ed
            as="p"
            className="lab-note"
            x="The bot buys wash prints between sybil identities; VWAP swallows them. ACR deconvolves, traces funding, and trims."
            p={
              <>
                The bot floods the market with <Term k="wash-trade">fake trades</Term> between its
                own accounts. A plain average swallows them; ACR traces who funds whom and trims.
              </>
            }
          />
        </div>

        <div className="lab-stage">
          {/* The counters REST rather than vanish. They used to live inside
              the `run ?` branch, so before the first click this page showed a
              faded chart and not one number — which is most of why it read as
              a picture rather than an instrument. Idle, they carry the
              archived exercise's figures and say so. */}
          <div className="lab-counters">
            <div>
              <div className="counter-value vermilion">
                <TickerNumber text={money(shown.usdc_burned, 0)} />
              </div>
              <div className="counter-label label">
                <Ed x="USDC burned" p="Dollars burned" />
                {shown.usdc_total ? (
                  <span className="muted"> / {money(shown.usdc_total, 0)}</span>
                ) : null}
              </div>
            </div>
            <div>
              <div className="counter-value">
                <TickerNumber text={fmtInt(shown.n_adversarial)} />
              </div>
              <div className="counter-label label">
                <Ed x="Wash prints" p="Fake trades" />
                {shown.n_adversarial_total ? (
                  <span className="muted"> / {fmtInt(shown.n_adversarial_total)}</span>
                ) : null}
              </div>
            </div>
            <div>
              <div className="counter-value">
                <TickerNumber text={`${shown.hour}/${shown.hours_total}`} />
              </div>
              <div className="counter-label label">
                <Ed x="Hour" p="Hour" />
              </div>
            </div>
            <div>
              <div className={`counter-value ${resistance != null ? "gold" : "muted"}`}>
                <TickerNumber text={resistance != null ? `${fmtInt(resistance)}×` : "…"} />
              </div>
              <div className="counter-label label">
                {/* Ticks as the run goes now — the verdict is a pure function
                    of the series, so withholding it until the end was a
                    choice, not a constraint. */}
                <Ed x="Resistance vs VWAP" p="Harder to fake than a plain average" />
              </div>
            </div>
          </div>

          {/* When these figures last actually moved, and what moved them. A
              number with no provenance is indistinguishable from a decoration. */}
          <p className="mono muted" style={{ fontSize: 12, marginTop: -12, marginBottom: 20 }}>
            {lastMoved}
          </p>

          {run ? (
            <AttackChart series={run.series} hoursTotal={run.hours_total} />
          ) : (
            <>
              <div className="label" style={{ marginBottom: 12 }}>
                <Ed x="Previous exercise · bundled" p="A previous run · saved copy" />
              </div>
              <AttackChart series={stageSeries} faded />
            </>
          )}

          {/* The estimator's work, hour by hour. */}
          <div style={{ marginTop: 28 }}>
            <AttackTape
              series={run ? run.series : stageSeries}
              live={Boolean(run)}
              hoursTotal={run ? run.hours_total : stageSeries.length}
            />
          </div>

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
                    VWAP dragged <b className="vermilion">{pct(run.verdict.vwap_swing_pct, 0)}</b>;
                    ACR moved <b className="gold">{pct(run.verdict.acr_swing_pct, 2)}</b>. That cost{" "}
                    <b>{money(run.usdc_burned, 0)}</b> across{" "}
                    <b>{fmtInt(run.n_adversarial)}</b> wash prints,{" "}
                    <b>{fmtInt(run.verdict.resistance)}×</b> the resistance.
                  </>
                }
                p={
                  <>
                    The plain average bent{" "}
                    <b className="vermilion">{pct(run.verdict.vwap_swing_pct, 0)}</b>; ACR moved{" "}
                    <b className="gold">{pct(run.verdict.acr_swing_pct, 2)}</b>. That took{" "}
                    <b>{money(run.usdc_burned, 0)}</b> on <b>{fmtInt(run.n_adversarial)}</b> fake
                    trades, and ACR held <b>{fmtInt(run.verdict.resistance)}×</b> firmer.
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
