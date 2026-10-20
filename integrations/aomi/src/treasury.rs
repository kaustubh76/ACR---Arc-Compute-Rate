//! Deployment-bound treasury tools. No caller-controlled wallet, business or API origin.
use crate::AcrApp;
use aomi_sdk::{DynAomiTool, DynToolCallCtx, RouteStep, ToolReturn, resolve_secret_value};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{sync::OnceLock, time::Duration};

#[derive(Deserialize)]
pub struct Deployment {
    pub enabled: bool,
    #[serde(default)]
    pub business: String,
    #[serde(default)]
    pub chain_id: u64,
    #[serde(default)]
    pub policy_wallet: String,
    #[serde(default)]
    pub usdc: String,
    #[serde(default)]
    pub api_url: String,
}

fn deployment() -> Result<Deployment, String> {
    let value: Value = serde_json::from_str(include_str!(concat!(
        env!("OUT_DIR"),
        "/treasury-deployment.json"
    )))
    .unwrap();
    if value["enabled"] != true {
        return Err(
            "Treasury payments are not configured. Research tools remain available.".into(),
        );
    }
    serde_json::from_value(value).map_err(|_| "Invalid treasury deployment".into())
}

fn connected(ctx: &DynToolCallCtx, d: &Deployment) -> Result<String, String> {
    if ctx.attribute_u64(&["domain", "evm", "chain_id"]) != Some(d.chain_id) {
        return Err("Connect the owner wallet on the configured treasury network.".into());
    }
    let account = ctx
        .attribute_string(&["domain", "evm", "address"])
        .filter(|a| crate::tool::is_address(a) && a[2..].bytes().any(|b| b != b'0'))
        .ok_or("Connect the actual PolicyWallet owner account; no wallet override is accepted.")?;
    Ok(account)
}

fn request(
    ctx: &DynToolCallCtx,
    d: &Deployment,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let token = resolve_secret_value(ctx, None, "ACR_TREASURY_API_TOKEN", "")
        .map_err(|_| "Configure the business-scoped treasury credential in the app environment.")?;
    static HTTP: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    let http = HTTP.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(45))
            .connect_timeout(Duration::from_secs(10))
            // A redirect must not redirect this private credential or payment operation.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    });
    let url = format!("{}{}", d.api_url.trim_end_matches('/'), path);
    let req = match body {
        Some(b) => http.post(url).json(&b),
        None => http.get(url),
    };
    let response = req.bearer_auth(token).send().map_err(
        |_| "Treasury API unavailable. Retry the read; never resubmit an uncertain payment.",
    )?;
    let status = response.status();
    if !status.is_success() {
        let detail = response
            .json::<Value>()
            .ok()
            .and_then(|v| v["detail"].as_str().map(str::to_owned));
        // Only relay known, static refusals, never arbitrary upstream bodies.
        if let Some(message) = detail.filter(|s| {
            matches!(
                s.as_str(),
                "PolicyWallet is paused"
                    | "Payment exceeds the remaining category budget"
                    | "Treasury has insufficient USDC"
                    | "No budget exists for this category"
                    | "This obligation is already resolved"
                    | "Connect the PolicyWallet owner execution account"
                    | "Connected wallet is on the wrong network"
                    | "This decision is already paid; verify its receipt instead of resubmitting"
                    | "The prepared decision changed; manual reconciliation is required"
                    | "Conflicting records for this obligation; resolve outside the payment inbox"
                    | "Receipt does not contain the exact owner-authorized payment"
                    | "Transaction reverted; no payment recorded"
                    | "Obligation has a different resolution; manual reconciliation required"
                    | "Bill amount must be exact, finite six-decimal USDC"
            )
        }) {
            return Err(message);
        }
        return Err(match status.as_u16() {
            401 | 403 => "Treasury access denied. Check the scoped credential and connected owner.",
            404 => "No recorded obligation or prepared payment was found.",
            409 => "Payment blocked by treasury state. Review the bill, budget, wallet and existing receipts before retrying.",
            422 => "Invalid treasury request; do not change payment details to work around it.",
            _ => "Treasury state unavailable or unconfigured. Do not submit a payment.",
        }.into());
    }
    response
        .json()
        .map_err(|_| "Invalid treasury API response; stop payment preparation.".into())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyArgs {}

