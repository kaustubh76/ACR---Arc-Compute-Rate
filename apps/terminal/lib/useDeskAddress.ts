"use client";

import { useEffect, useState } from "react";

/** The key PublicDesk writes once a wallet has collateral on the venue. */
export const DESK_ADDRESS_KEY = "acr-desk-collateralized";

/** The address this browser trades from, if any.
 *
 *  Exists so the public tape and the mark chart can mark a reader's OWN fills
 *  without the desk lifting its session state into the page — watching your own
 *  trade scroll past the public tape is the most convincing thing this site
 *  does, and it should not cost a prop drilled through three components.
 *
 *  Polled rather than read once: a reader posts collateral mid-session, and a
 *  mount-only read would leave their fills unmarked until a reload — exactly
 *  the moment the marking is worth something. A localStorage read is cheap;
 *  the `storage` event is no use here because it only fires in OTHER tabs.
 */
export function useDeskAddress(): string | undefined {
  const [addr, setAddr] = useState<string>();
  useEffect(() => {
    const read = () => {
      try {
        setAddr(localStorage.getItem(DESK_ADDRESS_KEY) ?? undefined);
      } catch {
        /* private mode — no marking, everything else still works */
      }
    };
    read();
    const t = setInterval(read, 5000);
    return () => clearInterval(t);
  }, []);
  return addr;
}
