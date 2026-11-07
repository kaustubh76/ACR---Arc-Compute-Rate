import type { ChainKey } from "./chainChoice";

/* The reserve sleeve's fund: Circle's tokenized Treasury bill, USYC.
 *
 * WHY THIS FILE EXISTS. `components/float/Yield.tsx` carried the testnet USYC
 * address as a constant and printed it beside a chip saying "not wired to this
 * treasury". Every fact behind that address — that it is a deployed proxy, that
 * it answers `symbol() == "USYC"` and `decimals() == 6`, that a Teller mints and
 * redeems it — lived in `docs/TAMEION.md` and nowhere a reader could check. An
 * address printed without being read is an assertion wearing a monospace font.
 *
 * ADDRESSES ONLY, AND KEYED ON THE CHAIN. `lib/mainnetOnly.test.ts` scans for
 * chain MARKERS — the chain id, the RPC hosts, the display names — not for
 * contract addresses, which is why the old single constant passed it. Keying on
 * `ChainKey` keeps that true while stopping the page from showing one chain's
 * fund address under the other chain's label.
 *
 * NOTHING HERE READS ELIGIBILITY, AND THAT IS DELIBERATE. `docs/TAMEION.md`
 * records that the Teller's allowlist accessor is not under any of the three
 * usual names, so the real ABI is needed and "guessing at it would be worse
 * than saying so". The blocker is a Circle Support ticket with a 24 to 48 hour
 * lead time, which is a fact about a queue and not something on chain.
 *
 * THERE IS NO ACCESSOR ON THE TELLER, and for a while this file said there was
 * none anywhere. Corrected 2026-11-07: the allowlist is a SEPARATE contract, a
 * Solmate `RolesAuthority` at an address nobody here had, so the search of the
 * Teller was honest and its conclusion was still wrong. `docs/TAMEION.md`
 * carries the three reads that answer it positively — no roles held, the
 * deposit capability gated to role 0 or 9, and not public. Left on the record
 * because this panel has now been wrong twice in the same direction, about
 * `buy()`/`sell()` and about this, and both times by concluding from an absence.
 *
 * What stands, and is why the probe still exists: `maxDeposit(address)` returns
 * a NON-ZERO allowance for an address it will not let deposit — ours read
 * 5,723,443 while the deposit reverts `NotPermissioned()`. The revert selector
 * lives on `.data` three levels down viem's cause chain and not in `.message`.
 *
 * DO NOT RENDER `maxDeposit > 0` AS A GREEN STATE. It is the single most
 * plausible-looking wrong answer this panel could give: a number that reads as
 * headroom, on an address with none, in the one section of the page whose whole
 * job is to be honest about not being live yet. If this surface ever shows
 * whether the fund would accept a deposit, it has to come from the attempt or
 * from the registry, not from an allowance getter and not from a guessed ABI.
 */

export type ReserveFund = {
  /** The fund's own ERC-20. A proxy, so its code size is small by design. */
  token: string;
  /** The Teller. ERC-4626 shaped: `deposit(uint256,address)`,
   *  `mint(uint256,address)`, `redeem(uint256,address,address)`,
   *  `withdraw(uint256,address,address)`.
   *
   *  THIS COMMENT USED TO SAY `buy()` AND `sell()`, copied from
   *  `docs/TAMEION.md`, and both are wrong: the verified implementation
   *  declares neither. Corrected 2026-11-06 against the implementation's own
   *  function list, and the doc is corrected too. The mistake is worth leaving
   *  on the record because of what it would have cost: a probe written against
   *  `buy()` reverts for "no such function" and renders as "not permitted",
   *  which is a confident wrong answer about the one thing this panel is
   *  careful about. */
  teller: string;
};

/** Read first-hand over each chain's public RPC on 2026-10-04 and recorded in
 *  `docs/TAMEION.md`, which is the document these addresses answer to. */
export const RESERVE_FUND: Record<ChainKey, ReserveFund> = {
  testnet: {
    token: "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C",
    teller: "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A",
  },
  mainnet: {
    token: "0x8a5D989Bbb96929F689B0200f435f53dA42bF490",
    /* The mainnet Teller was never read first-hand, and inventing one would put
       an address on screen that nobody has checked. The surface shows what it
       has. */
    teller: "",
  },
};

export function reserveFund(chain: ChainKey): ReserveFund {
  return RESERVE_FUND[chain];
}

