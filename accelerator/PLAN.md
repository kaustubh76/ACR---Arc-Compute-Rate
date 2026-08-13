# ACR · The Accelerator Plan

**Eight weeks · Arc mainnet genesis in the middle of them · written to be executed, then checked**

The hackathon proved the methodology. The accelerator turns it into infrastructure, and for a
benchmark, infrastructure means exactly two things money cares about: **history** and
**dependents**. A reference rate's moat is how long it has printed and how much settles against
it. The calendar hands this cohort a once-ever shot at both: **Arc mainnet launches September
16, mid-programme**. Deploy at launch and ACR's price history begins at the genesis of the
market it measures. No later competitor can ever own a longer Arc-native track record. That
window closes on September 16 and never reopens.

Every week below ends with a receipt rather than a status, because that is how the hackathon
was built: `verify_claims.py` fails the build when a published number and reality disagree, and
that discipline carries into the accelerator unchanged.

![The plan on one canvas: the eight weeks, the switch, the flywheel, the products, the risk](acr_accelerator_plan.preview.svg)

The editable canvas is [`acr_accelerator_plan.excalidraw`](acr_accelerator_plan.excalidraw).

---

## Workstream A · The Switch (weeks 1 to 3): the history moat

Same audited contracts, harder infrastructure. Nothing about the estimator or the contract
surface changes for mainnet; what changes is everything around them, because a rate that misses
prints is not a rate.

**From the single press to a press that cannot oversleep.** Today the press is one in-process
hourly loop inside `services/index_api`, and the testnet taught the lesson the hard way: a
sleeping free-tier instance once stretched the print gap to a measured 153 minutes against the
venue's 120-minute settlement freshness window, meaning the venue could not have settled for
those hours. Mainnet gets two publisher workers behind a leader lock, a watchdog that posts
when the leader misses its slot, and a funded gas runway with its own alarm.

**From measured to alerted.** The cadence tooling already exists and already measures: the
print-gaps walker reads the chain, and the `/ops` systems ledger self-checks every fifteen
minutes. The accelerator turns measurement into paging: SLOs on print latency, gap against the
settle window, and staleness, each one wired to alert an operator instead of waiting to be
read. Observation was the hackathon's bar. Response time is the accelerator's.

**From Foundry to the Smart Contract Platform.** `scripts/deploy_circle.py` exists, is
unit-tested, and has never deployed anything but a dry run, which is why the hackathon
submission plainly refused to claim it. The mainnet deploy is where it fires for real, and SCP's
contract webhooks come with it, replacing the paged `eth_getLogs` crawl (a hard cap near 15,000
blocks, plus throttling) that is today's largest source of operational fragility.

**Week 1 is a full rehearsal on a fork.** Genesis day runs from a checklist, the same way the
submission ran from `SHIP-CHECKLIST.md`. Nothing on launch day is done for the first time.

---

## Workstream B · Adoption (weeks 2 to 8): the flywheel that makes it compound

Targets, measured the way everything here is measured, with receipts on-chain and re-verified
in CI: **8 to 10 independent sellers** submitting signed attestations, and **3 or more external
paying consumers** of the x402 API.

**Adoption is the security model, not vanity.** Every independent seller and every basis point
of external flow raises the published attack-cost-per-bp. More adopters make manipulation more
expensive, which makes the rate more credible, which brings more adopters. The accelerator is
where that flywheel gets its first real turn, and the cohort is the natural first market:
inference, GPU and data providers already selling to agents.

**The one-day integration path ships in week 2, before genesis.** Two pieces:

1. **Attest and get listed.** A provider signs one EIP-712 attestation (the registry contract
   and its schema are live today) and lands in the catalog the same day. No integration work
   before the benefit shows up.
2. **Settle against ACR in ten lines.** A client SDK that reads the print, verifies the Circle
   custody signer, and enforces the staleness bound, so a consumer's first integration is an
   afternoon, not a sprint.

**Recruitment is an organizer's motion, and I have run it before.** Attestation sprints inside
the cohort with office hours and same-day listing as the prize. The receipts behind that claim:
I organized and led LNMHacks 6.0 and secured USD 7,000 in protocol partnerships, spent eight
months as a Flare developer ambassador resolving oracle and price-feed integration questions in
real time for teams actively shipping, and wrote a full go-to-market playbook (ICP archetypes,
qualification rubric, conversion cycles) for an Aave indexer product. Sellers are recruited the
way hackathon sponsors and oracle integrators are recruited, and that is a job I have already
done.

**Sequencing is the quiet trick.** Mainnet history lands in week 3, before the hardest asks, so
from week 4 onward I am recruiting with a live genesis track record instead of a promise.

---

## Workstream C · Dependents (weeks 4 to 8): the moment it becomes infrastructure

