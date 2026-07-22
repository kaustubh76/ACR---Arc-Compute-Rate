.PHONY: help setup test test-py test-contracts test-agent pipeline demo eval eval-gate ci snapshot api terminal agent agent-live interop build-contracts anvil onchain deploy-testnet-dry deploy-testnet verify-testnet post-once lint glossary-check diagram diagram-preview clean circle-check circle-login circle-wallet circle-fund circle-deposit circle-balance skills-install

help:
	@echo "ACR — The Arc Compute Rate"
	@echo ""
	@echo "  make setup           install python + node + foundry deps"
	@echo "  make test            run everything (python + contracts + agent)"
	@echo "  make pipeline        run the estimator on simulated exhaust (live prints)"
	@echo "  make demo            run the 'Attack the Index' demo"
	@echo "  make eval            produce the ACR-vs-VWAP error chart data"
	@echo "  make eval-gate       assert the headline resistance claims (CI gate)"
	@echo "  make ci              lint + tests + contracts + eval gate"
	@echo "  make snapshot        regenerate the Terminal's bundled snapshot"
	@echo "  make anvil           run a local anvil chain (:8545)"
	@echo "  make onchain         deploy + post prints on-chain + settle (needs anvil)"
	@echo ""
	@echo "  Arc testnet (docs/TESTNET_RUNBOOK.md is the ordered operator sequence):"
	@echo "  make deploy-testnet-dry  simulate the Foundry deploy against Arc testnet (no broadcast)"
	@echo "  make deploy-testnet  deploy ACROracle + AttestationRegistry to Arc testnet"
	@echo "  make verify-testnet  read-only checks: chain id, code, signer, latest prints"
	@echo "  make post-once       one estimator cycle → signed postPrint txs on Arc"
	@echo "  make api             serve the x402-gated index API (:8000)"
	@echo "  make terminal        run the ACR Terminal (:3000)"
	@echo "  make lint            ruff check the python packages"
	@echo ""
	@echo "  buyer agent (apps/agent — the machine side of the marketplace):"
	@echo "  make agent           offline demo: discover the catalog, pay the dev gate"
	@echo "                       (run ACR_X402_MODE=dev make api in another shell)"
	@echo "  make agent-live      Arc testnet: real Gateway x402 settlement"
	@echo "                       (needs AGENT_PRIVATE_KEY + a Gateway deposit — see docs/agent-runbook.md)"
	@echo "  make interop         check our 402 parses the way GatewayClient does (needs make api)"
	@echo ""
	@echo "  live wallet ops (interactive Circle CLI — never run in CI):"
	@echo "  make circle-check    verify the Circle CLI is installed"
	@echo "  make circle-login    EMAIL=you@example.com — email-OTP login (testnet)"
	@echo "  make circle-wallet   create a local EOA wallet (GatewayClient needs a raw key)"
	@echo "  make circle-fund     testnet faucet into the wallet"
	@echo "  make circle-deposit  deposit USDC into Gateway (min 0.5) for nanopayments"
	@echo "  make circle-balance  wallet + Gateway balances"
	@echo "  make skills-install  install Circle Skills into .claude/skills"

setup:
	uv sync --all-packages
	cd contracts && forge install --no-git foundry-rs/forge-std || true
	cd apps/terminal && npm install --no-audit --no-fund
	cd apps/agent && npm install --no-audit --no-fund

test: test-py test-contracts test-agent

test-py:
	uv run pytest packages services tests -q -p no:cacheprovider --import-mode=importlib

test-contracts:
	cd contracts && forge test

test-agent:
	cd apps/agent && npm run build && npm test

eval-gate:
	uv run python scripts/eval.py --hours 12 --check

ci: lint test eval-gate

build-contracts:
	cd contracts && forge build

anvil:
	anvil

onchain: build-contracts
	uv run python scripts/onchain_demo.py

