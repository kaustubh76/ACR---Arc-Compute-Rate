# Owner-wallet treasury inbox

The v0.2 app keeps five research tools and adds three skill-owned tools:
`acr_pending_payments`, `acr_prepare_payment(obligation_id)`, and
`acr_verify_payment(obligation_id, transaction_hash)`. Activate
`acr-compute-rate/treasury` to expose them. The business owner reviews a recorded
escalation, sees the exact payment, simulates it, authorizes it in their wallet,
and receives verified settlement tied to the original decision.

```mermaid
sequenceDiagram
    actor Owner
    participant Aomi
    participant API as ACR API
    participant Wallet as PolicyWallet
    Owner->>Aomi: Review pending compute bills
    Aomi->>API: List recorded escalations
    API-->>Aomi: Evidence, age, category budget
    Owner->>Aomi: Prepare selected bill
    Aomi->>API: ID + host-connected account and chain
    API->>Wallet: Check owner, token, pause, budget, balance, consumed hash
    API-->>Aomi: Frozen decision + exact unsigned payment
    Aomi->>Wallet: Simulate staged spendAsOwner
    Aomi-->>Owner: Exact payment review and wallet authorization
    Owner->>Wallet: Authorize and broadcast
    Aomi->>API: Verify actual transaction hash
    API->>Wallet: Canonical finalized receipt + exact Spent event
    API-->>Aomi: Durable ledger resolution; paid
```

## One configured read/write app

The author-supplied deployments and read-only compatibility checks are recorded
in [DEPLOYMENTS.md](DEPLOYMENTS.md). Both existing testnet PolicyWallets fail
the replay-protection interface check; the compatible replacement address is
still unknown. The committed
`treasury-deployment.example.json` has `enabled=false` and explicit
`<CHAIN_ID>`, `<POLICY_WALLET_ADDRESS>`, `<USDC_ADDRESS>` placeholders. An ordinary
build fails until an enabled, valid deployment JSON is supplied. Every successful
build exposes **evm-core**, with the chain, treasury target and spendAsOwner
selector guard generated from that same configuration. There is no unconfigured
or read-only fallback artifact. Do not replace placeholders with zero addresses
or remove guard constraints. The app is private and requires a business-scoped
treasury credential.

The app's deployment binding and guard are generated at build time from the
same JSON the API consumes. They cannot be changed by model arguments or by
`ACR_API` (which remains a research-only override). A configured artifact is
specific to one business; changing business, wallet, network or API origin
requires rebuilding and reviewing that artifact.

## Configuration and release

1. Deploy the updated PolicyWallet and six-decimal USDC token binding on the
   intended test network. This is a new non-proxy contract version; existing
   deployed wallets do not gain replay protection by updating the API. Use a
   fresh wallet, transfer ownership through the two-step flow, configure its
   categories and fund it separately. Wallet administration is outside this app.
2. Copy the example to an access-controlled deployment JSON. Fill every field,
   set `enabled=true`, and retain the exact file as a release input. `api_url`
   must be an HTTPS origin (loopback HTTP is allowed for local testing).
3. Set `ACR_TREASURY_CONFIG` to its absolute path both at app build time and on
   the API server. Set `ACR_TREASURY_RPC_URL`, a separate random
   `ACR_TREASURY_API_TOKEN`, and `ACR_TREASURY_STATE_DIR` on the API. Give only
   the treasury token to this private business's Aomi app environment. Never
   supply an operations token or a signing key. Restrict app access to the
   business's authorized users; the API credential is business-scoped, not
   per-user authentication. Existing per-business statement/audit/ledger exports
   also require this credential when the inbox is configured.
4. Persist the operator log, its archives, and the preparation snapshot directory.
   All API workers must share a filesystem supporting `flock` and atomic rename.
   Run one deployment for this business; do not run independent writers against
   copies of its ledger. The configured business's legacy operator approval and
   rejection actions are disabled. Its automatic operator escalates payments
   into the owner inbox and preserves pending decisions.
5. Build with `cargo build --locked --manifest-path integrations/aomi/Cargo.toml`.
   Missing, disabled or invalid configuration fails the build. Inspect the manifest: exactly
   this chain, treasury target and `spendAsOwner` selector must be guarded.
   Run tests/check_deployment.py to verify rejected configurations and the configured manifest.
   The build runner must receive the JSON file and ACR_TREASURY_CONFIG; runtime
   app secrets alone cannot supply this build input.
