/* Small chain-identity chips woven through every page. */

/** Honest mode label: every surface says whether its data is real. The
 *  "onchain" tier is the direct-read rung of the connection ladder — the
 *  press is down but the number came straight from ACROracle just now. */
export function SimBadge({ mode }: { mode: "sim" | "dev" | "live" | "onchain" }) {
  if (mode === "live") return <span className="chip chip-teal">live</span>;
  if (mode === "onchain")
    return (
      <span
        className="chip chip-teal"
        title="read straight from ACROracle by this terminal — the index API is down, the record is not"
      >
        direct read
      </span>
    );
  if (mode === "dev") return <span className="chip chip-sky">dev gate</span>;
  return (
    <span className="chip chip-sim" title="bundled simulation — start the index API for live data">
      sim
    </span>
  );
}
