"use client";

import { useEffect, useState } from "react";
import { Ed } from "@/components/Ed";
import { fmtPrice } from "@/lib/format";
import type { SpendDecision } from "@/lib/types";

/* Settling one escalation: the control the owner actually uses.

   It posts to the EXISTING /api/ops/actions proxy rather than a new route of its
   own. That proxy already rebuilds the body instead of forwarding it, keeps the
   key in a header and never in a URL, and turns a slow press into a 504 that
   says "waking" rather than "down". Its action allowlist regex already accepts
   `operator/approve`, so the whole discipline comes for free and there is one
   fewer place for a token to leak.

   DRY RUN FIRST, same as the operator console: the live button is dead until a
   dry run for THIS obligation has come back, and it dies again if the reader
   switches rows. A preview that belongs to a different payment is worse than no
   preview, because it reads like confirmation.

   The key lives in sessionStorage and dies with the tab. A bearer token that
   survives a closed laptop is a different kind of object.

   WHAT THIS CONTROL CANNOT DO. Approving does not let the agent pay: the press
   calls `spendAsOwner`, which the contract gates on `msg.sender == owner`. The
   amount and the payee come from the decision the agent recorded when it
   stopped, never from this form, so there is no field here that can redirect a
   payment. */

const KEY_STORE = "acr-ops-key";

type Phase = "idle" | "previewing" | "ready" | "running" | "done" | "error";

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
  const [preview, setPreview] = useState<string | null>(null);
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
    const { ok, body } = await post(action, true);
    if (!ok) {
      setPhase("error");
      setPreview(null);
      setMessage(
        String(body.detail ?? body.error ?? "the press refused this, with no reason given"),
      );
      return;
    }
    const result = (body.result ?? {}) as Record<string, unknown>;
    setPreview(String(result.would ?? "no preview came back"));
    setPhase("ready");
  }

  async function live(action: string) {
    setPhase("running");
    const { ok, body } = await post(action, false);
    if (!ok) {
      setPhase("error");
      setMessage(String(body.detail ?? body.error ?? "the press refused this"));
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
    <div className="panel-pad">
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
          x="A dry run first. The live buttons stay dead until the press has described what it would do."
          p="Check first. The real buttons stay off until the service says what it would do."
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

      {preview ? <p className="standfirst mono">{preview}</p> : null}
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
