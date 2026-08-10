"use client";

import { Ed } from "@/components/Ed";
import { OperatorConsole } from "@/components/chain/OperatorConsole";
import { useOps } from "@/lib/useLive";
import { useNow } from "@/lib/useNow";
import { ageWords, ageWordsAt } from "@/lib/format";
import type { OpsCheck, OpsLedger, OpsSection } from "@/lib/types";

/* The systems ledger — the operator's page, made public.

   Everything here was previously a 45-minute terminal ritual: `make
   verify-live`, read nine sections of ✓/!/✗, decide. The checker now runs
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

/** The press's own name for each section, in the reader's words.
 *
 *  Keyed on `s.name`, the stable id the page used to throw away. The expert
 *  side has to repeat `s.title` here rather than read it off the payload,
 *  because a lint that cannot see a string cannot check it: coverage.test.ts
 *  reads `x="…"`/`p="…"` props only. The keys are bound to ops.py's SECTIONS
 *  by a test, so a renamed pillar is a failure rather than a silent fallback.
 *
 *  Before this, `{s.title}` rendered raw beside a right-hand label that DID
 *  translate, so half the heading row swapped register and half did not. */
const SECTION_TITLE: Record<string, React.ReactNode> = {
  oracle: <Ed x="The oracle" p="The rate itself" />,
  press: <Ed x="The press" p="The machine that publishes" />,
  cadence: <Ed x="Press cadence" p="Is it publishing on time?" />,
  keeper: <Ed x="The keeper" p="The shopkeeper's rounds" />,
  venue: <Ed x="The venue" p="The trading desk" />,
  tape: <Ed x="The tape" p="Where the numbers come from" />,
  gate: <Ed x="The paid gate" p="The paywall" />,
  hedger: <Ed x="The hedger" p="The robot that trades for us" />,
  funding: <Ed x="Wallet runway" p="Money left in our wallets" />,
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

/** One section's standing, in the same three tiers as the rows beneath it.
 *
 *  The verdict said "1 warning" and then left you to read twenty-three rows
 *  across nine bands to find out which. A head that answers for its own
 *  section makes the page scannable in one pass. */
function tally(checks: OpsCheck[]): { fail: number; warn: number; unread: number } {
  let fail = 0;
  let warn = 0;
  let unread = 0;
  for (const c of checks) {
    if (c.ok === null) unread++;
    else if (!c.ok) {
      if (c.warn) warn++;
      else fail++;
    }
  }
  return { fail, warn, unread };
}

/** The worst thing in a section, which is the only thing its head should say. */
function standing(checks: OpsCheck[]): { cls: string; glyph: string; word: string } {
  const t = tally(checks);
  if (t.fail) return { cls: "chip-breach", glyph: "✗", word: plural(t.fail, "failing") };
  if (t.warn) return { cls: "chip-gold", glyph: "!", word: plural(t.warn, "warning") };
  if (t.unread) return { cls: "chip-sky", glyph: "?", word: plural(t.unread, "unread") };
  return { cls: "chip-teal", glyph: "✓", word: "all clear" };
}

/** The first section carrying a given tier, for the verdict line's jump. */
function firstWith(sections: OpsSection[], tier: "fail" | "warn" | "unread"): string | null {
  return sections.find((s) => tally(s.checks)[tier] > 0)?.name ?? null;
}

/** The three counters, and where each one leads.
 *
 *  Only "warning" is a countable noun. "failing" and "unread" are adjectives
 *  and take no -s, which is why they cannot all go through plural(). */
const COUNTERS: Array<{
  key: "failures" | "warnings" | "unknowns";
  tier: "fail" | "warn" | "unread";
  label: (n: number) => string;
}> = [
  { key: "failures", tier: "fail", label: (n) => `${n} failing` },
  { key: "warnings", tier: "warn", label: (n) => plural(n, "warning") },
  { key: "unknowns", tier: "unread", label: (n) => `${n} unread` },
];

/** Check labels and details are press copy, and the press is outside every
 *  house lint: coverage.test.ts reads only `x=`/`p=` props, so an em dash
 *  written in ops.py lands on the page unchallenged. Two do today. The house
 *  separator is the middot, and it is the same rule whoever typed the string. */
function houseDash(s: string): string {
  return s.replace(/\s+—\s+/g, " · ");
}

export function OpsView() {
  const { ledger, error, refresh } = useOps();
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
  // When the press swept, and when this browser last heard about it. The
  // second was already on the wire (the envelope stamps `fetchedAt`) and the
  // page threw it away, so a reader had no way to tell a fresh page from one
  // sitting behind a poll interval and a CDN window.
  const sweptWords = ageWordsAt(data?.at, nowS);
  const askedWords =
    ledger?.fetchedAt && nowS > 0
      ? ageWords(Math.max(0, nowS - Math.round(ledger.fetchedAt / 1000)))
      : null;

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
                its own timer. These are the same questions the operator used to answer one
                terminal command at a time.
              </>
            }
            p={
              <>
                A plain checklist of whether each part of this site is working right now, from a
                server that checks itself every so often.
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
              x="the checker runs on the press, so there is no verdict while it sleeps. Every other page can fall back to the archived edition; this one deliberately cannot. A stored “all pillars live” would be asserting the health of a service that is not answering. The free-tier press wakes on first visit (~60s) and this page retries by itself."
              p="Our server is waking up, and a saved “all fine” would lie about right now, so we show nothing until it answers."
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
            {/* Two ages, because they are two different facts and only one of
                them used to be here: when the PRESS last swept, and when this
                browser last asked. A 60s poll behind a 30s CDN window means a
                "checked 3 min ago" can itself be 90 seconds old. */}
            <p className="mono muted ops-tally" style={{ fontSize: 12 }}>
              {sweptWords ? <span>checked {sweptWords}</span> : null}
              {askedWords ? <span>asked {askedWords}</span> : null}
              {data.duration_s != null ? <span>{data.duration_s.toFixed(1)}s sweep</span> : null}
              {/* Lead with what WAS checked. Three zeros in a row is a true
                  but joyless way to report a healthy system, and it reads
                  more like "nothing ran" than "nothing is wrong". */}
              <span>{plural(data.sections.reduce((n, s) => n + s.checks.length, 0), "check")}</span>
              {/* `?? 0` printed "0 failing" for a field the press never sent,
                  which is this page's own unread-is-not-zero rule broken in
                  the one line that summarises it. An absent count is dropped,
                  the way `duration_s` above already is. A present one that is
                  non-zero becomes a way to GET there. */}
              {COUNTERS.map(({ key, label, tier }) => {
                const n = data[key];
                if (n == null) return null;
                const target = n > 0 ? firstWith(data.sections, tier) : null;
                return target ? (
                  <a key={key} className="ops-jump" href={`#ops-${target}`}>
                    {label(n)} ↓
                  </a>
                ) : (
                  <span key={key}>{label(n)}</span>
                );
              })}
              <button className="ops-recheck" onClick={() => void refresh()}>
                <Ed x="check again" p="check again" />
              </button>
            </p>
            {/* Name the other checker rather than implying this is the only
                one. They answer different questions and both still matter. */}
            <p className="muted" style={{ fontSize: 13, maxWidth: 68 * 9, marginTop: 10 }}>
              <Ed
                x="This is the press reporting on itself, from inside. The external gate stays a command: make verify-live. It probes the deployed API and the terminal over the public internet, and can catch a route this process cannot see."
                p="This is our server checking itself. We also run a separate check from outside, on a laptop, that can catch problems this one cannot see."
              />
            </p>
          </section>

          {data.sections.map((s) => {
            const st = standing(s.checks);
            // A column for reasons nobody gave is a column of nothing. Five of
            // the nine sections carry no detail at all, and reserving space
            // for it there is what pushed each label away from its own tick.
            const hasDetail = s.checks.some((c) => Boolean(c.detail));
            return (
              /* `s.name` earns its keep twice here: it names the plain-edition
                 title and it is the anchor the verdict line jumps to.
                 .anchor-target already carries the right scroll-margin under
                 the sticky masthead, at both breakpoints. */
              <section
                className="section anchor-target"
                id={`ops-${s.name}`}
                key={s.name}
              >
                <div className="section-head">
                  <span className="label">{SECTION_TITLE[s.name] ?? <>{s.title}</>}</span>
                  <span className="label ops-head-right">
                    {s.checks.length > 0 && (
                      <span className={`chip ${st.cls}`} title={st.word}>
                        <span aria-hidden>{st.glyph}</span> {st.word}
                      </span>
                    )}
                    <span className="muted">
                      {s.checks.length} <Ed x={s.checks.length === 1 ? "check" : "checks"} p="things checked" />
                    </span>
                  </span>
                </div>
                {s.checks.length === 0 ? (
                  <p className="muted awaiting">
                    <Ed x="nothing to report" p="nothing to report" />
                  </p>
                ) : (
                  <div className="table-scroll">
                    {/* sheet-checks, not bare sheet: this is a checklist of
                        prose, and `table.sheet` right-aligns everything after
                        the first cell. See the CSS for what that did. */}
                    <table className="sheet sheet-checks">
                      <caption className="sr-only">{s.title} · checks</caption>
                      {/* Three unlabelled columns read as "✓, oracle configured,
                          no address set" with no clue what the first cell is.
                          `.sheet th` is already styled, so this costs no CSS. */}
                      <thead className="sr-only">
                        <tr>
                          <th scope="col">status</th>
                          <th scope="col">check</th>
                          {hasDetail && <th scope="col">detail</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {s.checks.map((c, i) => {
                          const m = mark(c);
                          return (
                            <tr key={`${s.name}-${i}`}>
                              <td style={{ width: 44 }}>
                                {/* aria-label on a bare <span> is role=generic,
                                    where ARIA prohibits naming — the verdict was
                                    liable to be read as a raw glyph or skipped
                                    entirely. Hide the mark, speak the word. */}
                                <span className={m.cls} title={m.label}>
                                  <span aria-hidden>{m.glyph}</span>
                                  <span className="sr-only">{m.label}</span>
                                </span>
                              </td>
                              {/* Check labels are DATA from the press, set in
                                  mono — so backend vocabulary never has to pass
                                  the plain-edition lint, and never pretends to
                                  be prose written for a reader. */}
                              <td className="mono">{houseDash(c.label)}</td>
                              {hasDetail && (
                                <td className="muted" style={{ fontSize: 12 }}>
                                  {c.detail ? houseDash(c.detail) : ""}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
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
