"use client";

import { Fragment, useMemo, useState } from "react";
import { Ed } from "@/components/Ed";
import { useWebhooks } from "@/lib/useLive";
import { useNow } from "@/lib/useNow";
import type { WebhookEvent } from "@/lib/types";

function verifiedMark(v: boolean | null) {
  if (v === true)
    return (
      <span className="chip chip-teal">
        <Ed x="P-256 ✓" p="signature ✓" />
      </span>
    );
  if (v === false) return <span className="chip chip-breach">bad sig</span>;
  return <span className="chip chip-sim">unverified</span>;
}

function ago(nowS: number, sec: number): string {
  if (nowS <= 0) return "—";
  const d = nowS - sec;
  if (d < 60) return `${Math.max(0, Math.round(d))}s ago`;
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  return `${Math.round(d / 3600)}h ago`;
}

export function WebhookActivity() {
  const { feed, error } = useWebhooks();
  const data = feed?.data;
  const nowS = useNow();
  // The feed is unreachable when the fetch itself fails OR the proxy flags a
  // dead upstream — either way, "no events yet" would be a lie.
  const unreachable = error != null || feed?.upstream === "error" || feed?.upstream === "timeout";
  const events = useMemo(() => (data?.events ?? []).slice().reverse(), [data]);

  const [filter, setFilter] = useState<string>("all");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const types = useMemo(() => {
    const t = new Set<string>();
    events.forEach((e) => t.add(e.type));
    return ["all", ...Array.from(t)];
  }, [events]);

  const verifiedCount = useMemo(() => events.filter((e) => e.verified === true).length, [events]);
  const shown = filter === "all" ? events : events.filter((e) => e.type === filter);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <section className="section">
      <div className="section-head">
        <Ed
          x="Webhook activity — inbound from Circle"
          p="Payment pings — Circle calls us the moment money moves"
          className="label"
        />
        {data && (
          <span className="label">
            {data.received} received ·{" "}
            {data.verify_available ? (
              <span className="green">
                {verifiedCount} <Ed x="P-256 verified" p="signatures checked" />
              </span>
            ) : (
              <span className="muted">verify unavailable</span>
            )}
          </span>
        )}
      </div>

      {events.length ? (
        <>
          {types.length > 2 && (
            <div className="segmented" style={{ marginBottom: 12 }}>
              {types.map((t) => (
                <button key={t} className={t === filter ? "on" : ""} onClick={() => setFilter(t)}>
                  {t === "all" ? "all" : t}
                </button>
              ))}
            </div>
          )}
          <div className="table-scroll">
            <table className="sheet">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Detail</th>
                  <th>Signature</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e: WebhookEvent, i) => {
                  const key = `${e.id}-${i}`;
                  const isOpen = open.has(key);
                  const hasPayload = e.payload && Object.keys(e.payload).length > 0;
                  return (
                    <Fragment key={key}>
                      <tr
                        className={hasPayload ? "row-link" : ""}
                        role={hasPayload ? "button" : undefined}
                        tabIndex={hasPayload ? 0 : undefined}
                        aria-expanded={hasPayload ? isOpen : undefined}
                        onClick={hasPayload ? () => toggle(key) : undefined}
                        onKeyDown={
                          hasPayload
                            ? (e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggle(key);
                                }
                              }
                            : undefined
                        }
                        title={hasPayload ? "inspect payload" : undefined}
                      >
                        <td className="mono" style={{ fontWeight: 600 }}>
                          {hasPayload ? <span className="muted">{isOpen ? "▾ " : "▸ "}</span> : null}
                          {e.type}
                        </td>
                        <td style={{ textAlign: "left" }} className="muted">
                          {e.summary}
                        </td>
                        <td>{verifiedMark(e.verified)}</td>
                        <td className="muted">{ago(nowS, e.received_at)}</td>
                      </tr>
                      {isOpen && hasPayload ? (
                        <tr>
                          <td colSpan={4} style={{ textAlign: "left", padding: 0 }}>
                            <pre className="specimen" style={{ margin: "4px 0", maxHeight: 260, overflow: "auto" }}>
                              {JSON.stringify(e.payload, null, 2)}
                            </pre>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : unreachable ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 8, maxWidth: 68 * 9 }}>
          <span className="chip chip-gold" style={{ marginRight: 8 }}>
            <Ed x="press unreachable" p="server unreachable" />
          </span>
          <Ed
            x="The webhook feed can’t be read right now — retrying automatically; events resume when the press wakes."
            p="The feed can’t be read right now — retrying automatically; pings resume when our server wakes."
          />
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 13, marginTop: 8, maxWidth: 68 * 9 }}>
          <Ed
            x={
              <>
                No events yet — point a Circle <b>Programmable Wallets</b> webhook at{" "}
                <span className="mono">POST /webhooks/circle</span> (expose it:{" "}
                <span className="mono">cloudflared tunnel --url http://127.0.0.1:8000</span>);
                deliveries print here, signature-verified.
              </>
            }
            p={
              <>
                No pings yet — point a Circle webhook at{" "}
                <span className="mono">POST /webhooks/circle</span> (expose it:{" "}
                <span className="mono">cloudflared tunnel --url http://127.0.0.1:8000</span>);
                each one prints here after its signature check.
              </>
            }
          />
        </p>
      )}
    </section>
  );
}
