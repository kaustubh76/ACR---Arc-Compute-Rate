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
