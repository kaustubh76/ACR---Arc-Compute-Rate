# ACR on Aomi

**ACR (Arc Compute Rate) as an Aomi App.** It gives any Aomi agent the ability to
tell its user whether a bill for AI inference, GPU time or data is fair, and
whether a wallet is overpaying its compute vendors. Every verdict is checked
against cited public prices, never asserted.

Aomi turns intent into on-chain transactions. Before an agent pays for compute,
something has to say whether the price is right. That is what ACR does: it
publishes an on-chain reference index for machine compute from an oracle on Arc,
and it benchmarks real bills against real published prices. This App puts both
answers inside Aomi's agent as five research tools. Version 0.2 also adds an
owner-wallet payment inbox: review escalated bills, prepare an exact PolicyWallet
payment, simulate and authorize it through the connected owner wallet, and verify
its settlement. Every build uses **evm-core** with a deployment-specific treasury
guard. Deployment addresses remain explicit placeholders in the template;
missing, disabled, or invalid configuration fails the build. See [Treasury setup and workflow](TREASURY.md)
for the app-specific skill, guard, API, contract upgrade and acceptance checks.

## What an Aomi agent gets

| tool | the user asks | it answers with |
|---|---|---|
| `acr_check_bill` | "I was billed 0.47 USDC for 23k tokens. Should I pay?" | pay / reroute / hold / escalate / refuse, the rule, bp over or under the going rate, the cheapest cited seller, the avoidable USDC |
| `acr_wallet_cost` | "Is this agent overpaying?" | purchases, spend, slippage vs the benchmark, overpaid USDC, the cheaper seller it should use |
| `acr_seller_rating` | "Can I trust this compute seller?" | a grade with how much of it is actually measured, or "Unrated" and why |
| `acr_rate` | "Where is the ACR index, and is it fresh?" | the on-chain print, its confidence interval, the USDC it costs to move it 1 bp, its age |
| `acr_receipts` | "Did my payment to ACR land?" | recent USDC settlements with their references |

## Live in Aomi chat

