"use client";

import { useCallback, useState } from "react";
import { Ed } from "@/components/Ed";
import { fmtInt } from "@/lib/format";
import type { RegistryDirectRead } from "@/lib/types";

/* The one control in this app that re-reads a source to prove the site is live.
 *
 * Every other figure on every other page arrives through the press, so a reader
 * has to take our word for it. This asks `AttestationRegistry` on Arc directly,
 * through `/api/registry` (viem, server-side, no press in the path), and shows
 * the block it was read at. PRESS IT TWICE AND THE BLOCK MOVES — that is the
 * whole product of the button, and it is why the route sets no-store and the
 * read is deliberately not memoized.
 *
 * It lived on /sellers, which was removed. Re-homed rather than deleted: the
 * page it sat on was a registry browser nobody needed, but "this is not a
 * recording" is a claim worth being able to make, and nothing else here makes
 * it. It sits beside ContractRegister, which lists the same contract's address
 * without ever asking it anything.
 *
 * NOT gated on the press being awake, which is the point — it answers while the
 * free tier is asleep, and that is exactly when a reader most doubts the site.
 */
export function RegistryProof() {
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState<RegistryDirectRead | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const readChain = useCallback(async () => {
    setReading(true);
    setErr(null);
    try {
      const res = await fetch("/api/registry", { cache: "no-store" });
      const body = (await res.json()) as RegistryDirectRead & { detail?: string };
      if (!res.ok) {
        setErr(String(body.detail ?? `the read failed (${res.status})`));
        setRead(null);
      } else {
        setRead(body);
      }
    } catch {
      setErr("could not reach the chain from here. Press again");
    } finally {
      setReading(false);
    }
  }, []);

  return (
    <>
      <div className="btn-row" style={{ marginTop: 18 }}>
        <button className="btn" onClick={readChain} disabled={reading}>
          <Ed
            x={reading ? "asking the chain…" : "read it from the chain"}
            p={reading ? "asking the blockchain…" : "check this on the blockchain"}
          />
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0", maxWidth: 68 * 9 }}>
        <Ed
          x="Every address above reaches you through our press. This asks the registry contract itself and reports the block it answered at. Press twice: the block moves."
          p="The list above comes through our server. This asks the blockchain itself. Press twice and the block number moves."
        />
      </p>

      {err ? (
        <p
          className="mono vermilion"
          role="alert"
          style={{ fontSize: 12.5, margin: "10px 0 0", maxWidth: 68 * 9 }}
        >
          {err}
        </p>
      ) : null}

      {read ? (
        <div className="panel panel-pad" style={{ marginTop: 12 }}>
          <div className="section-head" style={{ marginTop: 0 }}>
            <span className="label">
              <Ed x="what the chain returned" p="what the blockchain said" />
            </span>
            <span className="chip chip-teal">
              <Ed x="read just now" p="asked just now" />
            </span>
          </div>
          {/* Block height and latency ARE the payload, not decoration: they are
              what distinguishes a reading from a re-render of the list above. */}
          <div className="table-scroll" style={{ marginTop: 8 }}>
            <table className="sheet">
              <tbody>
                <tr>
                  <td className="muted mono">block</td>
                  <td className="mono gold">{fmtInt(read.block)}</td>
                </tr>
                <tr>
                  <td className="muted mono">sellerCount()</td>
                  <td className="mono">{fmtInt(read.seller_count)}</td>
                </tr>
                <tr>
                  <td className="muted mono">chain</td>
                  <td className="mono">eip155:{read.chain_id}</td>
                </tr>
                <tr>
                  <td className="muted mono">took</td>
                  <td className="mono">{fmtInt(read.took_ms)} ms</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
