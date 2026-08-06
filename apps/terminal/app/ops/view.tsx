"use client";

import { Ed } from "@/components/Ed";
import { OperatorConsole } from "@/components/chain/OperatorConsole";
import { useOps } from "@/lib/useLive";
import { useNow } from "@/lib/useNow";
import type { OpsCheck, OpsLedger } from "@/lib/types";

/* The systems ledger — the operator's page, made public.

   Everything here was previously a 45-minute terminal ritual: `make
   verify-live`, read ten sections of ✓/!/✗, decide. The checker now runs
   inside the press on its own timer and this renders what it found.

   The house rule about unread-versus-empty is doing the most work on this
   page. A check whose read did not land arrives as `ok: null` and renders as
   its own tier — not as a pass with no number, and not as a failure. And the
   page carries NO archived fallback: a stale verdict is the one kind of stale
   data that is actually a lie, because it asserts the health of a service
   that, right then, is not answering. */

const VERDICT: Record<string, { cls: string; x: string; p: string }> = {
  live: { cls: "chip-teal", x: "all pillars live", p: "everything is running" },
  degraded: { cls: "chip-gold", x: "degraded, not down", p: "running, with some warnings" },
  failed: { cls: "chip-breach", x: "something a visitor would notice", p: "something is broken" },
  // Reached when a section could not be READ, not when nothing has run yet —
  // the not-run-yet case is `status: "pending"` and has its own block below.
  unread: {
    cls: "chip-sky",
    x: "some checks could not be read",
    p: "some things could not be checked",
  },
};

/** One check's mark. `null` gets its own word — "unread", never a tick and
 *  never a cross, because the checker did not learn anything either way. */
