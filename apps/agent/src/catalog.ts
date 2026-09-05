/** Marketplace discovery — read /marketplace/catalog and pick what to buy. */

import type { FetchLike } from "./payer.js";

export interface CatalogItem {
  resource: string;
  type?: string;
  accepts: Array<{ amount?: string; maxAmountRequired?: string; network?: string }>;
  metadata?: {
    family?: string;
    description?: string;
    provider?: { name?: string; attestation?: unknown | null };
  };
}

export async function fetchCatalog(api: string, fetchImpl: FetchLike = fetch): Promise<CatalogItem[]> {
  const res = await fetchImpl(`${api}/marketplace/catalog`);
  if (!res.ok) throw new Error(`catalog unavailable: ${res.status}`);
  const body = (await res.json()) as { items?: CatalogItem[] };
  return body.items ?? [];
}

/** The dearest price any of these listings advertises, in USDC.
 *
 * The catalog states every price, so the spend cap can be checked against ALL
 * of them before a single payment moves. It used to be checked against one bare
 * 402 from `targets[0]`, which was sound only while every resource cost the
 * same flat price; the seller fleet prices per seller, so the first target says
 * nothing about the dearest one. Null when no listing carries a readable
 * amount. */
export function maxAdvertisedPrice(items: CatalogItem[]): number | null {
  let worst: number | null = null;
  for (const item of items) {
    for (const acc of item.accepts ?? []) {
      const atomic = acc.amount ?? acc.maxAmountRequired;
      if (atomic === undefined || !/^\d+$/.test(atomic)) continue;
      const usdc = Number(atomic) / 1e6;
      if (worst === null || usdc > worst) worst = usdc;
    }
  }
  return worst;
}

/** Choose listings to buy. With requireAttested, an unattested provider is
 * skipped — the cautious-buyer demo (reputation read before payment). */
export function pickResources(
  items: CatalogItem[],
  opts: { requireAttested?: boolean } = {},
): string[] {
  return items
    .filter((i) => i.resource && i.accepts?.length)
    .filter((i) => !opts.requireAttested || i.metadata?.provider?.attestation != null)
    .map((i) => i.resource);
}
