# Test ACR on Arc mainnet

Written for anyone with a browser wallet and a few dollars of USDC on Base, Ethereum, Arbitrum,
OP Mainnet, Polygon, Avalanche or Unichain. Real money, small amounts: a query costs a fraction of
a cent, and nothing here asks for more than the amount you type.

**Terminal:** https://arc-compute-rate.vercel.app · **Chain:** Arc mainnet, id `5042` ·
**Gas:** USDC (there is no other token on Arc; the wallet shows gas in USDC).

## What you are testing

ACR publishes a reference price for AI compute and sells it per query. You are a human buyer.
The five steps below are the whole revenue path; if any of them stops you, that is the bug.

## The five steps

1. **See the rate.** Open the terminal. The dateline chip says **Arc mainnet** (plain edition:
   *real money*), and the fixing has a time. If the chip says *testnet*, you are on the wrong
   deployment.
2. **Connect.** `/exchange` → open any listing → *connect your wallet to buy*. Your wallet asks
   to add **Arc** (chain 5042, RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`)
   and to switch to it. Approve both.
3. **Fund.** Under the listing, a line shows *wallet … USDC · Gateway … USDC* and exactly one
   next action:
   - **No USDC on Arc** → *Bring USDC from Base →* (pick the chain you hold it on, type an
     amount, press). You sign twice on that chain (approve, burn); then wait. Circle attests and
     the USDC is minted to the same address on Arc. Standard CCTP takes up to ~15 minutes;
     the row lists each step with an explorer link.
   - **USDC on Arc, none in Gateway** → *Deposit to Gateway* (plain: *Move it to
     ready-to-spend*). Two signatures on Arc; the balance appears after finality.
4. **Buy.** *buy with your wallet · $0.00…*. Your wallet signs one message (no transaction).
   The listing answers, a toast shows the amount, and a row lands on the tape.
5. **Check the receipt.** `/api/marketplace/receipts` on the terminal lists your purchase;
   `/api/revenue` moved by the listing's price. The explorer link on the row resolves.

Optional: the **Desk** on `/curve` gives you a Circle wallet (email + PIN, no extension) that
trades the futures venue and can buy a **feed pass** for a day of reads. Fund it by sending USDC
on Arc to the address it shows.

## What to report

Open an issue with the *Mainnet test* template, or reply in the community thread. Please include:

- the step number where it stopped, and the sentence the page showed (every failure is a
  sentence; if you got a raw code or a blank, that is itself a bug);
- your wallet (MetaMask, Rabby, …) and which chain you bridged from, if you did;
- the transaction hash or explorer link, when there is one;
- whether the plain edition (top-right toggle) made the step clearer or worse.

You do not need to include your address; the receipt is public anyway.

## Known limits, stated up front

- The **house buyer** is off on mainnet: nothing here spends our USDC on your click, so every
  purchase is from your wallet.
- **Bridging is slow** on standard CCTP (minutes, not seconds) and needs gas on the source chain
  in that chain's native token.
- **Gas on Arc is USDC.** Keep a few cents in the wallet itself, not only in Gateway.
- **Your Gateway balance goes down a few minutes after the purchase, not instantly.** Circle
  batches nanopayments; we measured about nine minutes on testnet. The data arrives immediately
  and the receipt is real from the moment it appears, so do not buy twice thinking it failed.
- The venue on mainnet is new and thin. A quote may be wide; that is the book, not a bug.
- **Transaction-cost analysis (`/tca/…`) is not answering yet on mainnet.** It is computed inside
  the subgraph, and the mainnet subgraph is not deployed, so the endpoint says
  `{"available": false, "reason": "ACR_SUBGRAPH_URL is unset"}` rather than inventing a number.
  Everything else on this page works without it.
- If the dateline says *archived* rather than *live*, the press is between prints; reads still
  work, and a purchase settles against the archived rate.

## What we will never ask for

A seed phrase, a private key, an approval for an unlimited amount, or a signature you did not
initiate from a button on the page. If a prompt asks for any of those, close it and report it.
