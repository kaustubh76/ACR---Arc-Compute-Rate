"use client";

import { Ed } from "@/components/Ed";
import type { FloatWalkStep } from "@/lib/float";
import { fmtInt, fmtPrice } from "@/lib/format";
import { useFloatWalk } from "@/lib/useLive";

/* One payment, proving itself from its own transaction.

   WHY LOG ORDER IS THE PROOF. Arc's RPC serves no `debug_traceTransaction`, so
   there is no call trace to appeal to. What a just-in-time payment claims is an
   ORDER, and the position of two logs inside one receipt is the only witness to
   it. That also makes it checkable by anyone with an ordinary node rather than
   an archive one, which is the better property.

   THE SAME VOCABULARY AS THE LADDER, deliberately. These four steps are a
   sequence of checks and where it stopped, which is what `.flow-rungs` was
   built to draw. One visual language for one idea costs nothing and means a
   reader who has already driven the ladder knows how to read this. */

/** The rung state for a step. `warn` dims rather than reddens: a payment the
 *  buffer covered has nothing to prove at step two, and that is not a fault. */
function rung(state: FloatWalkStep["state"]): string {
  if (state === "ok") return "passed";
  if (state === "bad") return "blocked";
  return "dim";
}

function Title({ n }: { n: number }) {
  if (n === 1) return <Ed x="the price was read" p="the price was checked" />;
  if (n === 2) return <Ed x="the shortfall left the yield vault" p="the money came out of savings" />;
  if (n === 3) return <Ed x="the seller was paid" p="the shop was paid" />;
  return <Ed x="the receipt was written" p="the receipt was written" />;
}

export function Walk({ tx }: { tx: string }) {
  const { walk, reading } = useFloatWalk(tx);
  const d = walk?.data ?? null;

  if (!d || reading) {
    return (
      <p className="muted awaiting">
        <Ed x="reading this payment back out of its own transaction." p="reading this payment back from the chain." />
      </p>
    );
  }
  if (d.status !== "ok") {
    return (
      <p className="label mono">
        {d.reason ?? ""}
      </p>
    );
  }

  const steps = d.steps ?? [];

  return (
    <>
      <div aria-label="the four steps of one payment" className="flow flow-rungs" role="list">
        {steps.map((s) => (
          <div className="flow-station" data-node={`step-${s.n}`} key={s.n} role="listitem">
            <div className={`flow-node ${rung(s.state)}`}>
              <div className="rung">
                <span className="rung-no">{s.n}</span>
                <span className="label">
                  <Title n={s.n} />
                </span>
                <span className="rung-said">
                  {s.n === 1 ? (
                    d.fair_matches === null ? (
                      <Ed x="that print is no longer the newest, so it is not shown" p="that rate is not the latest, so it is not shown" />
                    ) : d.fair_matches ? (
                      <Ed x="the vault's own total matches the print it named" p="the price matches the rate it named" />
                    ) : (
                      <Ed x="the print does not reproduce the recorded total" p="the rate does not match the recorded total" />
                    )
                  ) : s.log_index === undefined ? (
                    s.n === 2 ? (
                      d.jit_funded ? (
                        <Ed x="it claims just in time, but there is no pull here" p="it says it came from savings, but nothing shows that" />
                      ) : (
                        <Ed x="the buffer covered it, so the sleeve was not touched" p="there was enough ready, so savings were not touched" />
                      )
                    ) : (
                      <Ed x="not found in this transaction" p="not found in this payment" />
                    )
                  ) : (
                    <>
                      <Ed x="log" p="line" /> <span className="num">{fmtInt(s.log_index)}</span>
                      {s.value_usdc === undefined ? null : (
                        <>
                          {" · "}
                          <span className="num">{fmtPrice(s.value_usdc)}</span>
                        </>
                      )}
                      {s.requested_usdc !== undefined && s.requested_usdc !== s.value_usdc ? (
                        <>
                          {" · "}
                          <Ed x="asked for" p="asked for" />{" "}
                          <span className="num">{fmtPrice(s.requested_usdc)}</span>
                        </>
                      ) : null}
                    </>
                  )}
                </span>
              </div>
            </div>
            <span aria-hidden className="flow-arrow" />
          </div>
        ))}
      </div>

      <div aria-live="polite" className="flow-log" role="status">
        {d.verdict === "in_order" ? (
          <Ed
            x="the sleeve was pulled before the seller was paid, in one transaction. The pull came first."
            p="the money came out of savings before the shop was paid, in one go."
          />
        ) : d.verdict === "out_of_order" ? (
          <Ed
            x="OUT OF ORDER. The seller was paid before the sleeve was pulled, so this was not funded just in time."
            p="out of order: the shop was paid before the money came out of savings."
          />
        ) : d.verdict === "unproven" ? (
          <Ed
            x="CANNOT CONFIRM. This payment claims to be just in time, but a log it would need is missing."
            p="cannot confirm: this payment says it came from savings, but a record is missing."
          />
        ) : (
          <Ed
            x="this payment was not funded just in time, so there is no pull then pay order to show."
            p="this one did not come from savings, so there is no order to show."
          />
        )}
      </div>

      {/* The step that cannot have a log, and why that is the stronger proof. */}
      <Ed
        as="p"
        className="muted"
        style={{ fontSize: "var(--t-3)", marginTop: "var(--s-3)", maxWidth: "var(--measure)" }}
        x="Step one has no log, because a staticcall emits nothing. The receipt names the print it was checked against, so the payment commits to its own price."
        p="Step one leaves no record, because looking up a price does not. What is stronger: the receipt names the exact rate it used."
      />
    </>
  );
}
