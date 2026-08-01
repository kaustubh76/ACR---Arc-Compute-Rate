.PHONY: help setup test test-py test-contracts test-agent test-terminal pipeline demo eval eval-gate ci snapshot api terminal agent agent-live interop build-contracts anvil onchain deploy-testnet-dry deploy-testnet verify-testnet post-once attest-once seed-sellers futures-roll futures-settle futures-withdraw desk-preflight desk-e2e desk-evidence tape-audit lint glossary-check diagram diagram-preview deck clean circle-check circle-login buyer-key circle-wallet circle-fund circle-deposit circle-balance skills-install

help:
	@echo "ACR — The Arc Compute Rate"
	@echo ""
	@echo "  make setup           install python + node + foundry deps"
	@echo "  make test            run everything (python + contracts + agent + terminal)"
	@echo "  make pipeline        run the estimator on simulated exhaust (live prints)"
	@echo "  make demo            run the 'Attack the Index' demo"
	@echo "  make eval            produce the ACR-vs-VWAP error chart data"
	@echo "  make eval-gate       assert the headline resistance claims (CI gate)"
	@echo "  make ci              lint + full test suite + eval gate (mirrors GitHub CI)"
	@echo "  make snapshot        regenerate the Terminal's bundled snapshot"
	@echo "  make deck            render the submission slide deck (docs/presentation.html + .pdf)"
	@echo "  make anvil           run a local anvil chain (:8545)"
	@echo "  make onchain         deploy + post prints on-chain + settle (needs anvil)"
	@echo ""
	@echo "  Arc testnet (docs/TESTNET_RUNBOOK.md is the ordered operator sequence):"
	@echo "  make deploy-testnet-dry  simulate the Foundry deploy against Arc testnet (no broadcast)"
	@echo "  make deploy-testnet  deploy ACROracle + AttestationRegistry to Arc testnet"
	@echo "  make verify-testnet  read-only checks: chain id, code, signer, latest prints"
	@echo "  make post-once       one estimator cycle → signed postPrint txs on Arc"
	@echo "  make attest-once     write the demo sellers' EIP-712 attestations on-chain"
	@echo "  make seed-sellers    tiny USDC transfers so ArcSource sees the attested sellers"
	@echo "  make api             serve the x402-gated index API (:8000)"
	@echo "  make terminal        run the ACR Terminal (:3000; ACR_API=<seller url>, ACR_BUYER_PRIVATE_KEY enables the LIVE buyer)"
	@echo "  make lint            ruff check the python packages"
	@echo ""
	@echo "  make futures-roll    open a fresh series before the current one expires (idempotent)"
	@echo "  make futures-settle  cash-settle expired series so collateral can be withdrawn"
	@echo ""
	@echo "  the Public Desk (readers trade ACRFutures with a Circle user-controlled wallet):"
	@echo "  make desk-preflight  read-only gates: series life, margin capacity, custody balance"
	@echo "  make desk-e2e        drive the real browser PIN ceremony end to end (PLAYWRIGHT_DIR=…)"
	@echo "  make desk-evidence   confirm that run on-chain (USER_ID=… adds Circle's fee ledger)"
	@echo "  make tape-audit      measure what REAL Arc settlement flow yields as an index"
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
	@echo "  make buyer-key       generate a testnet buyer EOA (raw key for GatewayClient)"
	@echo "  make circle-wallet   import the buyer key as a local wallet"
	@echo "  make circle-fund     ADDR=0x… — testnet faucet into the wallet"
	@echo "  make circle-deposit  ADDR=0x… — deposit USDC into Gateway (min 0.5)"
	@echo "  make circle-balance  ADDR=0x… — wallet + Gateway balances"
	@echo "  make skills-install  install Circle Skills into .claude/skills"

setup:
	uv sync --all-packages
	cd contracts && forge install --no-git foundry-rs/forge-std || true
	cd apps/terminal && npm install --no-audit --no-fund
	cd apps/agent && npm install --no-audit --no-fund

