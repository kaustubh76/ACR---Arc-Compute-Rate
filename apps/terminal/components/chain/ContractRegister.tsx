import { chainFacts, deployedContracts, type RegisterEntry } from "@/lib/chain";
import { AddressChip } from "./AddressChip";
import { Ed } from "../Ed";
import type { ChainFactsData } from "@/lib/types";

/* The deployed set, named once.

   Two surfaces used to carry their own copy of this list — the footer, as ten
   pills in a wrap, and /developers, as a two-up card grid — and they had
   already disagreed about which contracts exist. This renders both. The
   footer wraps it in a <details>; the developers page renders it open. The
   component itself never asks where it is: the container owns the heading and
   the collapse, and `dense` only changes typographic scale.

   No "use client": it holds no state, and both callers are already client
   components, so it inherits their boundary. */

/** A one-line gloss per row. Written as literal <Ed> elements at module scope
 *  so lib/coverage.test.ts can actually read the p="…" strings — a
 *  { p: "…" } object literal would slip past the banned-jargon lint, which is
 *  evading the gate rather than clearing it. */
const GLOSS: Record<RegisterEntry["key"], React.ReactNode> = {
  oracle: (
    <Ed
      x="the rate itself · every hourly print lands here"
      p="the scoreboard · every hourly rate is written here"
    />
  ),
  futures: (
    <Ed
      x="the cash-settled venue and its order books"
      p="the trading desk · every position and every fill"
    />
  ),
  registry: (
    <Ed
      x="sellers’ signed reliability claims, kept on chain"
      p="where sellers sign their own uptime claims, in public"
    />
  ),
  attestor: (
    <Ed
      x="a paid query, recorded on chain as a right"
      p="proof that a question was paid for, kept in public"
    />
  ),
  usdc: (
    <Ed
      x="the dollars, and the gas the fees are charged in"
      p="the digital dollars · they also pay the fees"
    />
  ),
  gateway: (
    <Ed x="Circle Gateway custody · the desk’s own float" p="where the shop’s own dollars are held" />
  ),
};

export function ContractRegister({
  chain,
  oracleFallback,
  dense = false,
}: {
  chain?: ChainFactsData | null;
  /** The payload's top-level `oracle`, used when chain.oracle_address is null. */
  oracleFallback?: string | null;
  /** Footer scale. The developers page takes the roomier default. */
  dense?: boolean;
}) {
  const c = chainFacts(chain);
  const rows = deployedContracts(chain, oracleFallback);

  return (
    <div className={`register${dense ? " is-dense" : ""}`}>
      <div className="register-head">
        <span className="register-caip">{c.caip2}</span>
        <span aria-hidden>·</span>
        <a className="tx-link" href={c.explorer} target="_blank" rel="noreferrer">
          arcscan <span className="ext">↗</span>
        </a>
      </div>

      {rows.map((r) => (
        <div className={`register-row${r.primary ? " is-primary" : ""}`} key={r.key}>
          <div className="register-name">{r.name}</div>
          <div className="register-gloss">{GLOSS[r.key]}</div>
          <div className="register-addr">
            <AddressChip address={r.addr} explorer={c.explorer} href={r.href} />
          </div>
        </div>
      ))}

      {/* All three Circle wallet models are in use here, and this said so only
          inside a title= on a span nobody could focus — unreachable by
          keyboard, unread by screen readers. It is a sentence now. */}
      <p className="register-note">
        <Ed
          x="Readers trade from Circle user-controlled wallets: the key lives behind a PIN, never with us."
          p="You trade from your own wallet. The key sits behind your PIN, never with us."
        />
      </p>

      {/* The one admission that has to survive the fully-live state. Every
          other "sim" mark on the site reports CONNECTION tier, so once the
          press is up and the oracle is printing they all go teal while the
          flow underneath the number is still synthetic. It used to ride in the
          dateline; the dateline now carries only what is true this minute, and
          this is a standing fact about the build. Rendered only when it is
          true: a disclosure that fires on every load stops being read. */}
      {c.tapeSource === "sim" && (
        <p className="register-note">
          <Ed
            x="The estimator, the signature and the on-chain print are real. The settlement flow underneath is simulated."
            p="The rate, its signature and the blockchain record are real. The money moving underneath is pretend."
          />
        </p>
      )}
    </div>
  );
}
