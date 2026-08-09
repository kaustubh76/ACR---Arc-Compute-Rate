import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PRESETS,
  UNIT_FACTORS,
  compactMoney,
  deltaBp,
  monthlyCost,
  parseWorkload,
  totalCost,
} from "./workload";
import {
  EDITION_ATTR,
  EDITION_KEY,
  EDITION_PARAM,
  editionBootScript,
  parseEdition,
  resolveEdition,
} from "./edition";

test("parseEdition accepts only the two editions", () => {
  assert.equal(parseEdition("plain"), "plain");
  assert.equal(parseEdition("expert"), "expert");
  assert.equal(parseEdition("PLAIN"), null);
  assert.equal(parseEdition(""), null);
  assert.equal(parseEdition(undefined), null);
  assert.equal(parseEdition(42), null);

  /* The reader's OTHER persisted preference, held to the same standard and
     asserted here rather than in a new test() for the reason chain.test.ts
     states: `npm test` reports `# pass N`, verify_claims measures it, and 95
     is stated in six docs plus a twelve-suite list.

     The workload's failure mode is worse than the edition's. A bad edition
     string falls back to expert and costs nothing; a bad unit factor bills
     every reader ×1000 wrong under a live number that makes it look checked.
     So: the parse must reject garbage to null (never NaN billing), the factors
     must match the unit strings the press actually publishes, and the whole
     pipeline must reproduce a hand-computed bill from the committed bundle. */

  // Parse: defensive to null, never a half-profile.
  const good = parseWorkload(JSON.stringify({ inf: 12, gpu: 40, data: 5 }));
  assert.deepEqual(good, { inf: 12, gpu: 40, data: 5 });
  assert.equal(parseWorkload("not json"), null);
  assert.equal(parseWorkload(JSON.stringify({ inf: -1, gpu: 0, data: 0 })), null, "negatives are not a workload");
  assert.equal(parseWorkload(JSON.stringify({ inf: 0, gpu: 0, data: 0 })), null, "buying nothing IS no profile");
  assert.equal(parseWorkload(JSON.stringify({ inf: NaN })), null);
  assert.equal(parseWorkload(JSON.stringify("a string")), null);
  assert.equal(parseWorkload(null), null);
  // A field of the wrong type degrades to 0, the rest survives.
  assert.deepEqual(parseWorkload(JSON.stringify({ inf: "12", gpu: 40, data: 5 })), { inf: 0, gpu: 40, data: 5 });

  // Factors vs the units the press publishes, from the committed bundle. A
  // press-side unit change (say $/1M tokens) must fail HERE, not mis-bill.
  const bundle = JSON.parse(readFileSync(join(__dirname, "fallback.json"), "utf8"));
  const expectUnit: Record<string, string> = {
    "ACR-INF": "$/1k tokens", // ×1000: 1M tokens = 1000 of these
    "ACR-GPU": "$/GPU-sec", //   ×3600: a GPU-hour
    "ACR-DATA": "$/MB", //       ×1000: a GB, decimal, as sold
  };
  for (const [id, unit] of Object.entries(expectUnit)) {
    assert.equal(bundle.prints[id].unit, unit, `${id} no longer prints in ${unit}; UNIT_FACTORS is now wrong`);
  }
  // And the factors themselves, pinned to those exact unit strings. First
  // draft only asserted `> 0`, and a deliberately broken 3600→60 sailed
  // through — a gate that cannot fail is not a gate.
  assert.deepEqual(
    UNIT_FACTORS,
    { "ACR-INF": 1000, "ACR-GPU": 3600, "ACR-DATA": 1000 },
    "a unit factor drifted from the unit strings asserted above",
  );

  // The pipeline end to end against the bundle's own on-chain ACR-INF mark:
  // 12M tokens × 1000 × mark, computed here by hand with the factor inlined.
  const mark = bundle.prints["ACR-INF"].onchain.value as number;
  const bill = monthlyCost({ inf: 12, gpu: 0, data: 0 }, "ACR-INF", mark);
  assert.ok(bill !== null && Math.abs(bill - 12 * 1000 * mark) < 1e-9);
  assert.ok(bill! > 5000 && bill! < 7000, `a 12M-token month should bill ~$5.9k, got ${bill}`);
  // Null discipline: no purchase → null, never $0.00; unknown index → null.
  assert.equal(monthlyCost({ inf: 0, gpu: 1, data: 0 }, "ACR-INF", mark), null);
  assert.equal(monthlyCost({ inf: 12, gpu: 0, data: 0 }, "ACR-XXX", mark), null);
  assert.equal(totalCost({ inf: 12, gpu: 0, data: 0 }, {}), null, "no marks yet must not read as a free month");

  // The 24-fixing move: a ratio inside the history series, null when short.
  const series = (vals: number[]) => vals.map((value, i) => ({ ts: i * 3600, value, ci_lo: value, ci_hi: value }));
  const flat48 = series(Array.from({ length: 48 }, () => 0.5));
  assert.equal(deltaBp(flat48), 0);
  const up = series(Array.from({ length: 48 }, (_, i) => (i === 47 ? 0.505 : 0.5)));
  assert.ok(Math.abs(deltaBp(up)! - 100) < 1e-6, "a 1% move is 100bp");
  assert.equal(deltaBp(series([0.5, 0.5])), null, "a short series is unknown, not unchanged");
  assert.equal(deltaBp(undefined), null);

  // compactMoney: the chip's format, and the ellipsis discipline.
  assert.equal(compactMoney(7542.53), "$7.5k");
  assert.equal(compactMoney(212), "$212");
  assert.equal(compactMoney(10.24), "$10.24");
  assert.equal(compactMoney(NaN), "…");

  // Presets must themselves parse: a one-tap start that parseWorkload would
  // reject on the next reload would be a profile that vanishes overnight.
  for (const p of PRESETS) {
    assert.deepEqual(parseWorkload(JSON.stringify(p.w)), p.w, `preset ${p.name} does not round-trip`);
  }
});