**Open the books (week 5).** The futures venue moves from self-market-made demonstration to
cash-settling with external counterparties. The hard parts are already on-chain and tested:
initial margin, per-series trader caps, socialized-loss clearing, and the two-hour settlement
freshness bound. What the accelerator adds is a published maker depth policy and position
limits sized for strangers. I have built and run an Avellaneda-Stoikov market maker against a
live venue twice now, once here and once pricing UMA dispute risk on Polymarket with the fills
reconciled exactly against decoded on-chain events, so the book management is a known quantity.

**Land the first external dependent (week 6).** ACR as settlement oracle for at least one
Arc-native credit or hedging protocol. Cohort teams are the natural first integrations, and the
plan is to actively build for them: I write their integration PR myself, and the published
`acr-hedge` Skill already teaches any agent the read, verify, hedge loop. The day another
team's product settles against ACR is the day it stops being a dashboard.

---

## Workstream D · Administration (throughout): governance is the product

The LIBOR lesson is that rates fail on governance before they fail on math. So the boring parts
ship as features: the methodology paper published openly as v1.0, versioned under
change-control, with a public incident policy for misprints and outages. The CI-gated claims
discipline extends naturally into benchmark administration, and there is precedent for the open
half too: I have released an open dataset before (1,848 UMA disputes, CC-BY, self-refreshing
from keyless RPC export) and kept it maintained, which is the same muscle as maintaining a
public methodology.

---

## The eight weeks, receipt by receipt

| Week | The work | The receipt that exists when it ends |
|---|---|---|
| 1 | Mainnet rehearsal on a fork; SCP deploy pipeline; SLO alarms stood up | A green dry-run log and a genesis-day checklist in the repo |
| 2 | One-day integration path; ten-line client SDK; attestation sprint #1 | The SDK published; the first cohort attestations signed on testnet |
| 3 | **Genesis**: day-one mainnet deploy; failover press live | The first mainnet print, hourly thereafter; the history moat starts |
| 4 | Checkpoint in public; first external payers; sprint #2 | External x402 receipts on the tape; seller count on-chain, whatever it is |
| 5 | Books open to external counterparties; depth policy published | A fill on the venue from a wallet that is not ours, at mainnet |
| 6 | First dependent integration, PR written by me | Another protocol's contract reading ACR for settlement |
| 7 | Methodology v1.0; change-control; incident policy | The versioned document and its governance process, public |
| 8 | Demo day | Every line below, clickable |

**Demo day, defined:** a rate printing hourly on Arc mainnet since launch week; 8 to 10
independent attesting sellers; 3 or more external payers; one protocol settling against it;
methodology v1.0 under change-control; every number CI-verified, nothing claimed that a judge
cannot click.

---

## Circle developer products, mapped to their jobs

| Product | Its job in this plan |
|---|---|
| **Arc mainnet** | The venue for genesis history. USDC as gas keeps the published attack cost arithmetic instead of a distribution. |
| **x402 + Gateway** | Already live: the paid-query and settlement rails, proven end to end on testnet with real settled receipts. |
| **Circle Wallets** | The operator fleet: press, maker, taker, treasury, and the agent hedger. `docs/WALLETS.md` records which of the four wallet products does which job and the constraint forcing each choice. |
| **Gas Station** | The Public Desk stays free to try: sponsored user-controlled smart accounts, sponsorship proven from the paymaster event. |
| **CCTP V2** (new) | External payers will not all live on Arc. Cross-chain consumers pay and read in native USDC from wherever they hold it. |
| **Smart Contract Platform** (new) | Mainnet deploys and contract webhooks. One of the two products the hackathon submission said plainly it did not use; the accelerator is its opening backlog. |
| **Agent Marketplace / Discovery** | Distribution. ACR is today the only Arc-native listing submission among 958 served listings; when Arc lands in Discovery, be first on day one. |
| **Compliance Engine** (stretch) | If the cohort includes issuers: a KYB-gated attestation tier, so institutional sellers attest under compliance. The bridge from a crypto-native benchmark to a rate TradFi desks can cite. |

---

## Risks, pre-declared

**Seller recruitment is the honest bottleneck.** Attestation asks providers to do work before
the rate is famous. Mitigations, each one a playbook already run: the one-day integration path
(the Flare ambassadorship was exactly this, unblocking integrators in real time), cohort-first
targeting where access is direct (the LNMHacks partnerships were exactly this, getting
organizations to commit resources to an unproven event), and sequencing mainnet history before
the hardest asks. If I am behind at week 4, it shows in the receipts. That is the point of
building this way.

**Mainnet slips.** The Switch is date-independent: everything in weeks 1 and 2 lands regardless,
and only the genesis claim moves with the date. The rehearsal fork keeps the team ready to
deploy within hours of whenever launch actually happens.

**Venue liquidity stays thin.** By design the mechanism is the product, not the notional: caps
stay small, margin stays conservative, and the demo-day claim is that external counterparties
cleared, not that volume was large.

**A single operator.** The SLO pager, the runbooks, and the ops console's audited, capped,
dry-run-by-default money-moving controls exist precisely so the system's safety does not depend
on my attention on any given hour.
