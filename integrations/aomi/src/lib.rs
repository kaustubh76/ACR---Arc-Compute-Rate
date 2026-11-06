//! ACR research and owner-authorized treasury payment inbox.

mod client;
mod tool;
mod treasury;

use aomi_sdk::{Secret, dyn_aomi_app};

/// The App value the runtime builds once per chat session. Stateless: the HTTP
/// client is a process-wide static in `client.rs`, so a session costs nothing.
#[derive(Clone, Default)]
pub struct AcrApp;

const PREAMBLE: &str = "You can read ACR (Arc Compute Rate). ACR publishes an on-chain reference index for machine \
compute (AI inference, GPU time, data delivery) from an oracle on Arc, and it checks what agents and wallets actually pay \
against real, cited public market prices.

Which tool:
- What is ACR's index print, how fresh is it, how costly is it to manipulate? -> acr_rate (ACR-INF per 1k tokens, \
ACR-GPU per GPU-second, ACR-DATA per MB). These are index levels on ACR's own nominal scale, NOT market prices.
- Is this bill, invoice or price fair, and should it be paid? -> acr_check_bill. Pass the TOTAL billed and the \
quantity in the unit (23 for 23,000 tokens at \"$/1k tokens\"). Leave vendor out for any third-party provider.
- Is this wallet or agent overpaying, and where should it buy instead? -> acr_wallet_cost.
- Is this seller trustworthy or fairly priced? -> acr_seller_rating.
- Did a payment to ACR land? -> acr_receipts.
- Inspect a deployed contract or treasury state? -> use get_contract, encode_and_call, and get_erc20_balance on the requested chain. Read owner(), paused(), usdc(), budgetOf(bytes32), and remaining(bytes32) as needed; derive category IDs from the documented category, never guess.

Rules you must keep:
- Never quote an acr_rate value as what compute costs. For what the market actually charges, use acr_check_bill, which \
compares against cited public prices.
- Always say how old a rate is. If acr_rate returns current: false, call it the last known value, never today's price.
- Always say what a bill was compared against. If priced_against is \"fleet\" or priced is false, do NOT present it as \
a market verdict: relay the hint and, if it says so, call acr_check_bill again without vendor.
- A wallet with seen: false has no purchases on ACR's tape. Never report that as zero spend.
- Verdicts are suggestions, not promises, and compare against published list prices, not the user's contract.
- Quote the cheapest seller by its label and cite its source when you recommend switching.
- Contract reads must actually run before reporting ownership, balances, budgets, or payment readiness. If a read fails or tools are unavailable, state the limitation; never infer chain state from a bill API response or promise an inspection without doing it.
- Read access does not authorize spending. Use the evm-core host tools to read contracts and stage, simulate, and commit only the configured treasury payment. Activate acr-compute-rate/treasury, prepare the exact logged obligation, simulate successfully, obtain explicit owner authorization, then verify the receipt. Never bypass preparation or use arbitrary transfers.
- The five research tools do not move funds. For a business payment inbox, activate acr-compute-rate/treasury. Its tools prepare unsigned owner payments and verify receipts; follow its review and authorization workflow.";

dyn_aomi_app!(
    app = AcrApp,
    name = "acr-compute-rate",
    version = "0.2.0",
    preamble = PREAMBLE,
    tools = [tool::RateTool, tool::CheckBillTool, tool::WalletCostTool,
             tool::SellerRatingTool, tool::ReceiptsTool],
    secrets = [
        Secret::new("ACR_API", "Optional research API override.", false),
        Secret::new("ACR_TREASURY_API_TOKEN", "Business-scoped treasury API credential. Never an operations or signing key.", true)
    ],
    namespaces = ["evm-core"],
    skills = [{
        id: "acr-compute-rate/treasury",
        description: "Review escalated compute bills and pay through the business owner's PolicyWallet",
        tags: ["treasury", "bills", "payment"],
        tools: [treasury::PendingPayments, treasury::PreparePayment, treasury::VerifyPayment],
        sections: {
            instructions: "skill/instructions.md",
            workflows: "skill/workflows.md",
            action_rules: "skill/action-rules.md",
            safety: "skill/safety.md"
        },
        guard: concat!(env!("OUT_DIR"), "/treasury-guard.json")
    }]
);

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// The `aomi-sdk = "…"` requirement in a Cargo.toml.
    fn sdk_pin(manifest: &str) -> Option<String> {
        manifest
            .lines()
            .find(|l| l.trim_start().starts_with("aomi-sdk"))
            .and_then(|l| l.split('"').nth(1))
            .map(str::to_string)
    }

    /// Aomi's deploy gate reads the pin from the repo-root Cargo.toml; Aomi's
    /// builder compiles this folder with its own. If they drift, the gate passes
    /// a commit whose App was built against another SDK, and the backend refuses
    /// to load it long after the deploy said yes.
    #[test]
    fn the_pin_aomi_checks_is_the_pin_this_app_builds_with() {
        let here = sdk_pin(include_str!("../Cargo.toml")).expect("this App pins aomi-sdk");
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        if !repo.join(".aomi/config.json").is_file() {
            return; // staged on its own by Aomi's builder: there is no repo root to agree with
        }
        let root = std::fs::read_to_string(repo.join("Cargo.toml"))
            .expect("the ACR repo root needs the Cargo.toml Aomi's deploy gate reads");
        assert_eq!(
            sdk_pin(&root).as_deref(),
            Some(here.as_str()),
            "root pin ≠ App pin"
        );
        assert!(
            here.starts_with('='),
            "Aomi loads only an exact SDK pin, got {here}"
        );
    }

    /// Aomi's platform build walks up from this folder to the first Cargo.toml
    /// holding a [workspace] table and requires Cargo.lock beside it. The repo
    /// root's Cargo.toml has one and no lock, so without a [workspace] of its
    /// own this App is refused: "commit Cargo.lock at the Cargo workspace root".
    #[test]
    fn this_app_is_the_workspace_root_aomi_finds_with_its_lock_beside_it() {
        let manifest = include_str!("../Cargo.toml");
        assert!(
            manifest.lines().any(|l| l.trim() == "[workspace]"),
            "integrations/aomi/Cargo.toml must declare [workspace]"
        );
        let lock = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock");
        assert!(
            lock.is_file(),
            "Cargo.lock must sit beside this App's Cargo.toml"
        );
    }
}
