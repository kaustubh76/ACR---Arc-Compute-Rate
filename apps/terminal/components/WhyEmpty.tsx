"use client";

import { Ed } from "@/components/Ed";
import { setChain, useChain } from "@/lib/useChain";

/* Why this surface is empty, and the way through.
 *
 * THE MISATTRIBUTION THIS ENDS. A press that predates a feature answers 404
 * for its routes. The terminal turned that into "the press did not answer, so
 * this page shows nothing rather than a count from a service that is not
 * running" — and the service was running. Measured on the live site on
 * 2026-10-10: the mainnet press served 44 routes happily while /spend and
 * /traction described the product as dead. Telling a reader a running system
 * is down is worse than saying nothing, because it sends them away from the
 * network where the same page is fully alive.
 *
 * IT IS THE SAME APOLOGY, NOT A NEW PANEL. Each of these surfaces already had
 * an honest outage sentence; this replaces it with one that can tell the two
 * causes apart, and adds the one thing none of them had — somewhere to go.
 * `ACR_UX`'s standing rule is that additive, panel-shaped chrome gets rejected,
 * so this renders into the same `.panel` the apology occupied.
 *
 * AND IT DISAPPEARS BY ITSELF. `upstream: "absent"` comes from asking the host's
 * own `/openapi.json` whether it has the route (lib/api.ts `routeAbsent`), so
 * the moment that deployment is updated this component stops rendering with no
 * code change and nothing to remember. A hardcoded "mainnet is behind" banner
 * would have had to be removed by hand, which is how a true notice becomes a
 * false one.
 */

export function WhyEmpty({
  upstream,
  what,
  plainWhat,
}: {
  /** The proxy's verdict on the host, off `FetchError.upstream`. */
  upstream?: "ok" | "error" | "timeout" | "absent";
  /** What is missing, as a noun phrase: "the spend operator", "this benchmark". */
  what: string;
  plainWhat: string;
}) {
  const chain = useChain();
  const absent = upstream === "absent";

  if (!absent) {
    // The ordinary outage, in the words these surfaces already used.
    return (
      <p className="standfirst">
        <Ed
          x="The press did not answer, so this is showing nothing rather than something stale."
          p="We could not reach the service, so this shows nothing rather than old news."
        />
      </p>
    );
  }

  return (
    <>
      <p className="standfirst">
        <Ed
          x={`This deployment of the press predates ${what}, so it has no route to ask. It is not down; it is older than the feature.`}
          p={`The service here is an older build without ${plainWhat}. It is not broken, just behind.`}
        />
      </p>
      <p className="standfirst">
        <Ed
          x="The same page is live on the other network, with real decisions on it."
          p="The same page works on the practice network, with real records on it."
        />{" "}
        <button
          type="button"
          className="section-link"
          onClick={() => setChain(chain === "mainnet" ? "testnet" : "mainnet")}
        >
          <Ed x="switch and see it →" p="switch and look →" />
        </button>
      </p>
    </>
  );
}
