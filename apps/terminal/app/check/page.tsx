import type { Metadata } from "next";
import { CheckView } from "./view";

export const metadata: Metadata = {
  title: "Check a bill · ACR",
  description:
    "Price one invoice against published third-party prices, with a link to every price it was compared against. No account, no key.",
};

export const dynamic = "force-dynamic";

/* No server preload, deliberately — the same rule /tape and /ops follow. A
   price check has no answer until a visitor types one, so there is nothing to
   render ahead of them and a preload would only delay the form. */
export default function CheckPage() {
  return <CheckView />;
}