impl JsonSchema for EmptyArgs {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "EmptyArgs".into()
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "object", "properties": {}, "required": [],
            "additionalProperties": false
        })
    }
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PrepareArgs {
    /// The exact pending obligation ID. All payment details come from its recorded decision.
    pub obligation_id: String,
}
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VerifyArgs {
    pub obligation_id: String,
    /// Actual broadcast hash returned by the connected wallet, never an invented identifier.
    pub transaction_hash: String,
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 {
        Err("Select a valid pending obligation ID.".into())
    } else {
        Ok(())
    }
}

pub struct PendingPayments;
impl DynAomiTool for PendingPayments {
    type App = AcrApp;
    type Args = EmptyArgs;
    const NAME: &'static str = "acr_pending_payments";
    const DESCRIPTION: &'static str = "List this business's escalated compute bills, recorded evidence and current budget. Recorded comparisons may be stale; missing evidence is unknown. Does not pay.";
    fn run(_: &AcrApp, _: EmptyArgs, ctx: DynToolCallCtx) -> Result<Value, String> {
        let d = deployment()?;
        let result = request(&ctx, &d, "/operator/payments", None)?;
        if result["business"].as_str() != Some(&d.business) {
            return Err("Treasury business binding mismatch.".into());
        }
        Ok(result)
    }
}

pub struct PreparePayment;
impl DynAomiTool for PreparePayment {
    type App = AcrApp;
    type Args = PrepareArgs;
    const NAME: &'static str = "acr_prepare_payment";
    const DESCRIPTION: &'static str = "Prepare an exact unsigned payment for a selected escalated bill. Requires the connected owner on the configured chain. Review the returned payment, stage and simulate it, then obtain explicit owner authorization before commit_txs. Never automatically retry submission.";
    fn run_with_routes(
        _: &AcrApp,
        args: PrepareArgs,
        ctx: DynToolCallCtx,
    ) -> Result<ToolReturn, String> {
        valid_id(&args.obligation_id)?;
        let d = deployment()?;
        let owner = connected(&ctx, &d)?;
        let result = request(
            &ctx,
            &d,
            "/operator/payments/prepare",
            Some(json!({
                "obligation_id": args.obligation_id, "execution_account": owner, "chain_id": d.chain_id
            })),
        )?;
        payment_route(result, &d, &owner, &args.obligation_id)
    }
}

