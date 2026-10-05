"use client";

import { useEffect, useState } from "react";
import { Ed } from "@/components/Ed";
import { fmtPrice, shortAddr } from "@/lib/format";
import type { SpendDecision } from "@/lib/types";

/* Settling one escalation: the control the owner actually uses.

   It posts to the EXISTING /api/ops/actions proxy rather than a new route of its
   own. That proxy already rebuilds the body instead of forwarding it, keeps the
   key in a header and never in a URL, and turns a slow press into a 504 that
   says "waking" rather than "down". Its action allowlist regex already accepts
   `operator/approve`, so the whole discipline comes for free and there is one
   fewer place for a token to leak.

   DRY RUN FIRST FOR APPROVE, same as the operator console: the Approve button
   is dead until a dry run for THIS obligation has come back, and it dies again
   if the reader switches rows. A preview that belongs to a different payment is
   worse than no preview, because it reads like confirmation.

   REJECT IS DELIBERATELY NOT GATED THAT WAY, and this comment used to claim
   otherwise about "the live buttons". Rejecting moves no money: it appends a
   refusal to the record and clears the row. Making a person preview an action
   whose entire effect is "write down that I said no" teaches them to click
   through previews, which is exactly the habit the Approve gate depends on
   them not having.

   The key lives in sessionStorage and dies with the tab. A bearer token that
   survives a closed laptop is a different kind of object.

   WHAT THIS CONTROL CANNOT DO. Approving does not let the agent pay: the press
   calls `spendAsOwner`, which the contract gates on `msg.sender == owner`. The
   amount and the payee come from the decision the agent recorded when it
   stopped, never from this form, so there is no field here that can redirect a
   payment. */

const KEY_STORE = "acr-ops-key";

type Phase = "idle" | "previewing" | "ready" | "running" | "done" | "error";

/** What the dry run described. The press resolves the owner key in BOTH modes
 *  on purpose, so that a missing or foreign key is a refusal here rather than a
 *  reverted transaction later — and having paid for that resolution, the
 *  preview should say which wallet it found. `would` alone was being kept and
 *  the rest discarded, which left the one control that moves real money showing
 *  the least of any surface on the site. */
type Preview = {
  would: string;
  owner?: string;
  custody?: string;
  remaining?: number;
  perTx?: number;
};