**Open it:** [chat.aomi.dev, pinned to ACR](https://chat.aomi.dev/?app=acr-compute-rate&application_id=2938642&lock_app=1)
(application 2938642, project 1687).

Captured 2026-10-13 19:10 UTC on Aomi production through Aomi's own client
(`@aomi-labs/client` 0.9.14, Direct mode). Aomi's agent called the tools and relayed their answers.
ACR's `/par` and `/onchain/ACR-INF` returned the same numbers in the same minute.

```
you   › "My agent was billed 0.47 USDC for 23,000 tokens of inference. Should it pay?"
tool  › acr_check_bill → +500,870 bp over 0.0004 per 1k · cheapest GPT-4o mini 0.0002625 · 0.4639625 avoidable
aomi  › Escalate rather than pay automatically. The 0.47 USDC bill for 23,000 tokens is about
        51 times the published market benchmark used in this check. … The cheapest listed
        reference was GPT-4o mini, at about 0.0060 USDC for 23,000 tokens … roughly 0.464 USDC
        less than the bill. … Nothing was paid.

you   › "Where is the ACR inference index, and is it fresh?"
tool  › acr_rate → 0.4953 · CI 0.49426–0.49874 · 0.010151 USDC per bp · posted 3.3 hr ago · current: false
aomi  › The last known ACR inference index level is 0.4953. It was posted about 3.3 hours ago,
        beyond ACR's two-hour freshness window, so it is not fresh. This is an index level, not
        the market price of inference.
```

A plain chat.aomi.dev session routes on its own (Auto mode) and did not pick ACR for these
questions. Use the link above or the project's Chat tab, which pin the App.

## Historical research-only plugin verification

Captured 2026-10-13. The App was loaded with `aomi_sdk::DynFnHandle`, the host-side
loader Aomi's backend uses, and each tool was called across the FFI boundary
against the live ACR press:

```
you  › "My agent was billed 0.47 USDC for 23,000 tokens of inference. Should it pay?"
tool › acr_check_bill {"billed_usdc":0.47,"quantity":23,"unit":"$/1k tokens"}
acr  › verdict over_par · +500,870 bp · the spend agent would ESCALATE
       you paid 0.0204 per 1k tokens; the going rate is 0.0004 across 5 published prices
       cheapest: GPT-4o mini at 0.0002625 per 1k (openrouter.ai, data[id=openai/gpt-4o-mini].pricing)
       0.464 USDC of this bill was avoidable

you  › "Has wallet 0xc2903b52… been overpaying its compute vendors?"
tool › acr_wallet_cost {"wallet":"0xc2903b52a3ad365fd237b78389a2fde99e886999"}
acr  › seen · 3 purchases · 0.00461 USDC · slippage -1139.8 bp (paid less than the benchmark) · overpaid 0

you  › "Rate seller 0xefe0E462…."
tool › acr_seller_rating {"seller":"0xefe0E4625AFf072c3FCff230b47f8150A17aDF19"}
acr  › Unrated: thin tape (n=1 < 20) · 40% of the grade measured. It refuses to invent a score.

you  › "Where is the ACR inference index?"
tool › acr_rate {"index":"ACR-INF"}
acr  › 0.49773 (CI 0.49449–0.49780) · costs 0.0156 USDC to move by 1 bp · posted 58 min ago, current
       scale: ACR's own nominal index level, not a market price
```

## Honesty is built into the tools, not left to the prompt

- **An index level is never a price.** ACR-INF sits about 1,250× above public
  inference prices (`anchors/GAP.md`), so `acr_rate` says so on every answer. Questions
  about what compute costs go to `acr_check_bill`, which compares against cited quotes.
- **Every rate states its age.** Past the 2-hour settle window it reads `current: false`,
  meaning "the last known value".
- **Every bill states its basis.** A bill from a seller ACR operates is judged only
  against ACR's own fleet prices. The tool says so and gives the call that prices the
  same bill against the market instead.
- **"Not seen" is never "zero".** A wallet ACR has no record of is reported as unseen,
  not as spending nothing.
- **An empty receipt list says why.** Receipts live in the memory of the press that
  sold them, so the tool says that rather than "nobody paid".

## Historical v0.1.1 verification (not treasury deployment evidence)

- **SDK pin = what Aomi's backend requires today.** `aomi-build sdk check` (the 5.1.1 CLI)
  asks `api.aomi.dev` and passes: required 5.1.1, `Cargo.toml` exact 5.1.1, `Cargo.lock`
  5.1.1. The backend's own answer, `GET /api/platforms/server-tags`, is
  `{"server_tags":["prod"],"sdk_version":"5.1.1"}`.
- **It loads the way the backend loads it.** Through `DynFnHandle`, and read back by
  `aomi-build manifest`: `acr-compute-rate 0.1.1 · sdk 5.1.1 · namespaces []`, five tools,
  one optional secret slot (`ACR_API`).
- **It passes the checks Aomi's platform build makes.** That build
  (`aomi-labs/community-apps`, `deploy_project.py`) extracts the whole repository
  snapshot, walks up from this folder to the first `Cargo.toml` with a `[workspace]`
  table, requires `Cargo.lock` there, and builds with `--locked`. Those steps were
  replayed on a `git archive` of the commit. The archive has 858 entries and 11.3 MiB,
  with no links, under every limit. The walk stops at this folder, and `cargo check`,
  `cargo build --release` and `cargo test`, all `--locked`, pass in the extracted copy
  with the lockfile unchanged. The same replay on the commit before this fix reproduces
  Aomi's refusal.
- **Every tool answers from a plain thread AND from inside a Tokio runtime.** HTTP uses
  `reqwest`'s blocking client, as Aomi's template prescribes, because a tool runs inside a
  synchronous FFI boundary.
- **Tests.** `cargo test`: 27 deterministic tests. 21 run the tools on recorded live
  responses, each watched failing on a deliberately broken tool. Two fail if the
  deploy layout drifts: when the SDK pin Aomi's deploy gate reads (the repo-root
  `Cargo.toml`) differs from this App's, or when this folder stops being its own
  workspace root with `Cargo.lock` beside it. Four drive the HTTP client against a
  scripted local press. They cover the two kinds of 404: FastAPI's "Not Found" means
  the route is missing, so stop; the press's own "no on-chain print" sentence can be
  a throttled chain read, so re-ask once. `cargo test -- --ignored` runs all five
  tools against the real press. ACR's CI runs the suite on every push.