fn payment_route(
    result: Value,
    d: &Deployment,
    owner: &str,
    obligation: &str,
) -> Result<ToolReturn, String> {
    let tx = &result["transaction"];
    let data = tx["data"].as_str().unwrap_or("");
    if !d.enabled
        || result["status"] != "prepared"
        || result["business"] != d.business
        || result["obligation_id"] != obligation
        || result["owner"]
            .as_str()
            .is_none_or(|a| !a.eq_ignore_ascii_case(owner))
        || result["usdc"]
            .as_str()
            .is_none_or(|a| !a.eq_ignore_ascii_case(&d.usdc))
        || tx["chain_id"] != d.chain_id
        || tx["value"] != "0"
        || tx["to"]
            .as_str()
            .is_none_or(|a| !a.eq_ignore_ascii_case(&d.policy_wallet))
        || data.len() != 2 + 8 + 64 * 4
        || !data.starts_with("0x")
        || !data[2..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(
            "Prepared payment does not match this app's deployment and owner; stop.".into(),
        );
    }
    // Decode all four static ABI words so the displayed review cannot diverge
    // from the staged bytes, even if the upstream response is malformed.
    let category = format!("0x{}", &data[10..74]);
    let recipient = format!("0x{}", &data[98..138]);
    let amount = u128::from_str_radix(&data[138..202], 16)
        .map_err(|_| "Payment amount outside supported exact range")?;
    let hash = format!("0x{}", &data[202..266]);
    if !data[..10].eq_ignore_ascii_case(SPEND_SELECTOR)
        || data[74..98].bytes().any(|b| b != b'0')
        || amount == 0
        || result["category"]
            .as_str()
            .is_none_or(|v| !v.eq_ignore_ascii_case(&category))
        || result["recipient"]
            .as_str()
            .is_none_or(|v| !v.eq_ignore_ascii_case(&recipient))
        || result["decision_hash"]
            .as_str()
            .is_none_or(|v| !v.eq_ignore_ascii_case(&hash))
        || result["amount_units"] != amount.to_string()
    {
        return Err("Payment review differs from the encoded transaction; stop.".into());
    }
    let stage = json!({"to": d.policy_wallet, "data": data, "value": "0",
        "description": format!("Pay bill {obligation}: {amount} USDC base units to {recipient}; decision {hash}"),
        "kind": "acr_owner_payment"});
    Ok(ToolReturn::with_route(result, RouteStep::on_return("stage_tx", stage)
        .prompt("Review this exact payment and stage the bytes unchanged. Simulate its returned pending_tx_id. Commit only after successful simulation and explicit owner authorization; then call acr_verify_payment with the wallet's transaction_hash. Never automatically resubmit.")))
}

// keccak256("spendAsOwner(bytes32,address,uint256,bytes32)")[0..4]
const SPEND_SELECTOR: &str = "0x63ea17fd";

