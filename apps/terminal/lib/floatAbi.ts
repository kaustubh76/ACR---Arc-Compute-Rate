/* The float contracts' read ABIs, kept where a test can reach them.

   `lib/floatOnchain.ts` imports `server-only`, so nothing under `npm test` can
   import it — the same split `lib/onchainCodec.ts` and `lib/onchain.ts` already
   use, for the same reason. The ABIs live here because two of them carry an
   ORDER that matters: `policy` and `agentOf` are struct getters whose outputs
   come back as a tuple, so the reader indexes them positionally, and a field
   inserted into the Solidity struct would silently shift every number after it.
   `lib/floatAbi.test.ts` drives both orders out of FloatVault.sol.

   Inlined rather than loaded from `contracts/out`: `float/src/artifacts.ts` is
   the loader the rest of the system uses and it needs `node:fs` plus a prior
   `forge build`, neither of which a deployed route has. These are the same
   minimal read sets `float/app/index.html` and `walk.html` inline, plus the
   four the ladder needs.
*/

export const VAULT_ABI = [
  { type: "function", name: "paused", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "usdc", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "prices", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "working", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "reserve", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "receiptCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalValueUsdc", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "policy",
    inputs: [],
    outputs: [
      { name: "maxPremiumBps", type: "uint16" },
      { name: "humanMaxPremiumBps", type: "uint16" },
      { name: "maxPrintAge", type: "uint32" },
      { name: "upperBandBps", type: "uint16" },
      { name: "lowerBandBps", type: "uint16" },
      { name: "workingShareBps", type: "uint16" },
      { name: "bufferHours", type: "uint32" },
      { name: "minTicketUsdc", type: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "agentOf",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "exists", type: "bool" },
      { name: "dailyCapUsdc", type: "uint256" },
      { name: "spent", type: "uint256" },
      { name: "perRequestUsdc", type: "uint256" },
      { name: "periodStart", type: "uint64" },
      { name: "frozen", type: "bool" },
      { name: "guest", type: "bool" },
    ],
    stateMutability: "view",
  },
  { type: "function", name: "remaining", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "guestDailyCap", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "classify",
    inputs: [
      {
        name: "r",
        type: "tuple",
        components: [
          { name: "agentId", type: "bytes32" },
          { name: "seller", type: "address" },
          { name: "index", type: "bytes32" },
          { name: "units", type: "uint256" },
          { name: "quoteTotal", type: "uint256" },
          { name: "printId", type: "uint64" },
          { name: "nonce", type: "bytes32" },
        ],
      },
    ],
    outputs: [
      { name: "reason", type: "string" },
      { name: "code", type: "uint8" },
      { name: "fairUsdc", type: "uint256" },
      { name: "pid", type: "uint64" },
    ],
    stateMutability: "view",
  },
  /* The two events a tape renders. Both carry `index` AND the recomputed
     `fair`, so a refusal can name what was being bought and show the price it
     should have been — which is the whole value of refusing an overcharge
     rather than merely blocking it.

     `premiumBps` is `int256`, SIGNED. A quote below fair is legal and happens,
     so a reader that treats this as unsigned turns a bargain into an enormous
     overcharge. */
  {
    type: "event",
    name: "Receipt",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "agentId", type: "bytes32", indexed: true },
      { name: "seller", type: "address", indexed: true },
      { name: "index", type: "bytes32", indexed: false },
      { name: "printId", type: "uint64", indexed: false },
      { name: "units", type: "uint256", indexed: false },
      { name: "quote", type: "uint256", indexed: false },
      { name: "fair", type: "uint256", indexed: false },
      { name: "premiumBps", type: "int256", indexed: false },
      { name: "jitFunded", type: "bool", indexed: false },
      { name: "guest", type: "bool", indexed: false },
      { name: "humanApproved", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Denied",
    inputs: [
      { name: "agentId", type: "bytes32", indexed: true },
      { name: "code", type: "uint8", indexed: true },
      { name: "index", type: "bytes32", indexed: false },
      { name: "reason", type: "string", indexed: false },
      { name: "quote", type: "uint256", indexed: false },
      { name: "fair", type: "uint256", indexed: false },
      { name: "nonce", type: "bytes32", indexed: false },
    ],
  },
] as const;