/** THE BENCH, AND WHY IT IS A SEPARATE TYPE FROM THE FUND ABOVE.
 *
 *  `ReserveFund` is Circle's. This is ours: the same `UsycSleeve` contract, the
 *  same bytecode that would face Circle's Teller, deployed in front of a
 *  published stand-in fund so the mechanism can be driven today rather than
 *  described. Keeping it in its own type is the point — a field on
 *  `ReserveFund` would read as part of the fund, and `float/src/bin/navsync.ts`
 *  is explicit about the failure mode: "putting a simulated address in the
 *  deployment record is how a stand-in quietly becomes part of the system".
 *
 *  THE SLEEVE ANSWERS TO THE DEPLOY KEY, NOT THE VAULT, by design
 *  (`contracts/script/DeploySimUsyc.s.sol`) so that no simulated number can
 *  reach `totalValueUsdc()`. Nothing read from here may be summed into a
 *  treasury total, and the surface that shows it has to say what it is. */
export type ReserveBench = {
  /** `UsycSleeve`, the real contract. Verified. */
  sleeve: string;
  /** `SimUsyc`, the stand-in share token. Verified. */
  share: string;
  /** `SimUsycTeller`, the stand-in fund. */
  teller: string;
};

/** Deployed 2026-11-06 and recorded in `docs/TAMEION.md`, which these answer to.
 *  Mainnet is empty on purpose: there is no stand-in there and inventing one
 *  would put an address on screen that nobody deployed. */
export const RESERVE_BENCH: Record<ChainKey, ReserveBench> = {
  testnet: {
    sleeve: "0x6D2A34ed26C9e4E58062ecAb9fdD1A80E4b1972E",
    share: "0x62C4F9FF42483BA211736C19632eaB65e1eF4995",
    teller: "0x15934AD8Ae0125935B9dBfe0a8B88A9883A04023",
  },
  mainnet: { sleeve: "", share: "", teller: "" },
};

export function reserveBench(chain: ChainKey): ReserveBench {
  return RESERVE_BENCH[chain];
}

/** USDC in, shares out, as `SimUsycTeller.previewDeposit` computes it:
 *  `usdcAmount * 1e18 / nav`.
 *
 *  A PORT, SO THE WHAT-IF COSTS NO CALL. The slider needs an answer on every
 *  drag and Arc's RPC is rate limited per source address; one NAV read and this
 *  arithmetic gives the same number the contract would, which is also why it is
 *  a pure function with its own test rather than four expressions in a
 *  component. `null` whenever the NAV was not read or is zero: a division by an
 *  unread price is not a quote, and rendering 0 shares would be a claim. */
export function previewDeposit(assetsUnits: bigint, navWad: bigint | null | undefined): bigint | null {
  if (navWad === null || navWad === undefined || navWad <= 0n) return null;
  if (assetsUnits <= 0n) return 0n;
  return (assetsUnits * 10n ** 18n) / navWad;
}

/** Shares in, USDC out, as `SimUsycTeller.previewRedeem` computes it: gross at
 *  NAV, then the redemption fee removed.
 *
 *  THE FEE IS NOT OPTIONAL. `UsycSleeve.valueUsdc()` deliberately calls
 *  `previewRedeem` rather than `balance * NAV`, with the reason in its own
 *  comment: "a fee that the fund will certainly charge is not value the
 *  treasury has". A preview that dropped it would quote the treasury money it
 *  cannot get, which is the one direction this surface must not round. */
export function previewRedeem(
  sharesUnits: bigint,
  navWad: bigint | null | undefined,
  feeBps: number | null | undefined,
): bigint | null {
  if (navWad === null || navWad === undefined || navWad <= 0n) return null;
  if (feeBps === null || feeBps === undefined || !Number.isFinite(feeBps) || feeBps < 0) return null;
  if (sharesUnits <= 0n) return 0n;
  const gross = (sharesUnits * navWad) / 10n ** 18n;
  return gross - (gross * BigInt(Math.round(feeBps))) / 10_000n;
}

/** What the fund answered when it was read on 2026-10-04.
 *
 *  THE POINT OF PINNING THIS is that a live read can now be compared against
 *  the record rather than merely displayed. If Circle redeploys behind the proxy
 *  and the token starts answering with different decimals, the page says the
 *  reads no longer agree with what we wrote down, instead of quietly rendering a
 *  different number under the same prose. */
export const RESERVE_RECORD = { symbol: "USYC", decimals: 6 } as const;

/** Whether a live read still matches the record.
 *
 *  `null` when either half was not read: a throttled read is not a disagreement,
 *  and reporting one as "the fund no longer matches" would be alarming and
 *  wrong. Both halves have to be present to say either yes or no. */
