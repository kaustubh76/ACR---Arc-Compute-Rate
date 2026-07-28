/* Small chain-identity chips woven through every page. */

import { CHAIN } from "@/lib/chain";

/** `● Arc Testnet · 5042002` — teal dot when live, sky outline otherwise. */
export function NetworkPill({
  live = false,
  name = CHAIN.name,
  chainId = CHAIN.chainId,
}: {
  live?: boolean;
  name?: string;
  chainId?: number;
}) {
  return (
    <span className={`chip ${live ? "chip-teal" : "chip-sky"}`}>
      <i className={`dot${live ? " breathe" : ""}`} />
      {name} · {chainId}
    </span>
  );
}

/** USDC-as-gas — Arc's defining property, stated as a chip. */
export function GasBadge() {
  return (
    <span
      className="chip chip-gold"
      title="USDC is Arc's native gas — fees are deterministic and dollar-denominated, which is what makes the attack-cost bound a number instead of a distribution"
    >
      gas = USDC
    </span>
  );
}

/** Honest mode label: every surface says whether its data is real. */
export function SimBadge({ mode }: { mode: "sim" | "dev" | "live" }) {
  if (mode === "live") return <span className="chip chip-teal">live</span>;
  if (mode === "dev") return <span className="chip chip-sky">dev gate</span>;
  return (
    <span className="chip chip-sim" title="bundled simulation — start the index API for live data">
      sim
    </span>
  );
}