## Deploy the configured treasury app

First follow [TREASURY.md](TREASURY.md) and supply the enabled deployment JSON
to the build runner through ACR_TREASURY_CONFIG. A dashboard build without that
input fails; it cannot produce a fallback app. Configure private business access
and the required treasury credential before activation. Existing public research
releases do not acquire write capabilities until a configured release is deployed.

The App lives in this subdirectory of the ACR repo. Aomi finds it through the root
`.aomi/config.json`, the layout Aomi's own `docs/community-deployment.md` documents for
an App in a subdirectory.

1. Sign in at **[build.aomi.dev](https://build.aomi.dev)** with **Continue with GitHub**.
2. **Import from GitHub**, install the Aomi Build GitHub App on the ACR repository, and
   select it. Aomi reads the default branch, so this App has to be on `main` first. With
   it there, the wizard builds the release from the branch's latest commit and activates
   it.
3. To ship a new commit, use **Deployments → Deploy** on `main`. Aomi's workflow then
   activates the release and waits until the runtime reports the artifact ready.
4. Talk to it from the project's **Chat** tab. That tab opens chat.aomi.dev pinned to this
   App by its numeric `application_id`. A plain chat.aomi.dev session routes on its own
   (Auto mode) and answers without ACR's tools.

`aomi.toml` declares `server_tags = ["prod"]`, because `api.aomi.dev` advertises only
`prod`, and an App left on the default `["staging"]` would never load there.

The repo root also holds a small `Cargo.toml` that builds nothing. Aomi's deploy gate reads
the SDK pin only from the root of a repository, and stops with "no Cargo.toml found"
without one. So that file declares the pin and nothing else. This folder's `Cargo.toml`
declares its own `[workspace]`. Aomi's platform build looks for `Cargo.lock` beside the
first workspace it finds walking up from the App, and the lock lives here.

**Deploy production from the dashboard, not the terminal.** `aomi-build deploy` builds and
publishes the release, but Aomi then starts its deploy workflow without a branch and with
activation switched off. It leaves activation to the CLI, and that route left this App at
`artifact_ready=false`, so chat answered "App not found". In Aomi's Deploy Project runs,
the production deploys started from the dashboard (projects 1686, 1688 and 1689) carry
`main` and ran Activate and Verify runtime. This App's CLI deploy (1687, 2026-10-13)
carried no branch and skipped both. The CLI is still useful for read-only checks:

```bash
cargo install aomi-sdk --version 5.1.1 --locked --features cli   # installs aomi-build
aomi-build sdk check --path . --backend https://api.aomi.dev      # from the repo root
aomi-build deploy preflight --backend https://api.aomi.dev        # validates; opens no PR
```

**Optional setting:** `ACR_API`, set in the App's Environment tab, points the tools at
another ACR press, for example `https://acr-api-1fto.onrender.com` for Arc testnet. Left
unset, the App reads the default Arc mainnet press.

## Develop

```bash
python3 tests/check_deployment.py # build refusals + configured unit tests
export ACR_TREASURY_CONFIG=/absolute/path/to/deployment.json
cargo test                       # tests against your configured manifest
cargo test -- --ignored          # every tool against the live ACR press
ACR_API=https://acr-api-1fto.onrender.com cargo test -- --ignored   # the same, against Arc testnet
cargo build --release            # target/release/libacr_compute_rate.{dylib,so}
make aomi-live                   # from the repo root: ask ACR through Aomi's production chat
```

`make aomi-live` is the live witness. It sends two Direct-mode turns to application 2938642 on
chat.aomi.dev and fails unless `acr_check_bill` and `acr_rate` actually ran inside Aomi and their
numbers equal the press's in the same minute. The unit tests run on recorded responses, so only
this can catch the App becoming unreachable on Aomi.

The layout follows Aomi's guidance. `src/lib.rs` holds registration and the preamble,
`src/client.rs` and `src/tool.rs` implement the research tools.
`src/treasury.rs` implements the deployment-bound treasury tools; `src/skill/`
contains their workflows and safety boundaries.
`fixtures/` holds the recorded responses the tests run on.
