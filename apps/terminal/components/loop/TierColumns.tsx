"use client";

import { useState } from "react";

import { Ed } from "@/components/Ed";
import { useGate } from "@/lib/useLive";

/* Who is calling — three tiers, three buttons, one route.
 *
 * The same /agent/whoami the developers page probes, drawn as the three
 * columns the rate limit actually has: no card shares the host ceiling (and
 * behind one proxy that ceiling is GLOBAL); a signed card gets a budget per key,
 * and keys are free to mint; a card whose human claim the chain confirms gets a
 * budget per PERSON, shared by every wallet that person owns. Each button runs
 * the real gate and lights its column with what came back. A visitor's card is
 * minted in their own tab with a key that dies with it; the demo human's card is
 * minted on the server from a public label. No key of theirs is ever asked for.
 */

interface Probe {
  status?: number;
  ms?: number;
  tier?: string;
  ident_kind?: string;
  human_note?: string;
  detail?: string;
}

type Tier = "anonymous" | "carded" | "human";

async function probe(extra: Record<string, unknown>): Promise<Probe> {
  try {
    const res = await fetch("/api/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/agent/whoami", ...extra }),
    });
    return (await res.json()) as Probe;
  } catch {
    return { detail: "could not reach the press from here. Press again" };
  }
}

export function TierColumns() {
  const gate = useGate()?.data?.agent ?? null;
  const [out, setOut] = useState<Partial<Record<Tier, Probe>>>({});
  const [busy, setBusy] = useState<Tier | null>(null);

  async function run(tier: Tier) {
    setBusy(tier);
    try {
      let extra: Record<string, unknown> = {};
      if (tier === "carded") {
        const ch = await probe({ path: "/agent/challenge" });
        let audience = "acr-index-api";
        let chainId = 5042002;
        try {
          const j = JSON.parse((ch as { body?: string }).body ?? "{}") as { audience?: string; chain_id?: number };
          audience = j.audience ?? audience;
          chainId = j.chain_id ?? chainId;
        } catch {
          /* defaults */
        }
        const { mintCard, throwawayKey } = await import("@/lib/agentcard");
        const minted = await mintCard({ privateKey: await throwawayKey(), chainId, audience, name: "acr-loop-page", role: "reader" });
        extra = { agent_card: minted.header };
      } else if (tier === "human") {
        extra = { as: "demo-human" };
      }
      const r = await probe(extra);
      setOut((o) => ({ ...o, [tier]: r }));
    } finally {
      setBusy(null);
    }
  }

  const cols: { tier: Tier; head: [string, string]; budget: [string, string]; btn: [string, string]; chip: string }[] = [
    { tier: "anonymous", head: ["anonymous", "no ID card"], budget: ["the host ceiling: one bucket for everyone behind a proxy", "one shared allowance for everyone on the same network"], btn: ["run bare", "run with nothing"], chip: "chip-sim" },
    { tier: "carded", head: ["carded", "signed ID card"], budget: ["a budget per key, and keys are free to mint", "an allowance per card, and cards are free to make"], btn: ["mint a card in this tab", "make a card here"], chip: "chip-teal" },
    { tier: "human", head: ["human", "a real person"], budget: ["a budget per person, shared by every wallet they own", "one allowance per person, however many wallets they have"], btn: ["as a demo human", "as a test person"], chip: "chip-gold" },
  ];

  return (
    <section className="section">
      <div className="section-head">
        <Ed x="Who is calling" p="Who is asking" className="label" />
        {gate ? (
          <span className="label muted">
            {gate.cards_verified} <Ed x="cards verified" p="ID cards checked" /> · {gate.human_tier_granted} <Ed x="reached the human tier" p="traced to a person" />
          </span>
        ) : null}
      </div>
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, maxWidth: 68 * 9, marginTop: 0 }}
        x="One route, three answers. The gate believes the key, not a registry: nobody is enrolled. Only the third tier is scarce, because a person cannot be minted."
        p="One question, three answers. No sign-up: the gate trusts the signature. Only the third kind is rare, because you cannot make a new person."
      />
      <div className="tier-cols">
        {cols.map((c) => {
          const r = out[c.tier];
          const got = r?.tier;
          const lit = Boolean(got);
          return (
            <div key={c.tier} className={`tier-col${lit ? " lit" : ""}`}>
              <span className={`chip ${c.chip}`}>
                <Ed x={c.head[0]} p={c.head[1]} />
              </span>
              <span className="tier-budget">
                <Ed x={c.budget[0]} p={c.budget[1]} />
              </span>
              <button type="button" className="mini-btn" onClick={() => run(c.tier)} disabled={busy != null} aria-busy={busy === c.tier}>
                {busy === c.tier ? "…" : <Ed x={c.btn[0]} p={c.btn[1]} />}
              </button>
              {r ? (
                <div className="mono" style={{ fontSize: 12.5 }}>
                  {got ? (
                    <>
                      <span className={got === "human" ? "gold" : got === "carded" ? "green" : "muted"}>{got}</span>
                      {r.ident_kind ? <span className="muted"> · {r.ident_kind}</span> : null}
                      <span className="muted"> · {r.ms} ms</span>
                      {got === "carded" && c.tier === "human" && r.human_note ? (
                        <div className="muted" style={{ marginTop: 4 }}>
                          <Ed x="claim declined:" p="not confirmed:" /> {r.human_note}
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <span className="vermilion">{r.status ?? ""} {r.detail ?? "no tier in the answer"}</span>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