pub struct VerifyPayment;
impl DynAomiTool for VerifyPayment {
    type App = AcrApp;
    type Args = VerifyArgs;
    const NAME: &'static str = "acr_verify_payment";
    const DESCRIPTION: &'static str = "Verify an actual transaction receipt and exact PolicyWallet payment, then reconcile the bill. Safe to retry with the same hash. Only status paid is success; pending means wait, never submit again.";
    fn run(_: &AcrApp, args: VerifyArgs, ctx: DynToolCallCtx) -> Result<Value, String> {
        valid_id(&args.obligation_id)?;
        let hash = &args.transaction_hash;
        if hash.len() != 66
            || !hash.starts_with("0x")
            || !hash[2..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(
                "Provide the actual 32-byte transaction hash returned by the wallet.".into(),
            );
        }
        let d = deployment()?;
        request(
            &ctx,
            &d,
            "/operator/payments/verify",
            Some(json!({
                "obligation_id": args.obligation_id, "transaction_hash": hash
            })),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aomi_sdk::{
        DynAomiApp,
        testing::{TestCtxBuilder, run_tool},
    };

    fn fixture() -> (Deployment, Value) {
        let d = Deployment {
            enabled: true,
            business: "business".into(),
            chain_id: 31337,
            policy_wallet: format!("0x{}", "11".repeat(20)),
            api_url: "http://127.0.0.1".into(),
            usdc: format!("0x{}", "55".repeat(20)),
        };
        let data = format!(
            "{SPEND_SELECTOR}{}{}{}{:064x}{}",
            "ab".repeat(32),
            "0".repeat(24),
            "22".repeat(20),
            25000001u64,
            "cd".repeat(32)
        );
        let p = json!({"status": "prepared", "usdc": d.usdc, "business": "business", "obligation_id": "bill-1",
            "owner": format!("0x{}", "33".repeat(20)), "category": format!("0x{}", "ab".repeat(32)),
            "recipient": format!("0x{}", "22".repeat(20)), "amount_units": "25000001",
            "decision_hash": format!("0x{}", "cd".repeat(32)),
            "transaction": {"to": d.policy_wallet, "chain_id": 31337, "value": "0", "data": data}});
        (d, p)
    }

    #[test]
    fn route_stages_exact_payment_without_committing() {
        let (d, p) = fixture();
        let result = payment_route(p.clone(), &d, p["owner"].as_str().unwrap(), "bill-1").unwrap();
        let serialized = serde_json::to_value(result).unwrap();
        assert_eq!(
            serialized["__aomi_tool_routes"].as_array().unwrap().len(),
            1
        );
        let route = serialized["__aomi_tool_routes"][0].to_string();
        assert!(route.contains(p["transaction"]["data"].as_str().unwrap()));
        // The host app_guard checks data as a hex string before stage_tx
        // deserialization. StageTxCalldata supports this raw-string encoding.
        assert!(serialized["__aomi_tool_routes"][0]["args"]["data"].is_string());
        assert!(!route.contains("\"tool\":\"commit_txs\""));
    }

    #[test]
    fn malformed_or_changed_payload_never_gets_a_route() {
        for field in [
            "business",
            "obligation_id",
            "owner",
            "category",
            "recipient",
            "amount_units",
            "decision_hash",
        ] {
            let (d, mut p) = fixture();
            let owner = p["owner"].as_str().unwrap().to_string();
            p[field] = json!("changed");
            assert!(payment_route(p, &d, &owner, "bill-1").is_err(), "{field}");
        }
        for (field, value) in [
            ("chain_id", json!(1)),
            ("value", json!("1")),
            ("to", json!(format!("0x{}", "44".repeat(20)))),
            ("data", json!("0xa9059cbb")),
        ] {
            let (d, mut p) = fixture();
            let owner = p["owner"].as_str().unwrap().to_string();
            p["transaction"][field] = value;
            assert!(payment_route(p, &d, &owner, "bill-1").is_err());
        }
    }

    #[test]
    fn owner_and_chain_come_only_from_host_context() {
        let (d, _) = fixture();
        assert!(connected(&TestCtxBuilder::new("prepare").build(), &d).is_err());
        let ctx = TestCtxBuilder::new("prepare")
            .attribute(
                "domain",
                json!({"evm": {
            "chain_id": d.chain_id, "address": format!("0x{}", "33".repeat(20))}}),
            )
            .build();
        assert!(connected(&ctx, &d).is_ok());
        assert!(
            run_tool::<PreparePayment>(
                &AcrApp,
                json!({"obligation_id": "bill-1", "recipient": "override"}),
                ctx
            )
            .is_err()
        );
    }

    #[test]
    fn every_tool_object_schema_declares_properties() {
        fn check(value: &Value) {
            match value {
                Value::Object(fields) => {
                    if fields.get("type") == Some(&json!("object")) {
                        assert!(
                            fields.get("properties").is_some_and(Value::is_object),
                            "{value}"
                        );
                    }
                    for child in fields.values() {
                        check(child);
                    }
                }
                Value::Array(items) => {
                    for child in items {
                        check(child);
                    }
                }
                _ => {}
            }
        }
        check(&serde_json::to_value(AcrApp.manifest()).unwrap());
    }

    #[test]
    fn treasury_tools_are_skill_owned_and_manifest_validates() {
        let manifest = AcrApp.manifest();
        aomi_sdk::validate_app_skills_with_tools(&manifest.name, &manifest.skills, &manifest.tools)
            .unwrap();
        assert_eq!(manifest.tools.len(), 8);
        assert_eq!(manifest.skills[0].injected_tools.len(), 3);
        let d = deployment().unwrap();
        assert_eq!(manifest.namespaces.unwrap(), ["evm-core"]);
        let guard = serde_json::to_value(manifest.skills[0].guard.as_ref().unwrap()).unwrap();
        assert_eq!(guard["evm"]["chain_ids"], json!([d.chain_id]));
        assert_eq!(guard["evm"]["allowed_contracts"], json!(["TREASURY"]));
        assert_eq!(guard["evm"]["allowed_selectors"], json!(["PAY"]));
        assert_eq!(guard["evm"]["contracts"]["TREASURY"], d.policy_wallet);
        assert_eq!(
            guard["evm"]["selectors"]["PAY"],
            "spendAsOwner(bytes32,address,uint256,bytes32)"
        );
    }
}