test: test-py test-contracts test-agent test-terminal

test-py:
	uv run pytest packages services tests -q -p no:cacheprovider --import-mode=importlib

test-contracts:
	cd contracts && forge test

test-agent:
	cd apps/agent && npm run build && npm test

test-terminal:
	cd apps/terminal && npm test && npm run build

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

# Deploy ONLY ACRFutures against the already-deployed oracle (never redeploys it).
# Requires ACR_ORACLE_ADDRESS (the live oracle) + DEPLOYER_PRIVATE_KEY (funded).
deploy-futures-dry:
	@test -n "$(DEPLOYER_PRIVATE_KEY)" || { echo "DEPLOYER_PRIVATE_KEY not set — export the funded deployer key first"; exit 1; }
	@test -n "$(ACR_ORACLE_ADDRESS)" || { echo "ACR_ORACLE_ADDRESS not set — export the live oracle address first"; exit 1; }
	cd contracts && forge script script/DeployFutures.s.sol --rpc-url $(ACR_ARC_RPC_URL) --private-key $(DEPLOYER_PRIVATE_KEY)

deploy-futures:
	@test -n "$(DEPLOYER_PRIVATE_KEY)" || { echo "DEPLOYER_PRIVATE_KEY not set — export the funded deployer key first"; exit 1; }
	@test -n "$(ACR_ORACLE_ADDRESS)" || { echo "ACR_ORACLE_ADDRESS not set — export the live oracle address first"; exit 1; }
	cd contracts && forge script script/DeployFutures.s.sol --rpc-url $(ACR_ARC_RPC_URL) --private-key $(DEPLOYER_PRIVATE_KEY) --broadcast
	@echo ""
	@echo "  ACRFutures live — code shows at https://testnet.arcscan.app/address/<ACRFutures>"
	@echo "  now set ACR_FUTURES_ADDRESS=0x<address above> in .env + on the Render seller."

verify-testnet:
	uv run python scripts/verify_deploy.py

# --- futures venue lifecycle (a series expires; the venue must outlive it) ---

# Idempotent: no-ops when a collateralized series still has life left, so it is
# safe on a timer. Exits non-zero rather than leaving an uncollateralized series.
futures-roll:
	uv run python scripts/futures_roll.py

# Permissionless. Refuses (rather than reverting) when the oracle print is too
# stale for the contract's freshness guard — the window reopens on the next print.
futures-settle:
	uv run python scripts/futures_settle.py

# Take a project key's collateral back out, across EVERY series it holds — a
# roll strands the old stake where nothing trades and nothing reclaims it.
# Reports only, unless you ask it to move money: WITHDRAW_DRY_RUN=0.
futures-withdraw:
	WITHDRAW_DRY_RUN=$${WITHDRAW_DRY_RUN-1} uv run python scripts/futures_withdraw.py

# --- the Public Desk (user-controlled wallets trading ACRFutures) ---

desk-preflight:
	uv run python scripts/desk_preflight.py

# Drives the REAL browser ceremony (a user-controlled key only exists client
# side). Playwright is not a repo dep — install it once, anywhere, and point
# PLAYWRIGHT_DIR at that node_modules. Needs `make api` + `make terminal` up.
desk-e2e:
	@test -n "$(PLAYWRIGHT_DIR)" || { echo "set PLAYWRIGHT_DIR=<dir>/node_modules (npm i playwright && npx playwright install chromium)"; exit 1; }
	node scripts/desk_e2e.mjs

tape-audit:
	uv run python scripts/tape_audit.py

desk-evidence:
	uv run python scripts/desk_evidence.py $(if $(USER_ID),--user $(USER_ID),)

post-once:
	uv run python scripts/post_once.py

attest-once:
	uv run python scripts/attest_once.py

