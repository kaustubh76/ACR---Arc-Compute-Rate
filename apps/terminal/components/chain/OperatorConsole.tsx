"use client";

import { useCallback, useEffect, useState } from "react";
import { Ed } from "@/components/Ed";
import { TxLink } from "./TxLink";

/* The operator desk — the Makefile's money-moving targets, behind a key.

   Hidden until someone proves they hold the key, and absent entirely from any
   deployment that has not set one (the press 404s the route, so the unlock
   simply never succeeds).

   Two rules the UI enforces on top of the ones the press enforces anyway:

   1. **Dry run first, always.** The run button is disabled until a dry run for
      the current form has come back, and any edit to the form invalidates it.
      An operator should never be one mis-click from moving money, and should
      always have seen the amounts, the addresses and the series first.
   2. **The key lives in sessionStorage, never localStorage.** It dies with the
      tab. A bearer token that survives a closed laptop is a different kind of
      object from one that does not. */

const KEY_STORE = "acr-ops-key";

interface Action {
  action: string;
  description: string;
}

interface AuditRow {
  at: number;
  action: string;
  params: Record<string, unknown>;
  dry_run: boolean;
  ok: boolean;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

interface Catalogue {
  actions: Action[];
  caps: Record<string, number>;
  recent: AuditRow[];
}

/** The fields each action takes. Kept here rather than derived so the form can
 *  never offer a parameter the handler ignores. */
const FIELDS: Record<string, Array<{ name: string; label: string; kind: "number" | "text" }>> = {
  "venue/settle": [{ name: "series_id", label: "series", kind: "number" }],
  "venue/collateralize": [
    { name: "series_id", label: "series", kind: "number" },
    { name: "usdc", label: "USDC", kind: "number" },
  ],
  "funding/move": [
    { name: "role", label: "to role (maker|taker)", kind: "text" },
    { name: "usdc", label: "USDC", kind: "number" },
  ],
  "venue/withdraw": [
    { name: "role", label: "from role (maker|taker)", kind: "text" },
    { name: "series_id", label: "series (blank = all)", kind: "number" },
  ],
  "venue/pause": [
    { name: "paused", label: "paused (true|false)", kind: "text" },
    { name: "confirm", label: 'type "pause" to confirm', kind: "text" },
  ],
};

/** Which cap in the catalogue governs which action's USDC field. The press
 *  keys them by the thing being spent, not by the action name. */
const CAP_FOR: Record<string, string> = {
  "venue/collateralize": "collateralize_usdc",
  "funding/move": "fund_usdc",
};

function coerce(raw: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === "") continue;
    if (k === "paused") out[k] = v === "true";
    else if (k === "series_id") out[k] = Number.parseInt(v, 10);
    else if (k === "usdc") out[k] = Number.parseFloat(v);
    else out[k] = v;
  }
  return out;
}

