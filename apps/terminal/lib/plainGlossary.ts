/* The plain-language dictionary — pure data, no JSX, so node:test can import
   it. Distilled from docs/GLOSSARY.md (the CI-enforced canonical glossary);
   /companion renders it in full, <Term k="…"> serves one entry as a footnote.
   House style: one line, an everyday analogy, ≤140 characters, no jargon
   inside a gloss. Adding a key here is what makes it legal in <Term>. */

export type GlossaryTheme = "money" | "statistics" | "blockchain" | "this paper";

export interface PlainTerm {
  /** Display name, as the footnote header and companion entry title. */
  term: string;
  /** The one-line plain meaning with its everyday analogy. */
  gloss: string;
  theme: GlossaryTheme;
}

export const PLAIN_GLOSSARY = {
  /* ---- money ---- */
  usdc: {
    term: "USDC",
    gloss: "a digital dollar — a coin built to always be worth exactly $1",
    theme: "money",
  },
  nanopayment: {
    term: "nanopayment",
    gloss: "a payment of a fraction of a cent — too small for card fees, easy for software",
    theme: "money",
  },
  x402: {
    term: "x402",
    gloss: "a web turnstile: the server says “payment required”, the software drops a coin, the page opens",
    theme: "money",
  },
  eip3009: {
    term: "signed check",
    gloss: "paying by handing over a signed authorization — like a check — instead of moving cash yourself",
    theme: "money",
  },
  gateway: {
    term: "Gateway",
    gloss: "Circle’s clearing house — it pools deposits and settles many tiny payments in batches",
    theme: "money",
  },
  "gas-usdc": {
    term: "fees in dollars",
    gloss: "this network charges its fees in the same dollars you already carry — no second token needed",
    theme: "money",
  },
  "market-maker": {
    term: "dealer",
    gloss: "the exchange booth that always quotes both a buy and a sell price, earning the small gap",
    theme: "money",
  },
  tenor: {
    term: "weeks out",
    gloss: "how far in the future a contract runs — week one, week two, and so on",
    theme: "money",
  },
  "cash-settled": {
    term: "cash-settled",
    gloss: "no goods change hands at the end — the contract simply pays out the price difference in cash",
    theme: "money",
  },
  basis: {
    term: "the gap",
    gloss: "how far a trade sits from the official rate — the market's opinion of where that rate is heading",
    theme: "money",
  },
  mark: {
    term: "the running price",
    gloss: "the price everyone is settled up at right now — the score at half-time, not the final whistle",
    theme: "money",
  },

  /* ---- statistics ---- */
  vwap: {
    term: "plain average (VWAP)",
    gloss: "a size-weighted average — one staged $10M sale drags it wherever the faker wants",
    theme: "statistics",
  },
  "trimmed-median": {
    term: "trimmed middle",
    gloss: "Olympic scoring: throw out the wildest judges on both ends, keep the middle",
    theme: "statistics",
  },
  ci: {
    term: "wiggle room",
    gloss: "the honest give-or-take range around an estimate — where the true number almost surely sits",
    theme: "statistics",
  },
  bp: {
    term: "basis point (bp)",
    gloss: "one hundredth of one percent — a penny on a hundred dollars",
    theme: "statistics",
  },
  hedonic: {
    term: "like-for-like",
    gloss: "strip quality differences first, so a studio and a penthouse compare fairly",
    theme: "statistics",
  },
  deconvolution: {
    term: "un-blurring",
    gloss: "undoing the smear that batching puts on timing — like sharpening a long-exposure photo",
    theme: "statistics",
  },
  vol: {
    term: "jumpiness",
    gloss: "how much the price has been bouncing around, restated as a yearly figure",
    theme: "statistics",
  },
  exhaust: {
    term: "payment exhaust",
    gloss: "the stream of real payments machines leave behind as they trade — our raw material",
    theme: "statistics",
  },
  "attack-cost": {
    term: "the bill for cheating",
    gloss: "the literal dollars a cheat must burn to bend this rate — computed and published every hour",
    theme: "statistics",
  },

  /* ---- blockchain ---- */
  "on-chain": {
    term: "on-chain",
    gloss: "recorded on the blockchain — a public ledger nobody can quietly edit",
    theme: "blockchain",
  },
  oracle: {
    term: "oracle",
    gloss: "the public scoreboard contract that other programs read and trust to settle money",
    theme: "blockchain",
  },
  keeper: {
    term: "the keeper",
    gloss: "our unattended bot that keeps the market open — it trades a little each hour and starts the next contract when one ends",
    theme: "blockchain",
  },
  "feed-access": {
    term: "feed access",
    gloss: "paying for data buys you a right recorded on the public ledger, not just a note in our own files",
    theme: "blockchain",
  },
  finality: {
    term: "final in under a second",
    gloss: "confirmed for good in under a second — the whistle blows, the goal counts, no replays",
    theme: "blockchain",
  },
  eip712: {
    term: "verifiable signature",
    gloss: "a standard notarized form — data signed so anyone can check exactly who signed it",
    theme: "blockchain",
  },
  attestation: {
    term: "sworn record",
    gloss: "a seller’s signed, public, on-chain statement of exactly what they sell",
    theme: "blockchain",
  },
  "wash-trade": {
    term: "fake trade",
    gloss: "selling your car to yourself to fake a hot market — volume with no real economics",
    theme: "blockchain",
  },
  sybil: {
    term: "sock-puppets",
    gloss: "one troll wearing a hundred accounts that all look independent — until you trace the money",
    theme: "blockchain",
  },
  "settlement-grade": {
    term: "settlement-grade",
    gloss: "trustworthy enough that contracts settle real money against it",
    theme: "blockchain",
  },
  relayer: {
    term: "courier",
    gloss: "whoever posts a signed message on-chain — the signature is what counts, not the courier",
    theme: "blockchain",
  },

  /* ---- this paper ---- */
  fixing: {
    term: "the fixing",
    gloss: "the hour’s official price-setting — an old exchange word for publishing the day’s rate",
    theme: "this paper",
  },
  print: {
    term: "print",
    gloss: "one published rate: the number, its give-or-take range, and the bill for bending it",
    theme: "this paper",
  },
  sofr: {
    term: "SOFR",
    gloss: "the benchmark rate US loans settle on — ACR is the same idea, but for machine work",
    theme: "this paper",
  },
  "the-press": {
    term: "the press",
    gloss: "our live server, which sets this paper’s type — it naps between visits to save money",
    theme: "this paper",
  },
  provenance: {
    term: "paper trail",
    gloss: "which contract, which signer, which transaction a number came from — all checkable",
    theme: "this paper",
  },
} satisfies Record<string, PlainTerm>;

