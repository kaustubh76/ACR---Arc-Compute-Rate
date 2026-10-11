import { isUnit, type Unit } from "./indices";

/* The four inputs of a price check, validated once.
 *
 * Lifted out of `app/api/par/route.ts` because a second surface now reads the
 * same query: the preview image a shared `/check?…` link unfurls with. Two
 * validators drift; one cannot. The rules are the proxy's own, unchanged:
 * REJECTED, NOT CLAMPED, so a typo never becomes a passing bill, and each
 * refusal names the field that was wrong, which the press cannot do because it
 * sees the fields together.
 */

export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface ParQuery {
  unit: Unit;
  billed: number;
  quantity: number;
  /** Empty when not supplied. Supplying it changes the ANSWER: the press
   *  benchmarks a vendor of ours against the fleet and a stranger against the
   *  market. */
  vendor: string;
}

export type ParQueryResult = { ok: true; q: ParQuery } | { ok: false; error: string };

/** One reader for both `URLSearchParams` and the `searchParams` object a page's
 *  `generateMetadata` receives, whose values may be arrays. The first value
 *  wins, which is what `URLSearchParams.get` does too. */
export type ParamGetter = (key: string) => string | null | undefined;

export function fromRecord(
  rec: Record<string, string | string[] | undefined>,
): ParamGetter {
  return (key) => {
    const v = rec[key];
    return Array.isArray(v) ? v[0] : v;
  };
}

export function parseParQuery(get: ParamGetter): ParQueryResult {
  const unit = (get("unit") ?? "").trim();
  // An ALLOWLIST, not a pattern: three strings from `lib/indices.ts`, which
  // the press derives from the same index roster.
  if (!isUnit(unit)) return { ok: false, error: "unit must be one of the three priced units" };

  const billed = Number(get("billed_usdc"));
  if (!Number.isFinite(billed) || billed <= 0) {
    return { ok: false, error: "billed_usdc must be a number greater than zero" };
  }
  const quantity = Number(get("quantity"));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, error: "quantity must be a number greater than zero" };
  }
  const vendor = (get("vendor") ?? "").trim();
  if (vendor && !ADDRESS.test(vendor)) {
    return { ok: false, error: "vendor must be a 0x address, or left empty" };
  }
  return { ok: true, q: { unit, billed, quantity, vendor } };
}

/** The press path for a parsed query: what the proxy forwards. */
export function parPath(q: ParQuery): string {
  return (
    `/par?unit=${encodeURIComponent(q.unit)}` +
    `&billed_usdc=${q.billed}&quantity=${q.quantity}` +
    (q.vendor ? `&vendor=${encodeURIComponent(q.vendor)}` : "")
  );
}

/** The query string the page, its proxy call and its preview image all share,
 *  so a shared link, the verdict on it and the card it unfurls with are one
 *  bill and not three readings of it. */
export function parSearch(q: ParQuery): string {
  const p = new URLSearchParams({
    unit: q.unit,
    billed_usdc: String(q.billed),
    quantity: String(q.quantity),
  });
  if (q.vendor) p.set("vendor", q.vendor);
  return p.toString();
}