export function OperatorConsole() {
  const [key, setKey] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [cat, setCat] = useState<Catalogue | null>(null);
  const [action, setAction] = useState<string>("");
  const [form, setForm] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem(KEY_STORE);
    if (stored) setKey(stored);
  }, []);

  /* Name the failure precisely. Every non-401 used to read "no operator console
     on this deployment" — including the proxy's 504. During the incident where
     this page earns its keep, "the press is slow" and "there is nothing here"
     are the two conclusions that must never be confused: one says wait, the
     other says go find another way in. */
  const load = useCallback(async (k: string) => {
    let r: Response;
    try {
      r = await fetch("/api/ops/actions", { headers: { "X-ACR-Ops-Token": k } });
    } catch {
      throw new Error("could not reach this site's own server; check your connection");
    }
    if (r.ok) return (await r.json()) as Catalogue;
    if (r.status === 401) throw new Error("that key was not accepted");
    if (r.status === 429)
      throw new Error("too many bad keys were tried recently, so the console is resting");
    if (r.status === 404)
      throw new Error("no operator console on this deployment: no key is configured on the press");
    if (r.status === 504 || r.status === 503)
      throw new Error("the press did not answer in time; it may be waking, so try again shortly");
    throw new Error(`the console answered ${r.status}`);
  }, []);

  // Re-read the catalogue whenever the key changes — it carries the audit
  // trail, so this is also how the log refreshes after a run.
  const refresh = useCallback(
    async (k: string) => {
      try {
        setCat(await load(k));
        setNote(null);
      } catch (e) {
        setCat(null);
        setNote(e instanceof Error ? e.message : "could not reach the console");
      }
    },
    [load],
  );

  useEffect(() => {
    if (key) void refresh(key);
  }, [key, refresh]);

  const unlock = async () => {
    setBusy(true);
    try {
      await load(draft);
      sessionStorage.setItem(KEY_STORE, draft);
      setKey(draft);
      setDraft("");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "could not unlock");
    } finally {
      setBusy(false);
    }
  };

  const lock = () => {
    sessionStorage.removeItem(KEY_STORE);
    setKey("");
    setCat(null);
    setPreview(null);
    setAction("");
    // Also the form and the last message: a stale error from the unlocked
    // session would otherwise render in the locked view, and typed amounts
    // would survive a lock/unlock cycle in memory.
    setForm({});
    setNote(null);
  };

  const run = async (dryRun: boolean) => {
    if (!action) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch("/api/ops/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ACR-Ops-Token": key },
        body: JSON.stringify({ action, params: coerce(form), dry_run: dryRun }),
      });
      const body = await r.json();
      if (!r.ok) {
        setPreview(null);
        setNote(body?.detail ?? body?.error ?? "the action was refused");
        return;
      }
      // A dry run arms the run button; a real run disarms it again, so a
      // second execution always needs a fresh preview.
      setPreview(dryRun ? (body.result ?? {}) : null);
      setNote(dryRun ? null : "done · see the trail below");
      await refresh(key);
    } catch {
      setNote("the console could not be reached");
    } finally {
      setBusy(false);
    }
  };

  const setField = (name: string, v: string) => {
    setForm((f) => ({ ...f, [name]: v }));
    setPreview(null); // any edit invalidates the preview the run button rests on
  };

  if (!key) {
    return (
      <section className="section">
        <div className="section-head">
          <span className="label">
            <Ed x="Operator desk" p="Staff only" />
          </span>
        </div>
        <p className="muted" style={{ maxWidth: 68 * 9 }}>
          <Ed
            x="Settling, rolling, collateral top-ups and treasury transfers live behind a key. Without one configured on the press, this console does not exist at all: the route answers as though it were never built."
            p="The controls that move real money are locked. If nobody has set a key on our server, there is nothing here to unlock."
          />
        </p>
        <p style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            className="mono"
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="operator key"
            aria-label="operator key"
            style={{ minWidth: 260 }}
          />
          <button className="btn" onClick={unlock} disabled={busy || draft.length < 8}>
            <Ed x={busy ? "checking…" : "unlock"} p={busy ? "checking…" : "unlock"} />
          </button>
        </p>
        {note && (
          <p className="muted vermilion" role="alert">
            {note}
          </p>
        )}
      </section>
    );
  }

  const fields = FIELDS[action] ?? [];

  return (
    <section className="section">
      <div className="section-head">
        <span className="label">
          <Ed x="Operator desk" p="Staff controls" />
        </span>
        <span className="label">
          <button className="btn" onClick={lock}>
            <Ed x="lock" p="lock" />
          </button>
        </span>
      </div>

      <p className="muted" style={{ maxWidth: 68 * 9 }}>
        <Ed
          x="Every action prices itself first. The run button stays disabled until a dry run for this exact form has come back, and any edit clears it. The amounts, addresses and series you are about to commit are always ones you have already read."
          p="Every control previews what it would do first, and changing any field makes you preview again."
        />
      </p>

      <p style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <select
          className="mono"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setForm({});
            setPreview(null);
            setNote(null);
          }}
          aria-label="operator action"
        >
          <option value="">choose an action…</option>
          {(cat?.actions ?? []).map((a) => (
            <option key={a.action} value={a.action}>
              {a.action} · {a.description}
            </option>
          ))}
        </select>
        {fields.map((f) => {
          /* The ceiling, where the amount is typed. The catalogue has shipped
             `caps` since the console was built and nothing read it, so an
             operator entered a USDC figure into an unlabelled box and learned
             the limit only from the refusal — directly under a paragraph
             promising they would always have read the amounts first. */
          const cap = f.name === "usdc" ? cat?.caps?.[CAP_FOR[action] ?? ""] : undefined;
          return (
            <span key={f.name} className="ops-field">
              <input
                className="mono"
                value={form[f.name] ?? ""}
                onChange={(e) => setField(f.name, e.target.value)}
                placeholder={f.label}
                aria-label={cap != null ? `${f.label}, at most ${cap}` : f.label}
                style={{ width: f.kind === "number" ? 110 : 200 }}
              />
              {cap != null && <span className="ops-cap">max {cap}</span>}
            </span>
          );
        })}
      </p>

      {action ? (
        <p className="btn-row" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => void run(true)} disabled={busy}>
            <Ed x={busy ? "pricing…" : "dry run"} p={busy ? "checking…" : "preview it"} />
          </button>
          <button
            className="btn btn-adversary"
            onClick={() => void run(false)}
            disabled={busy || !preview}
            title={preview ? undefined : "dry run first"}
          >
            <Ed x={busy ? "running…" : "execute"} p={busy ? "running…" : "do it for real"} />
          </button>
        </p>
      ) : null}

      {preview ? (
        <div className="panel panel-pad" style={{ marginTop: 12 }}>
          <span className="label">
            <Ed x="What this would do" p="What would happen" />
          </span>
          <table className="sheet" style={{ marginTop: 8 }}>
            <tbody>
              {Object.entries(preview).map(([k, v]) => (
                <tr key={k}>
                  <td className="muted mono" style={{ width: 200 }}>
                    {k}
                  </td>
                  <td className="mono">{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {note && (
          <p className="muted vermilion" role="alert">
            {note}
          </p>
        )}

      {/* Every attempt, including the refused ones. A console that recorded
          only what worked would be missing exactly the entries an operator
          goes looking for after something did not. */}
      {cat?.recent?.length ? (
        <div className="table-scroll" style={{ marginTop: 20 }}>
          <table className="sheet">
            <thead>
              <tr>
                <th>
                  <Ed x="When" p="When" />
                </th>
                <th>
                  <Ed x="Action" p="What" />
                </th>
                <th>
                  <Ed x="Mode" p="Real?" />
                </th>
                <th>
                  <Ed x="Outcome" p="Result" />
                </th>
              </tr>
            </thead>
            <tbody>
              {cat.recent.map((row, i) => {
                const tx = row.result?.tx;
                return (
                  <tr key={`${row.at}-${i}`}>
                    <td className="mono">{new Date(row.at * 1000).toISOString().slice(11, 19)}</td>
                    <td className="mono">{row.action}</td>
                    <td>
                      {/* chip-sim is the dashed SIMULATED-DATA mark, and on
                          this same page it also carries "press unreachable".
                          A dry run is neither: it is a read that spent
                          nothing, which is what sky means everywhere else. */}
                      <span className={`chip ${row.dry_run ? "chip-sky" : "chip-gold"}`}>
                        {row.dry_run ? "dry" : "live"}
                      </span>
                    </td>
                    <td className={row.ok ? "" : "vermilion"}>
                      {/* No explorer prop: txUrl's default only applies to
                          `undefined`, so passing "" would build a relative
                          "/tx/0x…" that goes nowhere. */}
                      {typeof tx === "string" ? <TxLink txRef={tx} /> : null}
                      {/* "ok" unconditionally on success. Suppressing it when
                          a tx was present left a successful action saying
                          nothing at all, so of the two success states only
                          one of them said so. */}
                      <span className="mono" style={{ fontSize: 12, marginLeft: tx ? 8 : 0 }}>
                        {row.ok ? "ok" : (row.error ?? "refused")}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