export type TermKey = keyof typeof PLAIN_GLOSSARY;

export const GLOSSARY_THEMES: GlossaryTheme[] = [
  "this paper",
  "money",
  "statistics",
  "blockchain",
];

/* The front page's plain-only rail: the whole story in six beats, no term
   of art anywhere. Rendered by components/PlainPrimer.tsx. */
export interface PrimerBeat {
  head: string;
  body: string;
}

export const PRIMER_BEATS: PrimerBeat[] = [
  {
    head: "The problem",
    body: "Machines now buy AI work from machines, but there is no trustworthy going rate — and a fake one is cheap to stage.",
  },
  {
    head: "The estimate",
    body: "ACR reads every payment on the Arc network — noisy, salted with fakes — and works out the honest rate; that is the big number above.",
  },
  {
    head: "The print",
    body: "Once an hour the rate is signed and posted to a public scoreboard on the blockchain, where contracts settle real money against it.",
  },
  {
    head: "The money",
    body: "Software pays a fraction of a cent per question, automatically — no accounts, no keys, the payment rides in the web request.",
  },
  {
    head: "The bill for cheating",
    body: "Fakes get filtered, extremes get ignored — and every rate ships with the literal dollar cost of bending it 0.01%: cheating is priced.",
  },
  {
    head: "The desk",
    body: "Make a PIN-protected wallet, take 50 cents of our test money, place a real trade against our own bot, and take it back any time.",
  },
];
