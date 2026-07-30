import { test } from "node:test";
import assert from "node:assert/strict";
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