export const STORE_ABI = [
  { type: "function", name: "indexCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "indexAt", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes32" }], stateMutability: "view" },
  { type: "function", name: "indexName", inputs: [{ type: "bytes32" }], outputs: [{ type: "string" }], stateMutability: "view" },
  {
    type: "function",
    name: "latest",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "priceWad", type: "uint256" },
      { name: "printId", type: "uint64" },
      { name: "postedAt", type: "uint64" },
      { name: "ciBps", type: "uint32" },
    ],
    stateMutability: "view",
  },
] as const;

export const SLEEVE_ABI = [
  { type: "function", name: "valueUsdc", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  /* The venue this sleeve earns in, read off the sleeve rather than configured.
     Keeps the "only the vault is configured" rule intact and keeps a venue
     address out of shipping source, which is what `mainnetOnly.test.ts` is for. */
  { type: "function", name: "venue", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  /* The sleeve's whole cash history, and the only way to recover a cost basis.
     `Parked` is what went in; `Pulled` carries BOTH what was asked for and what
     the treasury's balance actually moved by, because a venue may deliver less
     than it was asked for and the event records the gap rather than hiding it.

     BOTH ARE ENTIRELY NON-INDEXED. topic0 is the only topic, so a query must be
     addressed to the sleeve: these are emitted by the sleeve, not the vault, and
     filtering by the vault's address matches nothing. */
  {
    type: "event",
    name: "Parked",
    inputs: [{ name: "usdcAmount", type: "uint256", indexed: false }],
  },
  {
    type: "event",
    name: "Pulled",
    inputs: [
      { name: "usdcRequested", type: "uint256", indexed: false },
      { name: "usdcDelivered", type: "uint256", indexed: false },
    ],
  },
] as const;

/* THE VENUE ITSELF, and the two questions the yield panel could not ask.
 *
 * WHAT WE EARNED IS BACKWARD-LOOKING. `readYield` answers it exactly, from the
 * sleeve's own events. It says nothing about what we are TRUSTING in order to
 * get the money back, and the sleeve meter now animates a pull out of this
 * venue on demand — so the one thing that would check that animation is
 * whether the venue still permits the movement.
 *
 * THE `can*` FORM, NOT `gate == address(0)`. A curator can install a gate that
 * still admits us, which changes nothing we depend on; reading the gate
 * ADDRESS would report a change that is not one, and reading it as a boolean
 * asks the only question that matters. Signatures lifted from
 * `float/app/venue.html`, which is pinned against the live vault by the
 * acceptance suite.
 *
 * THE FEES ARE `uint96` AND SCALED DIFFERENTLY FROM EACH OTHER. The
 * performance fee is a WAD share of interest; the management fee is a WAD rate
 * PER SECOND, so it only means anything multiplied by a year. Mixing them up
 * renders a 2% annual fee as 0.0000000634%, which is a reassuring number and
 * the wrong one. */
export const VENUE_ABI = [
  { type: "function", name: "canReceiveShares", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "canSendShares", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "canReceiveAssets", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "canSendAssets", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "performanceFee", inputs: [], outputs: [{ type: "uint96" }], stateMutability: "view" },
  { type: "function", name: "performanceFeeRecipient", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "managementFee", inputs: [], outputs: [{ type: "uint96" }], stateMutability: "view" },
  { type: "function", name: "managementFeeRecipient", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

/* The Teller's deposit, and only its deposit.
 *
 * THE PERMISSION IS ONLY LEGIBLE BY ATTEMPTING THE THING. There is no allowlist
 * accessor: `maxDeposit(address)` returns a non-zero allowance for an address
 * that cannot deposit at all, measured at 5,723,443 against a deposit that
 * reverts. So this ABI exists to be STATICCALLED and to fail, which is the only
 * honest read of eligibility available.
 *
 * ERC-4626 SHAPED, AND NOT `buy()`. The verified implementation declares no
 * `buy` and no `sell`, whatever `docs/TAMEION.md` used to say; a probe on
 * `buy()` would revert for "no such function" and read as "not permitted".
 * Signature as it was driven with `cast`: `deposit(uint256,address)(uint256)`. */
export const TELLER_ABI = [
  {
    type: "function",
    name: "deposit",
    inputs: [{ type: "uint256" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  /* The three the reserve panel needs to stop asserting its fund and start
     reading it. `symbol` and `decimals` are what `docs/TAMEION.md` recorded, so
     reading them turns a sentence in a markdown file into something a judge can
     check on the page; `totalSupply` is the one number that shows the fund is
     in use rather than merely deployed. */
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  /* The transfer that paid the seller. Matched on `to` and never on position
     or size: a transaction can carry several USDC transfers and the largest is
     not reliably the payment. */
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;