# --- Arc testnet deploy (Foundry; docs/TESTNET_RUNBOOK.md is the full sequence) ---
# Gas on Arc IS USDC (native system contract 0x3600…0000) — fund the deployer at
# https://faucet.circle.com (Arc Testnet) before broadcasting.
# If EIP-1559 fee estimation fails on Arc, retry the forge script with --legacy.

ACR_ARC_RPC_URL ?= https://rpc.testnet.arc.network

deploy-testnet-dry:
	@test -n "$(DEPLOYER_PRIVATE_KEY)" || { echo "DEPLOYER_PRIVATE_KEY not set — export the funded deployer key first (docs/TESTNET_RUNBOOK.md step 2)"; exit 1; }
	cd contracts && forge script script/Deploy.s.sol --rpc-url $(ACR_ARC_RPC_URL) --private-key $(DEPLOYER_PRIVATE_KEY)

deploy-testnet:
	@test -n "$(DEPLOYER_PRIVATE_KEY)" || { echo "DEPLOYER_PRIVATE_KEY not set — export the funded deployer key first (docs/TESTNET_RUNBOOK.md step 2)"; exit 1; }
	cd contracts && forge script script/Deploy.s.sol --rpc-url $(ACR_ARC_RPC_URL) --private-key $(DEPLOYER_PRIVATE_KEY) --broadcast
	@echo ""
	@echo "  contracts live — code shows at https://testnet.arcscan.app/address/<ACROracle> (+ <AttestationRegistry>)"
	@echo "  now set in .env (value on the SAME line as '=', NO inline comments):"
	@echo "    ACR_ORACLE_ADDRESS=0x<ACROracle address from the log above>"
	@echo "    ACR_REGISTRY_ADDRESS=0x<AttestationRegistry address from the log above>"
	@echo "  then: make verify-testnet"

verify-testnet:
	uv run python scripts/verify_deploy.py

post-once:
	uv run python scripts/post_once.py

pipeline:
	uv run python scripts/run_pipeline.py --events 3000

demo:
	uv run python scripts/run_demo.py

eval:
	uv run python scripts/eval.py --hours 12

snapshot:
	uv run python scripts/gen_snapshot.py

api:
	uv run uvicorn index_api.app:app --host 127.0.0.1 --port 8000 --reload

terminal:
	cd apps/terminal && npm run dev

# --- buyer agent (apps/agent) ---

agent:
	cd apps/agent && npm run start -- --dev --count 20 --discover

agent-live:
	cd apps/agent && npm run start -- --live --count 60 --limit 0.01 --discover

interop:
	cd apps/agent && npm run interop

# --- live wallet ops (interactive — Circle CLI; email OTP, so never in CI) ---
# Install: npm install -g @circle-fin/cli   (Node >= 20.18.2)
# The buyer agent signs EIP-3009 itself, so it needs a raw EOA key: create the
# wallet with --type local (agent-type wallets are Circle-custodied, no export).
# Flag names current as of July 2026 — `circle <resource> --help` if they drift.

circle-check:
	@command -v circle >/dev/null 2>&1 || { echo "Circle CLI not found — npm install -g @circle-fin/cli (Node >= 20.18.2)"; exit 1; }
	@circle --version

circle-login: circle-check
	@test -n "$(EMAIL)" || { echo "usage: make circle-login EMAIL=you@example.com"; exit 1; }
	circle wallet login $(EMAIL) --testnet

circle-wallet: circle-check
	circle wallet create --type local

circle-fund: circle-check
	circle wallet fund

circle-deposit: circle-check
	circle gateway deposit --amount 0.5

circle-balance: circle-check
	circle wallet balance
	circle gateway balance

skills-install: circle-check
	circle skill install --tool claude-code

lint: glossary-check
	uv run ruff check packages services scripts redteam

glossary-check:
	uv run python scripts/check_glossary_coverage.py

diagram:
	uv run python scripts/gen_architecture.py

diagram-preview:
	uv run python scripts/preview_excalidraw.py

clean:
	rm -rf .venv contracts/out contracts/cache apps/terminal/.next apps/agent/node_modules scripts/_out
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
