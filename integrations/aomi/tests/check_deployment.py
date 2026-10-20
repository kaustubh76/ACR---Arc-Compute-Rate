"""Build gate regressions and unit tests using disposable local-only configuration."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

APP = Path(__file__).resolve().parents[1]
env = dict(os.environ)
env.pop("ACR_TREASURY_CONFIG", None)
# No operator deployment or signing credentials are required by this suite.
fixture = {
    "enabled": True,
    "business": "local-test",
    "chain_id": 31337,
    "policy_wallet": "0x" + "11" * 20,
    "usdc": "0x" + "22" * 20,
    "api_url": "http://127.0.0.1",
}


def rejected(label, expected):
    result = subprocess.run(
        ["cargo", "check", "--locked"], cwd=APP, env=env,
        text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    assert result.returncode != 0 and expected in result.stdout, (
        f"{label}: expected configuration rejection\n{result.stdout}"
    )
    print(f"PASS: {label}", flush=True)


rejected("missing configuration", "Treasury setup incomplete")
with tempfile.TemporaryDirectory(prefix="acr-deployment-test-") as folder:
    config = Path(folder) / "deployment.json"
    env["ACR_TREASURY_CONFIG"] = str(config)
    cases = [
        ("disabled", {**fixture, "enabled": False}, "enabled must be true"),
        ("placeholders", json.loads((APP / "treasury-deployment.example.json").read_text())
         | {"enabled": True}, "replace <CHAIN_ID>"),
        ("zero wallet", {**fixture, "policy_wallet": "0x" + "0" * 40}, "nonzero address"),
        ("zero token", {**fixture, "usdc": "0x" + "0" * 40}, "nonzero address"),
        ("zero chain", {**fixture, "chain_id": 0}, "valid chain id"),
        ("invalid business", {**fixture, "business": "../other"}, "valid business slug"),
        ("insecure API", {**fixture, "api_url": "http://example.com"}, "HTTPS origin"),
    ]
    for label, value, expected in cases:
        config.write_text(json.dumps(value))
        rejected(label, expected)
    config.write_text(json.dumps(fixture))
    subprocess.run(["cargo", "test", "--locked"], cwd=APP, env=env, check=True)
    # This artifact belongs only to this test fixture, never to a release.
