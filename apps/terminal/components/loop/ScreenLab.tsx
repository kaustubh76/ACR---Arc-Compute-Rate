"use client";

import { useState } from "react";

import { Ed } from "@/components/Ed";
import { screenState } from "@/lib/gate";
import { HONEST, INJECTION, TEXT_CAP, type ScreenVerdict } from "@/lib/screen";
import { useGateLive } from "@/lib/useLive";
import { useNow } from "@/lib/useNow";
import { ageWordsAt } from "@/lib/format";
import { RETRY_NOTE, WakeNote, type WakeState } from "./Wake";

/* The screen — Google Cloud Model Armor, with a text box in front of it.
 *
 * A carded tape query travels YOUR TEXT → CARD → MODEL ARMOR → SUBGRAPH →
 * MODEL ARMOR → YOU: the request is screened before it reaches the index and
 * the reply is screened before it reaches the caller. This box sends whatever a
 * visitor types down that exact path (as `variables.note` on the `meta`
 * operation, the only text a caller controls) and lights the station that
 * answered. A 403 names the filter Google fired and never echoes the text. With
 * the card off, the same text goes through unscreened — which is what an
 * anonymous browser reader IS, and the scoping the screen was built with.
 */

interface Result {
  status: number | null;
  verdict: ScreenVerdict;
  matched: string[];
  echoed: boolean;
  ms: number;
  carded: boolean;
  screened_delta: number | null;
  blocked_delta: number | null;
  counts: { screened: number; blocked: number } | null;
  note: string | null;
}