export function agreesWithRecord(symbol: string | null, decimals: number | null): boolean | null {
  if (symbol === null || decimals === null) return null;
  return symbol === RESERVE_RECORD.symbol && decimals === RESERVE_RECORD.decimals;
}

/** The Teller's refusal, by selector.
 *
 *  ONE ENTRY, BECAUSE ONE WAS MATCHED. The verified implementation declares ten
 *  custom errors — BadAddress, BadAmount, BadDecimals, BadTime, LimitExceeded,
 *  NoAccess, NotPermissioned, YearNotFound, ZeroAssets, ZeroShares — and
 *  `0x7f63bd0f` matched exactly one of them. Measured 2026-11-06 by driving
 *  `deposit(uint256,address)` as a staticcall. The other nine are deliberately
 *  absent rather than computed: a selector this surface has not seen refused
 *  anything should render as its raw hex, which is checkable, instead of a name
 *  this code guessed at. */
export const TELLER_ERRORS: Record<string, string> = {
  "0x7f63bd0f": "NotPermissioned",
};

/** The revert selector buried in a client error, or null.
 *
 *  THE TRAP THIS FUNCTION EXISTS FOR. viem wraps a reverted call
 *  `CallExecutionError <- ExecutionRevertedError <- RpcRequestError`, and the
 *  selector is on the INNERMOST link's `.data`. It is not in `.message`, and
 *  `.details` is the string "execution reverted" and nothing more. A check
 *  written against either reports "no legible answer" about a chain that
 *  answered perfectly clearly. */
export function revertSelector(err: unknown): string | null {
  for (let w = err as { cause?: unknown; data?: unknown } | undefined; w; w = w.cause as typeof w) {
    const d = w.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]{8}/.test(d)) return d.slice(0, 10).toLowerCase();
  }
  return null;
}

/** A selector as a name when it is one we matched, otherwise the selector.
 *
 *  Never null for a real selector: the raw hex is a worse answer than a name
 *  and a far better one than silence, because a reader can look it up. */
export function refusalName(selector: string | null): string | null {
  if (selector === null) return null;
  return TELLER_ERRORS[selector] ?? selector;
}

/** Whether the vault's reserve slot holds no venue at all.
 *
 *  THE NEGATIVE ANSWER IS THE ONE THAT MATTERS. "No venue, which is the honest
 *  answer" is a reassuring sentence, and it must only ever be printed for an
 *  address that really is twenty zero bytes. So the shape is exact: anything
 *  short, long, malformed or merely zero-ish reads as NOT empty, which drives
 *  the cautious branch instead — "a venue is wired that this panel has not
 *  described". Being wrong in that direction costs a reader a question; being
 *  wrong the other way tells them nothing is there when something is. */
export function slotIsEmpty(addr: string | undefined | null): boolean {
  return typeof addr === "string" && /^0x0{40}$/.test(addr);
}

/** The share of a rebalance that would reach the reserve sleeve, in basis
 *  points, or null when the policy was not read.
 *
 *  `FloatVault.rebalance` computes `toWorking = excess * workingShareBps /
 *  10_000` and then `toReserve = excess - toWorking`, so the reserve's share is
 *  exactly the remainder and there is no second knob. On the live vault
 *  `workingShareBps` is 10000, which makes that remainder ZERO — the T-bill
 *  leg would receive nothing on every sweep even if a sleeve were wired and
 *  Circle had allowlisted us. That is a gate the panel used to leave out while
 *  naming the allowlist as the only obstacle.
 *
 *  CLAMPED, THOUGH THE CONTRACT ALREADY GUARDS IT. `setPolicy` requires
 *  `workingShareBps <= 10_000`, so a larger value cannot be stored — but this
 *  function's job is to produce a share a surface can print, and a negative
 *  percentage on screen would be a worse answer than a clamped one. `null` for
 *  anything unreadable, because an unread policy must not render as 0%. */
export function reserveShareBps(workingShareBps: number | undefined | null): number | null {
  if (typeof workingShareBps !== "number" || !Number.isFinite(workingShareBps)) return null;
  return Math.max(0, Math.min(10_000, 10_000 - workingShareBps));
}

/** Bytes of code at an address, from the hex a node returns.
 *
 *  `undefined` and `"0x"` both mean NOTHING IS DEPLOYED THERE, which is the one
 *  answer this function exists to be able to give: the whole claim is that these
 *  contracts are real, and a surface that cannot say "nothing there" cannot
 *  honestly say "something there" either. */
export function codeBytes(hex: string | undefined | null): number {
  if (!hex || hex === "0x") return 0;
  return Math.floor((hex.length - 2) / 2);
}