seed-sellers:
	uv run python scripts/seed_sellers.py

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
# Install: npm install -g @circle-fin/cli   (Node >= 20.18.2). Verified vs CLI v0.0.6.
# The buyer agent (apps/agent) signs EIP-3009 itself, so it needs a RAW exportable
# key. In v0.0.6 `circle wallet create` only makes custodied *agent* wallets, so a
# local wallet comes via `circle wallet import` (see `make buyer-key`). The Arc
# chain name is ARC-TESTNET; fund/deposit/balance all require --address + --chain.
# Re-check with `circle <verb> --help` / `circle blockchain list` if flags drift.

CIRCLE_CHAIN ?= ARC-TESTNET

circle-check:
	@command -v circle >/dev/null 2>&1 || { echo "Circle CLI not found — npm install -g @circle-fin/cli (Node >= 20.18.2)"; exit 1; }
	@circle --version

circle-login: circle-check
	@test -n "$(EMAIL)" || { echo "usage: make circle-login EMAIL=you@example.com"; exit 1; }
	circle wallet login $(EMAIL) --testnet

# Generate a fresh TESTNET-ONLY buyer EOA. Import it (next target) + export it as
# AGENT_PRIVATE_KEY for `make agent-live`. Never reuse a key that holds real funds.
buyer-key:
	@uv run python -c "from eth_account import Account; a=Account.create(); k=a.key.hex(); k=k if k.startswith('0x') else '0x'+k; print('  address:', a.address); print('  key:    ', k); print('  (testnet only — import with: circle wallet import buyer --private-key, and export AGENT_PRIVATE_KEY)')"

# Import the buyer key as a local (exportable) wallet — reads the key interactively.
# NAME must be unique in the vault; override if a name is already taken:
#   make circle-wallet NAME=buyer2
NAME ?= buyer
circle-wallet: circle-check
	circle wallet import $(NAME) --private-key

circle-fund: circle-check
	@test -n "$(ADDR)" || { echo "usage: make circle-fund ADDR=0x<buyer wallet>"; exit 1; }
	circle wallet fund --address $(ADDR) --chain $(CIRCLE_CHAIN)

# CLI v0.0.6: LOCAL wallets (circle wallet import) deposit on-chain and REJECT
# --method; AGENT wallets REQUIRE --method (eco|direct). So --method is only
# passed when METHOD= is set: local → `make circle-deposit ADDR=…`; agent →
# `make circle-deposit ADDR=… METHOD=direct`. USDC is Arc's native gas, so a
# funded wallet covers the deposit. Override the amount with AMOUNT=.
AMOUNT ?= 0.5
METHOD ?=
circle-deposit: circle-check
	@test -n "$(ADDR)" || { echo "usage: make circle-deposit ADDR=0x<buyer wallet>"; exit 1; }
	circle gateway deposit --amount $(AMOUNT) --address $(ADDR) --chain $(CIRCLE_CHAIN) $(if $(METHOD),--method $(METHOD))

circle-balance: circle-check
	@test -n "$(ADDR)" || { echo "usage: make circle-balance ADDR=0x<buyer wallet>"; exit 1; }
	circle wallet balance --address $(ADDR) --chain $(CIRCLE_CHAIN)
	circle gateway balance --address $(ADDR) --chain $(CIRCLE_CHAIN) --all

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

deck:
	uv run python scripts/preview_excalidraw.py acr_architecture.excalidraw --out docs/assets --scale 0.5
	uv run python scripts/preview_excalidraw.py acr_architecture.excalidraw --out docs/assets --crop 700,280,2120,950 --name core
	rm -f docs/assets/acr_architecture.preview.png docs/assets/acr_architecture.core.png
	npx -y @marp-team/marp-cli --html docs/presentation.md -o docs/presentation.html
	npx -y @marp-team/marp-cli --html --allow-local-files docs/presentation.md -o docs/presentation.pdf || echo "PDF export needs Chrome/Edge — HTML deck is ready"

clean:
	rm -rf .venv contracts/out contracts/cache apps/terminal/.next apps/agent/node_modules scripts/_out
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