function mark(c: OpsCheck): { cls: string; glyph: string; label: string } {
  if (c.ok === null) return { cls: "chip chip-sky", glyph: "?", label: "unread" };
  if (c.ok) return { cls: "chip chip-teal", glyph: "✓", label: "ok" };
  if (c.warn) return { cls: "chip chip-gold", glyph: "!", label: "warning" };
  return { cls: "chip chip-breach", glyph: "✗", label: "failing" };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ageWords(atS: number | undefined, nowS: number): string | null {
  if (!atS || nowS <= 0) return null;
  const s = Math.max(0, nowS - Math.round(atS));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} hr ago`;
}

export function OpsView() {
  const { ledger, error } = useOps();
  const nowS = useNow();
  const live = Boolean(ledger?.live);
  const data: OpsLedger | null = ledger?.data ?? null;
  /* THREE states, not two — this page of all pages has to get it right.
     `ledger === undefined` means SWR has not answered yet: nobody has asked
     the press anything. Folding that into "not live" made a perfectly healthy
     deployment announce "press unreachable · server asleep" to every visitor
     for the length of the first fetch, which is the exact inversion of the
     rule this page preaches. Unread is not down. */
  const asked = ledger !== undefined || Boolean(error);
  const pending =
    !asked || data?.status === "pending" || (live && !data?.sections?.length);
  const unreachable = asked && !live;

  return (
    <>
      <div className="standfirst-block">
        <h1 className="display">
          <Ed x="The systems ledger" p="Is everything working?" />
        </h1>
        <p className="standfirst">
          <Ed
            x={
              <>
                Every pillar&rsquo;s standing, checked inside the press itself and republished on
                its own timer — the same questions the operator used to answer one terminal
                command at a time.
              </>
            }
            p={
              <>
                A plain checklist of whether each part of this site is working right now. Our
                server checks itself every so often and this page shows what it found.
              </>
            }
          />
        </p>
      </div>

      {/* The press is not answering. Say exactly that, and show nothing else —
          there is no honest archived version of "is it working right now". */}
      {unreachable && !pending ? (
        <section className="section">
          <div className="section-head">
            <span className="label">
              <Ed x="No verdict" p="No answer" />
            </span>
            <span className="label">
              <span className="chip chip-sim">
                <Ed x="press unreachable" p="server asleep" />
              </span>
            </span>
          </div>
          <p className="muted" style={{ maxWidth: 68 * 9 }}>
            <Ed
              x="the checker runs on the press, so there is no verdict while it sleeps. Every other page can fall back to the archived edition; this one deliberately cannot — a stored “all pillars live” would be asserting the health of a service that is not answering. The free-tier press wakes on first visit (~60s) and this page retries by itself."
              p="the checker lives on our server, which naps between visits — so there is nothing to report until it wakes (about a minute). We could show you the last answer we saved, but a saved “everything is fine” would be a lie about right now, so we would rather show you nothing. This page retries on its own."
            />
          </p>
        </section>
      ) : null}

      {pending ? (
        <section className="section">
          <div className="section-head">
            <span className="label">
              <Ed x="Reading" p="Checking" />
            </span>
            <span className="label">
              <span className="chip chip-sky">
                <i className="dot breathe" aria-hidden />
                <Ed x="asking the press" p="asking our server" />
              </span>
            </span>
          </div>
          {/* Covers both "we have not asked yet" and "the first sweep is still
              running". Neither state may claim the press is up — we do not know
              that until it answers. */}
          <p className="muted">
            <Ed
              x="asking the press for its verdict. A full sweep reads the venue, the prints and the wallets, so the first one takes a few seconds."
              p="asking our server how everything is doing. The first check takes a few seconds."
            />
          </p>
        </section>
      ) : null}

      {live && data?.sections?.length ? (
        <>
          <section className="section">
            <div className="section-head">
              <span className="label">
                <Ed x="Verdict" p="The short answer" />
              </span>
              <span className="label">
                <span className={`chip ${VERDICT[data.verdict ?? "unread"]?.cls ?? "chip-sky"}`}>
                  <Ed
                    x={VERDICT[data.verdict ?? "unread"]?.x ?? String(data.verdict)}
                    p={VERDICT[data.verdict ?? "unread"]?.p ?? String(data.verdict)}
                  />
                </span>
              </span>
            </div>
            <p className="mono muted" style={{ fontSize: 12 }}>
              {[
                ageWords(data.at, nowS) ? `checked ${ageWords(data.at, nowS)}` : null,
                data.duration_s != null ? `${data.duration_s.toFixed(1)}s sweep` : null,
                // Lead with what WAS checked. Three zeros in a row is a true
                // but joyless way to report a healthy system, and it reads
                // more like "nothing ran" than "nothing is wrong".
                `${data.sections.reduce((n, s) => n + s.checks.length, 0)} checks`,
                `${data.failures ?? 0} failing`,
                plural(data.warnings ?? 0, "warning"),
                `${data.unknowns ?? 0} unread`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {/* Name the other checker rather than implying this is the only
                one. They answer different questions and both still matter. */}
            <p className="muted" style={{ fontSize: 13, maxWidth: 68 * 9, marginTop: 10 }}>
              <Ed
                x="This is the press reporting on itself, from inside. The external gate — which probes the deployed API and the terminal over the public internet, and can catch a route this process cannot see — stays a command: make verify-live."
                p="This is our server checking itself. We also run a separate check from outside, on a laptop, that can catch problems this one cannot see."
              />
            </p>
          </section>

          {data.sections.map((s) => (
            <section className="section" key={s.name}>
              <div className="section-head">
                <span className="label">{s.title}</span>
                <span className="label muted">
                  {s.checks.length} <Ed x="checks" p="things checked" />
                </span>
              </div>
              {s.checks.length === 0 ? (
                <p className="muted awaiting">
                  <Ed x="nothing to report" p="nothing to report" />
                </p>
              ) : (
                <div className="table-scroll">
                  <table className="sheet">
                    <tbody>
                      {s.checks.map((c, i) => {
                        const m = mark(c);
                        return (
                          <tr key={`${s.name}-${i}`}>
                            <td style={{ width: 44 }}>
                              <span className={m.cls} title={m.label} aria-label={m.label}>
                                {m.glyph}
                              </span>
                            </td>
                            {/* Check labels are DATA from the press, set in
                                mono — so backend vocabulary never has to pass
                                the plain-edition lint, and never pretends to
                                be prose written for a reader. */}
                            <td className="mono">{c.label}</td>
                            <td className="muted wrap" style={{ fontSize: 12 }}>
                              {c.detail ?? ""}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}

        </>
      ) : null}

      {/* Outside the live branch on purpose. The console is most wanted
          exactly when the ledger above is failing or unreadable — an operator
          reaching for "settle it" or "top the book up" is not usually looking
          at a page of green ticks. Everything above this line is a read anyone
          may make; everything below needs a key, and on a deployment without
          one configured the press answers as though it were never built. */}
      <OperatorConsole />
    </>
  );
}