test("resolveEdition: param beats stored beats default", () => {
  assert.equal(resolveEdition("plain", "expert"), "plain");
  assert.equal(resolveEdition("expert", "plain"), "expert");
  assert.equal(resolveEdition(null, "plain"), "plain");
  assert.equal(resolveEdition("junk", "plain"), "plain");
  assert.equal(resolveEdition(null, "junk"), "expert");
  assert.equal(resolveEdition(null, null), "expert");
});

/* Execute the boot script headlessly with fake globals — the same source
   string the layout inlines, so these cases are exactly what ships. */

interface BootWorld {
  attrs: Map<string, string>;
  store: Map<string, string>;
}

function runBoot(opts: {
  search?: string;
  stored?: string | null;
  storageThrows?: boolean;
}): BootWorld {
  const attrs = new Map<string, string>();
  const store = new Map<string, string>();
  if (opts.stored != null) store.set(EDITION_KEY, opts.stored);

  const localStorage = opts.storageThrows
    ? {
        getItem(): string | null {
          throw new Error("denied");
        },
        setItem(): void {
          throw new Error("denied");
        },
      }
    : {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      };

  const world = {
    location: { search: opts.search ?? "" },
    localStorage,
    document: {
      documentElement: {
        setAttribute: (k: string, v: string) => void attrs.set(k, v),
      },
    },
  };

  new Function("location", "localStorage", "document", editionBootScript())(
    world.location,
    world.localStorage,
    world.document,
  );
  return { attrs, store };
}

test("boot: stored plain sets the attribute", () => {
  const w = runBoot({ stored: "plain" });
  assert.equal(w.attrs.get(EDITION_ATTR), "plain");
});

test("boot: nothing stored stays expert (no attribute)", () => {
  const w = runBoot({});
  assert.equal(w.attrs.has(EDITION_ATTR), false);
});

test("boot: ?edition=plain beats stored expert and persists", () => {
  const w = runBoot({ search: `?${EDITION_PARAM}=plain`, stored: "expert" });
  assert.equal(w.attrs.get(EDITION_ATTR), "plain");
  assert.equal(w.store.get(EDITION_KEY), "plain");
});

test("boot: ?edition=expert beats stored plain and persists", () => {
  const w = runBoot({ search: `?${EDITION_PARAM}=expert`, stored: "plain" });
  assert.equal(w.attrs.has(EDITION_ATTR), false);
  assert.equal(w.store.get(EDITION_KEY), "expert");
});

test("boot: junk param falls back to stored choice", () => {
  const w = runBoot({ search: `?${EDITION_PARAM}=fancy`, stored: "plain" });
  assert.equal(w.attrs.get(EDITION_ATTR), "plain");
  assert.equal(w.store.get(EDITION_KEY), "plain");
});

test("boot: junk everywhere stays expert", () => {
  const w = runBoot({ search: `?${EDITION_PARAM}=fancy`, stored: "silly" });
  assert.equal(w.attrs.has(EDITION_ATTR), false);
});

test("boot: throwing storage never crashes; param still applies", () => {
  const w = runBoot({ search: `?${EDITION_PARAM}=plain`, storageThrows: true });
  assert.equal(w.attrs.get(EDITION_ATTR), "plain");
});

test("boot script embeds the shared constants (drift guard)", () => {
  const src = editionBootScript();
  assert.ok(src.includes(JSON.stringify(EDITION_KEY)));
  assert.ok(src.includes(JSON.stringify(EDITION_PARAM)));
  assert.ok(src.includes(JSON.stringify(EDITION_ATTR)));
});
