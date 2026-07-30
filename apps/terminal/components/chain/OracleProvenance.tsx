"use client";

import { addrUrl, blockUrl, chainFacts } from "@/lib/chain";
import { fmt, halfCiBp } from "@/lib/format";
import { AddressChip } from "./AddressChip";
import { FinalityBadge } from "./FinalityBadge";
import { SimBadge } from "./Badges";
import { TxLink } from "./TxLink";
import { Ed } from "@/components/Ed";
import type { ChainFactsData, OnchainPrint, PosterRef } from "@/lib/types";

/* The settlement-grade provenance panel: where this print lives on-chain.
   Always renders — live it carries the real oracle, signer, postPrint tx and
   block; offline it renders the bundled facts with a SIM badge and the one
   honest hint. Never the bare "no oracle configured" sentence. */
export function OracleProvenance({
  indexId,
  onchain,
  chain,
  live = false,
  direct = false,
  mini = false,
}: {
  indexId: string;
  onchain?: OnchainPrint | null;
  chain?: ChainFactsData | null;
  live?: boolean;
  /** the on-chain print is a fresh DIRECT ACROracle read (press down) */
  direct?: boolean;
  mini?: boolean;
}) {
  const c = chainFacts(chain);
  const post: PosterRef | undefined = c.poster?.last?.[indexId];
  const deployed = Boolean(c.oracle);
  // "live" only when the payload is actually live AND we have a real on-chain
  // read — a bundled snapshot carries a real oracle address but must not claim
  // "live". A direct read outranks the archive: the press is down but the
  // number on screen came from the contract seconds ago. Anything else
  // degrades to the dev/sim tier honestly.
  const mode: "sim" | "dev" | "live" | "onchain" =
    deployed && live ? "live" : deployed && direct && onchain ? "onchain" : c.gate === "circle" ? "dev" : "sim";

  return (
    <div className={`panel panel-pad provenance${mini ? " provenance-mini" : ""}`}>
      <div className="provenance-row" style={{ borderBottom: "1px solid var(--hairline)" }}>
        <span className="eyebrow">
          <Ed x="settlement provenance" p="proof of record" />{" "}
          <span className="ref">· {indexId}</span>
        </span>
        <SimBadge mode={mode} />
      </div>

      {onchain && (
        <div className="provenance-row">
          <span className="label">
            <Ed x="On-chain rate" p="Official rate" />
          </span>
          <span className="val">
            <span className="mono" style={{ color: "var(--sand)", fontWeight: 600 }}>
              {fmt(onchain.value)}
            </span>{" "}
            <span className="muted">±{halfCiBp(onchain).toFixed(1)} bp</span>
          </span>
        </div>
      )}

      <div className="provenance-row">
        <span className="label">
          <Ed x="ACROracle" p="Scoreboard contract" />
        </span>
        <span className="val">
          {c.oracle ? (
            <AddressChip address={c.oracle} explorer={c.explorer} />
          ) : (
            <span className="muted" title="deploy: make deploy-testnet → set ACR_ORACLE_ADDRESS">
              undeployed — awaiting testnet
            </span>
          )}
        </span>
      </div>

      <div className="provenance-row">
        <span className="label">
          <Ed x="Signer" p="Signed by" />
        </span>
        <span className="val">
          {c.signer ? (
            <AddressChip address={c.signer} explorer={c.explorer} />
          ) : (
            <span className="muted">
              <Ed x="EIP-712 · domain “ACR Oracle” v1" p="a verifiable signature (EIP-712 standard)" />
            </span>
          )}
        </span>
      </div>

      <div className="provenance-row">
        <span className="label">
          <Ed x="postPrint tx" p="Posting receipt" />
        </span>
        <span className="val">
          {post?.tx ? (
            <>
              <TxLink txRef={post.tx} explorer={c.explorer} />
              {post.block != null && (
                <>
                  {" "}
                  <a
                    className="tx-link"
                    href={blockUrl(post.block, c.explorer)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    block {post.block.toLocaleString("en-US")} <span className="ext">↗</span>
                  </a>
                </>
              )}
            </>
          ) : (
            <span className="chip chip-sim">awaiting first live post</span>
          )}
        </span>
      </div>

      {!mini && (
        <>
          <div className="provenance-row">
            <span className="label">Freshness</span>
            <span className="val">
              <FinalityBadge onchain={onchain} live={live || direct} />
            </span>
          </div>
          <div className="provenance-row">
            <span className="label">
              <Ed x="Domain" p="Network" />
            </span>
            <span className="val muted">
              chain {c.chainId} ·{" "}
              <a className="tx-link" href={addrUrl(c.usdc, c.explorer)} target="_blank" rel="noreferrer">
                USDC {c.usdc.slice(0, 6)}…{c.usdc.slice(-4)}
              </a>{" "}
              <Ed x="· gas token" p="· also pays the fees" />
            </span>
          </div>
          {onchain && (
            <details className="disclosure" style={{ borderTop: 0 }}>
              <summary>
                <Ed x="raw on-chain print" p="the raw record, as stored" />
              </summary>
              <div className="disclosure-body">
                <div className="specimen">
                  <pre>{JSON.stringify(onchain, null, 2)}</pre>
                </div>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