export function EscalationActions({
  business,
  decision,
  onSettled,
}: {
  business: string;
  decision: SpendDecision;
  onSettled: () => void;
}) {
  const [key, setKey] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // One unlock per tab, shared with the operator console.
  useEffect(() => {
    try {
      setKey(sessionStorage.getItem(KEY_STORE) ?? "");
    } catch {
      /* private window, blocked storage: the field simply starts empty */
    }
  }, []);

  function remember(k: string) {
    setKey(k);
    setPreview(null);
    setPhase("idle");
    try {
      if (k) sessionStorage.setItem(KEY_STORE, k);
      else sessionStorage.removeItem(KEY_STORE);
    } catch {
      /* nothing to do: the key still works for this render */
    }
  }

  /** What a refusal MEANS, in the owner's terms.
   *
   *  The press answers a missing `ACR_OPS_TOKEN` with the literal string
   *  "not found" — correct for an API that must not reveal whether a console
   *  exists, and useless to the one person entitled to use it. `OperatorConsole`
   *  has translated these for a while; this control showed the raw word. */
  function refusal(status: number, detail: string): string {
    if (status === 404)
      return "no operator console on this deployment: no key is configured on the press";
    if (status === 401) return "that key was not accepted";
    if (status === 429)
      return "too many bad keys were tried recently, so the console is resting";
    if (status === 503 || status === 504)
      return "the press did not answer in time; it may be waking, so try again shortly";
    return detail;
  }

  async function post(action: string, dryRun: boolean) {
    const r = await fetch("/api/ops/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-ACR-Ops-Token": key },
      body: JSON.stringify({
        action,
        // Only the two identifiers. Nothing here names an amount or a payee:
        // the press reads those from its own record of the decision.
        params: {
          business,
          obligation_id: decision.obligation_id,
          ...(action === "operator/reject" && note ? { note } : {}),
        },
        dry_run: dryRun,
      }),
    });
    let body: Record<string, unknown> = {};
    try {
      body = await r.json();
    } catch {
      /* a non-JSON body is still a refusal we can report */
    }
    return { ok: r.ok, status: r.status, body };
  }

  async function dryRun(action: string) {
    setPhase("previewing");
    setMessage(null);
    const { ok, status, body } = await post(action, true);
    if (!ok) {
      setPhase("error");
      setPreview(null);
      setMessage(
        refusal(
          status,
          String(body.detail ?? body.error ?? "the press refused this, with no reason given"),
        ),
      );
      return;
    }
    const result = (body.result ?? {}) as Record<string, unknown>;
    const budget = (result.budget ?? {}) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    setPreview({
      would: String(result.would ?? "no preview came back"),
      owner: typeof result.owner === "string" ? result.owner : undefined,
      custody: typeof result.custody === "string" ? result.custody : undefined,
      remaining: num(budget.remaining_usdc),
      perTx: num(budget.per_tx_limit_usdc),
    });
    setPhase("ready");
  }

  async function live(action: string) {
    setPhase("running");
    const { ok, status, body } = await post(action, false);
    if (!ok) {
      setPhase("error");
      setMessage(
        refusal(status, String(body.detail ?? body.error ?? "the press refused this")),
      );
      return;
    }
    setPhase("done");
    setPreview(null);
    const result = (body.result ?? {}) as Record<string, unknown>;
    setMessage(
      result.tx
        ? `paid ${fmtPrice(Number(result.paid_usdc ?? 0))} USDC · ${String(result.tx).slice(0, 10)}…`
        : "recorded",
    );
    onSettled();
  }

  if (phase === "done") {
    return (
      <span className="chip chip-teal">
        {message ?? <Ed x="settled" p="done" />}
      </span>
    );
  }

  return (
    <div className="escalation-form">
      <label className="label" htmlFor={`k-${decision.obligation_id}`}>
        <Ed x="Operator key" p="Your key" />
      </label>
      <input
        id={`k-${decision.obligation_id}`}
        type="password"
        className="mono"
        autoComplete="off"
        value={key}
        onChange={(e) => remember(e.target.value)}
      />

      <p className="standfirst">
        <Ed
          x="Check first. Approve stays dead until the press has described what it would do. Turning one down moves no money, so it needs no preview."
          p="Check first. Approve stays off until the service says what it would do. Turning one down moves no money."
        />
      </p>

      <div className="segmented" role="group" aria-label="settle">
        <button type="button" disabled={!key || phase === "previewing"}
          onClick={() => dryRun("operator/approve")}>
          <Ed x="Check" p="Check" />
        </button>
        <button type="button" disabled={!preview || phase === "running"}
          onClick={() => live("operator/approve")}>
          <Ed x="Approve" p="Approve" />
        </button>
        <button type="button" disabled={!key || phase === "running"}
          onClick={() => live("operator/reject")}>
          <Ed x="Reject" p="Turn down" />
        </button>
      </div>

      <label className="label" htmlFor={`n-${decision.obligation_id}`}>
        <Ed x="Reason, if rejecting" p="Why, if you turn it down" />
      </label>
      <input
        id={`n-${decision.obligation_id}`}
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />

      {preview ? (
        <>
          <p className="standfirst mono">{preview.would}</p>
          {/* WHO signs, and against what. `spendAsOwner` is gated on
              `msg.sender == owner`, so the wallet named here is the only one
              that can settle this — and whether it is a local key or a Circle
              wallet changes what the owner has to do next. The per-payment
              limit is the rule that put most of these rows in the queue, and
              the owner was never shown the number they were breaking. */}
          {preview.owner ? (
            <p className="label mono">
              <Ed x="signed by" p="paid by" /> {shortAddr(preview.owner)}
              {preview.custody ? ` · ${preview.custody}` : ""}
            </p>
          ) : null}
          {preview.remaining !== undefined || preview.perTx !== undefined ? (
            <p className="label">
              {preview.remaining !== undefined ? (
                <>
                  <Ed x="budget left" p="money left" />{" "}
                  <span className="mono">{fmtPrice(preview.remaining)}</span>
                </>
              ) : null}
              {preview.remaining !== undefined && preview.perTx !== undefined ? " · " : ""}
              {preview.perTx !== undefined ? (
                <>
                  <Ed x="per-payment limit" p="most it may pay at once" />{" "}
                  <span className="mono">{fmtPrice(preview.perTx)}</span>
                </>
              ) : null}
            </p>
          ) : null}
        </>
      ) : null}
      {message ? (
        <p className="standfirst">
          <span className={phase === "error" ? "chip chip-breach" : "chip chip-sky"}>
            {message}
          </span>
        </p>
      ) : null}
    </div>
  );
}