export function ScreenLab({ wake }: { wake: WakeState }) {
  const { gate: gateEnv, refresh } = useGateLive();
  const armor = gateEnv?.data?.armor ?? null;
  const state = screenState(armor);
  const nowS = useNow();
  const lastAge = armor?.last_verdict_at ? ageWordsAt(armor.last_verdict_at, nowS) : null;
  const [text, setText] = useState(INJECTION);
  const [carded, setCarded] = useState(true);
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<Result | null>(null);

  async function screen() {
    setBusy(true);
    try {
      const res = await fetch("/api/screen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, carded }),
      });
      const j = (await res.json()) as Result & { detail?: string };
      if (res.status === 429) {
        setR({ status: 429, verdict: "unavailable", matched: [], echoed: false, ms: 0, carded, screened_delta: null, blocked_delta: null, counts: null, note: j.detail ?? "slow down" });
      } else {
        setR(j);
      }
      void refresh();
    } catch {
      setR({ status: null, verdict: "unavailable", matched: [], echoed: false, ms: 0, carded, screened_delta: null, blocked_delta: null, counts: null, note: RETRY_NOTE.x });
    } finally {
      setBusy(false);
    }
  }

  const v = r?.verdict;
  const armorCls = !r ? "" : !r.carded ? " dim" : v === "blocked" ? " blocked" : v === "passed" || v === "reply_blocked" ? " passed" : "";
  const replyCls = !r ? "" : !r.carded ? " dim" : v === "reply_blocked" ? " blocked" : v === "passed" ? " passed" : "";
  const gotThrough = r && (v === "passed" || v === "unscreened");

  return (
    <section className="section">
      <div className="section-head">
        <Ed x="The screen · Google Cloud Model Armor" p="The message filter · Google Cloud" className="label" />
        <span className={`chip ${state === "live" ? "chip-teal" : state === "off" ? "chip-sim" : "chip-gold"}`}>
          {state === "live" ? <span className="dot breathe" aria-hidden /> : null}
          {state === "live" ? <Ed x="gcp · live" p="Google · live" /> : state === "off" ? <Ed x="switched off" p="off" /> : state === "floor" ? <Ed x="offline floor only" p="basic check only" /> : <Ed x="unread" p="not read yet" />}
        </span>
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, maxWidth: 68 * 9, marginTop: 0 }}
        x="Agent-to-agent traffic is screened in both directions: the request before it reaches the index, the reply before it reaches the caller. Type anything and send it down that path."
        p="Messages between robots are filtered both ways: on the way in and on the way out. Type anything and send it through."
      />

      <div className="flow" role="list" aria-label="the screened path">
        <div className="flow-station" role="listitem">
          <div className={`flow-node${r ? " lit" : ""}`}>
            <span className="label"><Ed x="your text" p="your text" /></span>
            <span className="flow-value">{text.length} <Ed x="chars" p="letters" /></span>
            <span className="flow-cap"><Ed x="sent as the note on a tape query" p="sent as a note on a records request" /></span>
          </div>
          <span className="flow-arrow" aria-hidden />
        </div>
        <div className="flow-station" role="listitem">
          <div className={`flow-node${r ? (r.carded ? " lit" : " dim") : ""}`}>
            <span className="label"><Ed x="card" p="ID card" /></span>
            <span className="flow-value">{carded ? <Ed x="presented" p="shown" /> : <Ed x="none" p="none" />}</span>
            <span className="flow-cap"><Ed x="only carded callers are screened; the card is held on the server" p="only callers with a card get filtered; the card stays on our server" /></span>
          </div>
          <span className="flow-arrow" aria-hidden />
        </div>
        <div className="flow-station" role="listitem">
          <div className={`flow-node gcp${armorCls}`}>
            <span className="label"><Ed x="model armor · request" p="Google filter · in" /></span>
            <span className="flow-value">
              {!r ? "…" : !r.carded ? <Ed x="skipped" p="skipped" /> : v === "blocked" ? <span className="vermilion">403 · {r.matched.join(", ") || "blocked"}</span> : v === "unavailable" ? <span className="gold">503</span> : <span className="green"><Ed x="passed" p="passed" /></span>}
            </span>
            <span className="flow-cap" title={armor?.endpoint ? `${armor.endpoint} · ${armor.template_resource ?? ""}` : undefined}>
              {armor ? (
                <>
                  {armor.backend} · {armor.screened} <Ed x="inspected" p="checked" /> · {armor.blocked} <Ed x="blocked" p="stopped" />
                  {lastAge ? (
                    <>
                      {" · "}
                      <Ed x="Google last answered" p="Google last replied" /> {lastAge}
                      {armor.last_latency_ms != null ? ` · ${armor.last_latency_ms} ms` : ""}
                    </>
                  ) : null}
                </>
              ) : (
                <Ed x="prompt injection and jailbreak filters" p="checks for trick messages" />
              )}
            </span>
          </div>
          <span className="flow-arrow" aria-hidden />
        </div>
        <div className="flow-station" role="listitem">
          <div className={`flow-node${gotThrough ? " lit" : r && r.carded && v === "blocked" ? " dim" : ""}`}>
            <span className="label"><Ed x="subgraph" p="the record" /></span>
            <span className="flow-value">{gotThrough ? <Ed x="answered" p="answered" /> : r && v === "blocked" ? <Ed x="never reached" p="never reached" /> : "…"}</span>
            <span className="flow-cap"><Ed x="the meta operation, on The Graph" p="a harmless status question to the public record" /></span>
          </div>
          <span className="flow-arrow" aria-hidden />
        </div>
        <div className="flow-station" role="listitem">
          <div className={`flow-node gcp${replyCls}`}>
            <span className="label"><Ed x="model armor · reply" p="Google filter · out" /></span>
            <span className="flow-value">{!r || (!gotThrough && v !== "reply_blocked") ? "…" : !r.carded ? <Ed x="skipped" p="skipped" /> : v === "reply_blocked" ? <span className="vermilion">502</span> : <span className="green"><Ed x="passed" p="passed" /></span>}</span>
            <span className="flow-cap"><Ed x="a refused reply is a 502: the caller did nothing wrong" p="a stopped reply is our problem, not yours" /></span>
          </div>
          <span className="flow-arrow" aria-hidden />
        </div>
        <div className="flow-station" role="listitem">
          <div className={`flow-node${r ? (v === "blocked" ? " blocked" : gotThrough ? " passed" : "") : ""}`}>
            <span className="label"><Ed x="you" p="you" /></span>
            <span className="flow-value">{r ? `${r.status ?? "…"} · ${r.ms} ms` : "…"}</span>
            <span className="flow-cap">
              {!r ? <Ed x="what came back" p="what came back" /> : v === "blocked" ? (r.echoed ? <span className="vermilion"><Ed x="the refusal echoed the text" p="the refusal repeated the text" /></span> : <Ed x="refused by name, and the text was not echoed back" p="refused with a reason, and your text was not repeated" />) : v === "unscreened" ? <Ed x="never reached Google: a browser reader behind a proxy is not agent-to-agent traffic" p="never went to Google: a person browsing is not a robot talking to a robot" /> : v === "passed" ? <Ed x="screened twice, answered once" p="checked twice, answered once" /> : r.note ?? <Ed x="no verdict: the screen could not answer, so it refused" p="no verdict: the filter could not answer, so it said no" />}
            </span>
          </div>
        </div>
      </div>

      <div className="flow-controls" style={{ marginTop: 14 }}>
        <textarea value={text} maxLength={TEXT_CAP} onChange={(e) => setText(e.target.value)} aria-label="text to screen" />
      </div>
      <div className="flow-controls">
        <button type="button" className="chip" onClick={() => setText(HONEST)}><Ed x="an honest note" p="a normal note" /></button>
        <button type="button" className="chip chip-breach" onClick={() => setText(INJECTION)}><Ed x="the demo's prompt injection" p="a trick message" /></button>
        <label className="mono muted" style={{ fontSize: 12.5, display: "inline-flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={carded} onChange={(e) => setCarded(e.target.checked)} />
          <Ed x="present a card" p="show an ID card" />
        </label>
        <button type="button" className="chip chip-gold" onClick={screen} disabled={busy || !text.trim()} style={{ cursor: busy ? "default" : "pointer" }}>
          {busy ? <span className="dot breathe" aria-hidden /> : null}
          <Ed x="Screen it" p="Send it" />
        </button>
        <WakeNote wake={wake} />
        {r?.screened_delta != null ? (
          <span className="mono muted" style={{ fontSize: 12.5 }}>
            <Ed x="inspections" p="checks" /> +{r.screened_delta} · <Ed x="blocked" p="stopped" /> +{r.blocked_delta ?? 0} · <Ed x="since this boot" p="since the last restart" /> {r.counts ? `${r.counts.screened}/${r.counts.blocked}` : ""}
          </span>
        ) : r && r.status === 200 ? (
          <span className="mono muted" style={{ fontSize: 12.5 }}>
            <Ed x="counters unread this time; the card decided the verdict" p="the counts could not be read this time; the ID card decided" />
          </span>
        ) : null}
        {r?.status === 429 && r.note ? <span className="mono gold" style={{ fontSize: 12.5 }}>{r.note}</span> : null}
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 12.5, marginTop: 8, maxWidth: 68 * 9 }}
        x="One card is held on the server for every visitor, so the lab shares one budget at the gate. The counters are the gate's own, read before and after your send."
        p="One ID card is kept on our server for everyone, so the lab shares one allowance. The counts are the gate's own, read before and after."
      />
      {armor?.endpoint ? (
        <p className="mono muted" style={{ fontSize: 12, marginTop: 6, overflowWrap: "anywhere" }}>
          <Ed x="every call goes to" p="every check goes to" /> {armor.endpoint}
          {armor.template_resource ? <> · {armor.template_resource}</> : null}
          {armor.console_url ? (
            <>
              {" · "}
              <a className="tx-link" href={armor.console_url} target="_blank" rel="noreferrer">
                <Ed x="the project's console" p="Google's own dashboard" /> <span className="ext">↗</span>
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}
