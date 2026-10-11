import type { Metadata } from "next";
import { OG_BASE, OG_SIZE } from "@/lib/og";
import { fromRecord, parSearch, parseParQuery } from "@/lib/parQuery";
import { CheckView } from "./view";

const BASE: Metadata = {
  title: "Check a bill · ACR",
  description:
    "Price one invoice against published third-party prices, with a link to every price it was compared against. No account, no key.",
};

/* A VERDICT IS A LINK, so the link should look like the verdict. The view
   writes the four fields of a bill into its own URL on submit; when a page
   is opened with them, its preview image is the verdict card
   (`app/og/check/route.tsx`) rather than the site's default, and the
   description names the bill. The same validator the proxy and the image use
   decides whether the URL holds a bill at all; a partial one gets the plain
   metadata and the plain image, never a card about nothing.

   `OG_BASE` is spread back in because Next replaces a parent's `openGraph`
   object rather than merging it, and the site name would otherwise vanish
   from exactly the share that carries the most. */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const parsed = parseParQuery(fromRecord(await searchParams));
  if (!parsed.ok) return BASE;
  const { q } = parsed;
  const description = `${q.billed} USDC for ${q.quantity} × ${q.unit.replace("$/", "")}, priced against published list prices from sellers ACR does not operate.`;
  return {
    ...BASE,
    description,
    openGraph: {
      ...OG_BASE,
      title: BASE.title as string,
      description,
      images: [{ url: `/og/check?${parSearch(q)}`, ...OG_SIZE, alt: "The verdict on this bill" }],
    },
    twitter: { card: "summary_large_image" },
  };
}

export const dynamic = "force-dynamic";

/* No server preload, deliberately — the same rule /tape and /ops follow. A
   price check has no answer until a visitor types one, so there is nothing to
   render ahead of them and a preload would only delay the form. */
export default function CheckPage() {
  return <CheckView />;
}
