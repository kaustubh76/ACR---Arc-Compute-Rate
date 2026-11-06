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
] as const;

export const ERC20_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;
