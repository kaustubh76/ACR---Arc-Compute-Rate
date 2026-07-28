"use client";

import { useState } from "react";
import { addrGradient, addrUrl, isHexAddress } from "@/lib/chain";
import { shortAddr } from "@/lib/format";

/* A wallet/contract identity: deterministic gradient disc + short address.
   Real hex addresses link to the Arc explorer and can be copied; synthetic
   sim ids keep the disc (hashed) but wear a dashed ring instead of a link. */
export function AddressChip({
  address,
  explorer,
  copy = true,
  label,
}: {
  address: string;
  explorer?: string;
  copy?: boolean;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const real = isHexAddress(address);
  const disc = (
    <i
      className={`addr-disc${real ? "" : " sim-ring"}`}
      style={{ background: addrGradient(address) }}
      aria-hidden
    />
  );
  const short = label ?? shortAddr(address);

  return (
    <span className="addr-chip">
      {disc}
      {real ? (
        <a href={addrUrl(address, explorer)} target="_blank" rel="noreferrer" title={address}>
          {short}
        </a>
      ) : (
        <span title={`${address} — simulated identity`}>{short}</span>
      )}
      {copy && real && (
        <button
          className="addr-copy"
          onClick={() => {
            navigator.clipboard?.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          title="copy address"
        >
          {copied ? "ok" : "cp"}
        </button>
      )}
    </span>
  );
}
