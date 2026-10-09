"use client";

import { useState } from "react";
import { Ed } from "@/components/Ed";
import { looksLikeCard, setReaderCard, useReaderCard } from "@/lib/readerCard";
import type { Refusal } from "@/lib/api";

/* The refusal, and the way past it.
 *
 * WHEN THIS IS ON SCREEN AT ALL. Only when the press has actually refused this
 * read — which it does only where `ACR_OPERATOR_READ_SCOPE` is set. With the
 * flag unset, every operator surface answers exactly as it always has and this
 * component never renders, so the default page a reviewer meets is unchanged.
 * That is deliberate: a permanent "sign in" panel on a page whose whole point is
 * that a stranger can audit it would be the additive, panel-shaped chrome this
 * project rejects. This is the existing error state becoming actionable, not a
 * new section.
 *
 * IT PRINTS THE PRESS'S OWN SENTENCE, not a sentence of its own. The gate
 * answers four deliberately different refusals — no card, a card scoped to
 * another business, a card claiming nothing, a correctly scoped card signed by
 * somebody the business never nominated — and the whole value of four sentences
 * is lost if a client paraphrases them into "access denied". So `reason` for the
 * 401 and the 403's `detail` string are rendered verbatim, and the only thing
 * this file adds is the scope to claim and the field to paste into.
 *
 * WHY A FIELD AND NOT A LOGIN. There is no session here and deliberately so: a
 * card is self-minted, signed by a key the business nominated in a commit, and
 * verified by signature rather than by a row in an accounts table. That is what
 * permissionless costs and buys. `scripts/mint_card.py` is the minter; it reads
 * the key from the environment, never argv.
 *
 * AND IT CANNOT BE SIGNED OUT OF. There is no revocation — `docs/AGENT-MODULE.md`
 * records the 15-minute bound AS the revocation window — so "forget" means this
 * tab stops sending the card, not that the card stops working. The copy says
 * that, because implying a logout this system cannot perform would be the one
 * dishonest thing a security control must not do.
 */

/** The sentence the press sent, whatever shape it came in.
 *
 *  The 401 is a challenge object (`reason`, `scope`, `header`, `challenge`) and
 *  the 403s are plain strings, because one is "here is how to get in" and the
 *  others are "your card is wrong, specifically". Read defensively: this is a
 *  body from another service, and a shape that surprises us should degrade to a
 *  readable fallback rather than throw inside a render. */
function words(refusal: Refusal | undefined): { reason: string; scope: string | null } {
  const d = refusal?.detail;
  if (typeof d === "string" && d.trim()) return { reason: d, scope: null };
  if (d && typeof d === "object") {
    const o = d as { reason?: unknown; scope?: unknown };
    return {
      reason: typeof o.reason === "string" ? o.reason : "This business's detail is not public.",
      scope: typeof o.scope === "string" ? o.scope : null,
    };
  }
  return { reason: "This business's detail is not public.", scope: null };
}

export function ReaderCardGate({ refusal }: { refusal: Refusal | undefined }) {
  const current = useReaderCard();
  const [draft, setDraft] = useState("");
  const { reason, scope } = words(refusal);
  // A card is already being sent and was still refused, so the next step is not
  // "paste a card" — it is "that card is not the right one". Naming which of the
  // two situations the reader is in is most of the help here.
  const carded = current.length > 0;
  const bad = draft.trim().length > 0 && !looksLikeCard(draft);

  return (
    <section className="section">
      <div className="panel panel-pad">
        <p className="standfirst">
          <Ed
            x={carded ? "This card does not open this statement." : "This statement is not public."}
            p={carded ? "The card you pasted does not open this page." : "This page is private."}
          />
        </p>

        {/* Verbatim, from the press. */}
        <p className="standfirst">{reason}</p>

        {scope ? (
          <p className="standfirst">
            <Ed x="The scope to claim is " p="The permission to ask for is " />
            <code>{scope}</code>
            {". "}
            <Ed
              x="Mint a card with scripts/mint_card.py and paste it below."
              p="Make one with the mint_card tool and paste it below."
            />
          </p>
        ) : null}

        {/* The same markup as EscalationActions' key field — `.escalation-form`
            wrapper, `label.label`, `input.mono` — because it is the same act on
            the same page and a second form idiom would be a second thing to
            maintain. Its `input` rule is what caps the width at 360px, which is
            also what keeps this usable at 375px. */}
        <div className="escalation-form">
          <label className="label" htmlFor="reader-card">
            <Ed x="agent card" p="your card" />
          </label>
          <input
            id="reader-card"
            type="text"
            className="mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="eyJjYXJkIjp7…"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {bad ? (
          <p className="standfirst">
            <span className="chip chip-breach">
              <Ed x="not a card" p="not a card" />
            </span>{" "}
            <Ed
              x="A card is one line of base64. It is never a curl command and never a private key."
              p="That is not a card. It should be one long line of letters and numbers."
            />
          </p>
        ) : null}

        <div className="segmented">
          <button
            type="button"
            className="btn"
            disabled={!looksLikeCard(draft)}
            onClick={() => {
              setReaderCard(draft.trim());
              setDraft("");
            }}
          >
            <Ed x="present it" p="use this card" />
          </button>
          {carded ? (
            <button type="button" className="btn btn-quiet" onClick={() => setReaderCard("")}>
              <Ed x="forget the card" p="forget my card" />
            </button>
          ) : null}
        </div>

        <p className="standfirst">
          <Ed
            x="A card lives in this tab, expires within fifteen minutes, and cannot spend: no payment path reads one."
            p="The card stays in this tab, stops working within fifteen minutes, and can only read."
          />
        </p>

        {/* Said separately because it is the thing most likely to be assumed
            wrong. There is no revocation by design, so "forget" is not a
            logout: docs/AGENT-MODULE.md records the fifteen-minute bound AS the
            revocation window. */}
        <p className="standfirst">
          <Ed
            x="There is no revocation, so forgetting a card stops this tab sending it and does not stop the card working."
            p="Forgetting a card only stops this tab using it."
          />
        </p>

        <p className="standfirst">
          <Ed
            x="Counts stay public: the traction figures and the business list need no card. This covers one business's decisions, vendors and ledger."
            p="The totals are still public and need no card. This only covers one company's own records."
          />
        </p>
      </div>
    </section>
  );
}

/** The quiet line that says a card is in use, for a page that is working.
 *
 *  Woven into the section head beside the age, not given a panel of its own: a
 *  reader whose card works does not need a control, they need to know that what
 *  they are reading depends on a credential that will expire shortly. */
export function ReaderCardNote() {
  const current = useReaderCard();
  if (!current) return null;
  return (
    <span className="label">
      <Ed x="carded · " p="using your card · " />
      <button type="button" className="section-link" onClick={() => setReaderCard("")}>
        <Ed x="forget" p="forget it" />
      </button>
    </span>
  );
}
