use serde_json::{Value, json};
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo::rerun-if-env-changed=ACR_TREASURY_CONFIG");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let path = env::var("ACR_TREASURY_CONFIG").expect(
        "Treasury setup incomplete: set ACR_TREASURY_CONFIG to an enabled deployment JSON before building",
    );
    println!("cargo::rerun-if-changed={path}");
    let config: Value =
        serde_json::from_str(&fs::read_to_string(path).expect("read treasury deployment"))
            .expect("valid treasury deployment JSON");
    assert!(
        config["enabled"] == true,
        "Treasury setup incomplete: enabled must be true"
    );
    let chain = config["chain_id"]
        .as_u64()
        .expect("replace <CHAIN_ID> with a number");
    assert!(chain > 0 && chain < (1 << 53), "valid chain id required");
    for key in ["policy_wallet", "usdc"] {
        let a = config[key].as_str().expect("address required");
        assert!(
            a.len() == 42
                && a.starts_with("0x")
                && a[2..].bytes().all(|b| b.is_ascii_hexdigit())
                && a[2..].bytes().any(|b| b != b'0'),
            "replace {key} with a nonzero address"
        );
    }
    let b = config["business"].as_str().expect("business required");
    assert!(
        !b.is_empty()
            && b.len() <= 64
            && b.bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'),
        "valid business slug required"
    );
    let url = config["api_url"].as_str().expect("API URL required");
    let url = reqwest::Url::parse(url).expect("valid API URL");
    assert!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/"
            && (url.scheme() == "https"
                || (url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost")))),
        "HTTPS origin or local test origin required"
    );
    fs::write(
        out.join("treasury-guard.json"),
        json!({"evm": {
            "chain_ids": [chain], "contracts": {"TREASURY": config["policy_wallet"]},
            "selectors": {"PAY": "spendAsOwner(bytes32,address,uint256,bytes32)"},
            "allowed_contracts": ["TREASURY"], "allowed_selectors": ["PAY"]
        }})
        .to_string(),
    )
    .unwrap();
    fs::write(out.join("treasury-deployment.json"), config.to_string()).unwrap();
}