6. Bind an interactive owner wallet. The app accepts only the host's connected
   account and chain, never an address override. If an AA provider uses a different
   execution account from the host-reported address, do not substitute an EOA or
   assume equivalence: that integration needs host execution-identity support
   before enabling this app. Require an interactive authorization flow; this
   app does not add a new host-level human-confirmation enforcement primitive.
7. Complete the real testnet acceptance run in Aomi, retain the receipt and
   screenshots of the payment review and confirmed result, then enable use.
   Local plugin tests are not proof of this final deployed boundary.

## API and payment rules

All three routes require `Authorization: Bearer <business-scoped token>`:

- `GET /operator/payments`: recorded pending bills, evidence age and live budget.
- `POST /operator/payments/prepare`: `obligation_id`, `execution_account`, `chain_id`.
  Only the app supplies the last two from host context. No recipient, amount,
  business or wallet override is accepted.
- `POST /operator/payments/verify`: `obligation_id`, `transaction_hash`.
  Returns `paid`, `pending`, or `pending_finality`. Validation failures are
  refusals, not permission to retry the transaction.

Amounts and budgets crossing the payment interface are integer strings in
six-decimal USDC units. Native transaction value is zero. Preparation uses
`spendAsOwner(bytes32,address,uint256,bytes32)`; no ERC-20 approval is needed.
The owner bypasses the **agent's** per-payment threshold, but the category's
period cap still binds. No partial payments, splitting, or automatic budget edits.

The first escalation supplies the canonical decision. A snapshot persists its
exact hash and expected owner before any calldata is returned. Later attempts
cannot replace that record or silently change payment details. The existing
Python decision hash algorithm is reused; the model must not reconstruct JSON.
The Rust app checks that the decoded calldata matches every displayed payment
field before routing it. Raw calldata is sent as a **hex string** in `data`:
this host accepts that form and its pre-dispatch `app_guard` checks it directly.

The contract now consumes each decision hash across all three payment methods,
before token transfer. A failed transfer reverts that consumption and all other
state changes. The hash does not prove invoice truth and does not deduplicate
fraudulent invoices invented with different obligation IDs.

Verification requires the configured chain and contract, a canonical finalized
successful receipt, and one matching `Spent` event with category, recipient,
owner actor, amount, decision hash and owner approval. This works with an inner
smart-account call without assuming the top-level transaction target is the
PolicyWallet. RPCs without a supported `finalized` block tag fail closed.

## Recovery

- Cancelled before signing: nothing is paid or reserved. Review and simulate again.
- Unknown broadcast result: recover the wallet's hash and verify it; do not resubmit.
- Pending finality: poll the same hash.
- Confirmed payment but failed ledger write: retry verification. The transfer
  must never be repeated to repair bookkeeping.
- Concurrent verifications: the obligation lock and existing resolution prevent
  duplicate ledger entries. Concurrent broadcasts of the same decision hash
  cannot both transfer funds.
- Conflicting records or resolutions: stop for manual reconciliation. Do not
  mint a replacement ID or hash to evade the refusal.

Guard tables enforce the chain/target/selector envelope, not invoice arguments,
USD valuation, or human confirmation. The skill describes this boundary rather
than presenting prompt rules as security guarantees. ReceiptMirror and the
research `acr_receipts` tool are not used as treasury settlement evidence.

## Local validation

Install Foundry and `forge-std`, then run from the repository root:

```sh
uv sync --group dev
forge test --root contracts
uv run pytest services/index_api/tests/test_payments.py
ACR_TEST_PLUGIN=1 uv run pytest services/index_api/tests/test_payments.py -k local_plugin
python3 integrations/aomi/tests/check_deployment.py
```

The optional native-plugin test starts an isolated Anvil and HTTP API, compiles a
configured app, calls it through the public C ABI, simulates the returned bytes,
submits from a local unlocked test owner, and verifies the receipt through the
plugin. It uses no external RPC, deployed address, or real wallet key. Local fixture artifacts must never be published as deployment artifacts.
Rebuild from the intended deployment JSON for release. The normal API tests exercise refusals, event mismatches, concurrent
reconciliation, finality and disk-write recovery against actual local contracts.
