import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";

import { envelope, refusalHeaders, requestChain } from "@/lib/envelope";
import { readWalk } from "@/lib/floatOnchain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TX = /^0x[0-9a-fA-F]{64}$/;

/* One payment, said in a sentence a non-expert can read.
 *
 * THE MODEL GETS THE FACTS AND RETURNS ONLY WORDS. Every figure this terminal
 * shows is computed and provable, and that rule does not bend for a narrator.
 * So this route reads the payment itself, hands the model the figures, and asks
 * for prose with no numbers in it. The page interpolates the numbers from its
 * own reads, exactly as it does everywhere else. If the model emits a figure
 * anyway, the check below drops the whole answer rather than print a number
 * nobody computed.
 *
 * THE CALLER SUPPLIES A HASH AND NOTHING ELSE. Not the quote, not the fair
 * price, not the verdict: a client that could post its own figures could have
 * the model narrate a payment that never happened. The hash is validated
 * against the exact shape of a transaction hash, as `walk/route.ts` validates
 * the same input, and then the chain is asked.
 *
 * ON DEMAND, ONCE, AND ONLY WHEN A READER ASKS. The surface puts this behind a
 * disclosure a reader has to open, so a page view costs nothing and nobody is
 * billed for prose nobody read.
 *
 * NO KEY MEANS NO SECTION. The refusal is a plain "not configured", and the
 * component renders nothing at all rather than an apology: a fallback is not an
 * answer. The key is read from the environment here, server side, and must
 * never be exposed to a client bundle under any name. */

const SYSTEM = `You explain one stablecoin payment to someone who has never used crypto.

Rules, all of them absolute:
- Two sentences. No more.
- NO NUMBERS, no amounts, no percentages, no addresses, no dates, no hashes. The page prints those itself from the chain.
- No jargon. Never use: VWAP, EIP-712, EIP-3009, x402, sybil, attestation, provenance, settlement-grade, SLO, nanopayment, estimand, tenor.
- No em dashes. Use a full stop and a second sentence instead.
- Plain declarative English. No marketing, no adjectives like "seamless" or "powerful", no praise for the system.
- Describe only what the facts below say happened. If a fact is absent, do not mention it.`;

/** A sentence with a figure in it is not the sentence that was asked for. */
const hasFigure = (s: string) => /\d/.test(s);

export async function POST(req: NextRequest) {
  const chain = requestChain(req);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return NextResponse.json(
      envelope({ status: "pending", reason: "no narrator is configured on this host" }, { live: false, chain }),
      { headers: refusalHeaders() },
    );
  }

  let tx = "";
  try {
    const body: unknown = await req.json();
    tx = typeof (body as { tx?: unknown })?.tx === "string" ? (body as { tx: string }).tx.trim() : "";
  } catch {
    tx = "";
  }
  if (!TX.test(tx)) {
    return NextResponse.json(
      { error: "tx must be a 32 byte transaction hash" },
      { status: 422, headers: refusalHeaders() },
    );
  }

  /* READ IT OURSELVES. The client posted a hash; everything the model is told
     comes from the chain, not from the request. */
  const walk = await readWalk(chain, tx);
  if (walk.status !== "ok") {
    return NextResponse.json(
      envelope({ status: "pending", reason: walk.reason ?? "that payment could not be read" }, { live: false, chain }),
      { headers: refusalHeaders() },
    );
  }

  const facts = [
    `An automated agent asked to buy compute. Its own wallet held nothing before and after.`,
    `The treasury checked the asking price against a benchmark price it read off the chain and recomputed itself.`,
    walk.fair_matches === false
      ? `That recomputation did not match what the receipt recorded.`
      : walk.fair_matches === null
        ? `The benchmark it named could not be found afterwards, so the recomputation is unchecked.`
        : `That recomputation matched what the receipt recorded.`,
    walk.jit_funded
      ? `The treasury was short, so the exact missing amount was taken out of a yield venue where idle money earns, inside the same transaction.`
      : `The treasury had enough ready money, so nothing was taken out of the yield venue.`,
    walk.verdict === "in_order"
      ? `The transaction's own log order proves the money left the yield venue before the seller was paid.`
      : walk.verdict === "out_of_order"
        ? `The transaction's log order does NOT show the money leaving the yield venue before the seller was paid.`
        : walk.verdict === "unproven"
          ? `The transaction claimed the money came from the yield venue, but a log is missing, so the order is unproven. It is not disproven either.`
          : `Nothing was taken from the yield venue, so there is no order to prove.`,
    `The seller was paid and a receipt was written.`,
    walk.human_approved ? `This payment was over the automatic limit, so a person approved it first.` : ``,
    walk.guest ? `The budget spent was a guest budget issued to a verified human.` : ``,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      max_tokens: 1024,
      messages: [{ role: "user", content: `Facts about this one payment:\n\n${facts}` }],
      model: "claude-opus-5-5",
      output_config: { effort: "low" },
      system: SYSTEM,
    });

    const said = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();

    /* The two things that make this printable: it said something, and it said
       it without a number. Either failure drops the answer rather than
       softening it, because the alternative is an unsourced figure on a page
       whose whole claim is that it has none. */
    if (res.stop_reason === "refusal" || said.length === 0 || hasFigure(said)) {
      return NextResponse.json(
        envelope({ status: "pending", reason: "the narrator did not answer in a usable form" }, { live: false, chain }),
        { headers: refusalHeaders() },
      );
    }

    return NextResponse.json(
      envelope({ status: "ok", explanation: said, model: res.model, written_by: "model" }, { live: true, chain }),
      { headers: refusalHeaders() },
    );
  } catch (err) {
    /* Most specific first, and never a string match on the message. An
       unreachable or unauthorised narrator is a missing section, not an outage
       of the treasury, so none of these change what the page says about money. */
    const reason =
      err instanceof Anthropic.AuthenticationError
        ? "the narrator's key was refused"
        : err instanceof Anthropic.RateLimitError
          ? "the narrator is rate limited, so try again shortly"
          : err instanceof Anthropic.APIError
            ? "the narrator did not answer"
            : "the narrator could not be reached";
    return NextResponse.json(envelope({ status: "pending", reason }, { live: false, chain }), {
      headers: refusalHeaders(),
    });
  }
}
