# The World cuts — a shot list, not a script to improvise against

Two World bounties, one recording session. Everything below is driven by
`make rehearse-float`, which prints the value at every step, so the screen does
the talking and the narration only has to say *why*.

**Read this once before pressing record.** The one thing that cannot be fixed in
an edit is a missing clip, and one of the clips is mandatory.

---

## Before you start

```bash
anvil --port 8546                        # leave it running in its own window
cd contracts && forge build              # the artifact must match the source
make rehearse-float                      # a dry run, to see it all pass
```

Run it **twice** before recording. The first run tells you the stack is healthy;
the second is the one you will have muscle memory for. Each run deploys a fresh
vault, so nothing carries over and there is no state to reset between takes.

Terminal set-up that makes the recording legible:

- One window, nothing else on screen. No browser tabs, no notifications.
- Font large enough that a judge on a laptop can read `18.540000 USDC`. If in
  doubt, too large.
- Do **not** clear the screen between legs: the whole point is that a viewer can
  scroll back and see the denial sitting under the approval.

## Hard rules

- **The deny clip is mandatory.** A submission without an unsuccessful path is
  incomplete for Agent Pass, and the deny leg is the one that proves the system
  refuses rather than merely succeeds slowly.
- **Not recorded on a phone.** Screen capture only.
- **Human narration.** No text-to-speech, no AI voice.
- **Do not speed it up.** The run is fast enough already; sped-up footage reads
  as hiding something.
- **Length is UNVERIFIED and must be checked on the submission form before you
  cut.** The event page would not load for us; the prizes page shows per-track
  limits ranging from "under 3 mins" to "5 minutes or less", and Arc's own block
  says only "Video demonstration + presentation". Plan for ~2:40 of World
  material so it fits inside the tightest limit we have seen.

---

## Cut 1 · Agent Pass (target 0:00 – 1:50)

| time | screen | say, roughly |
|---|---|---|
| 0:00 | step 1, the roles | "The approver and the executor are different keys. One compromised key cannot open a payment and then approve it — the vault refuses that wiring." |
| 0:12 | step 2, agent wallet | "This is the agent's own wallet. Zero. It holds nothing before this run and nothing after it." |
| 0:20 | step 3, in policy | "A small purchase inside policy just pays. No human is asked. That contrast matters." |
| 0:32 | step 4, parked | "Now it asks to pay 18.54 against a fair price of 18.00 — a 3% premium. The chain refuses it, **and does not throw it away.** A checkpoint opens, on chain, naming the agent and the exact request hash." |
| 0:55 | step 5, approved | "A human authenticates. The token is validated against nine named checks. Then one single-use signature, and the money moves — 18.54 lands on the seller. The checkpoint is consumed; the same approval cannot be used twice." |
| 1:20 | **step 6, DENIED** | "Same request, human says no. `CheckpointResolved(denied)` on chain, **and the seller's balance does not move.** The refusal is evidence, not silence." |
| 1:35 | step 7, EXPIRED | "Nobody answers. The window closes on chain time, not ours, and it is recorded as expired." |
| 1:42 | step 8, wrong human | "A perfectly valid proof from the wrong person. Correct signature, right assurance class, in date — refused, because it is not the enrolled treasurer." |

**The sentence to get right**, because it is the whole argument and the easiest
thing to overstate:

> An approval **widens** the band. It never removes it. A person can authorise
> paying more than usual. Nobody — including the approver — can authorise paying
> an unpriced amount to an unapproved seller.

**Do not claim** that the approver is the only trusted party. Our own audit
found that the executor can resolve an open checkpoint, including writing
EXPIRED over a signature a human already gave. It is disclosed in the
submission; if a judge asks, say so plainly and say it is unrepaired.

## Cut 2 · IDKit (target 2:00 – 2:40)

Needs the Developer Portal credential. If it has not landed, **do not record
this cut** — our rule is that a half-built module is not entered, and an
unfinished widget on camera costs more than an absent entry.

| time | screen | say, roughly |
|---|---|---|
| 2:00 | the join page | "A visitor proves they are a person once. Not an Orb — Selfie Check, which anyone with the app can complete." |
| 2:12 | the budget arrives | "The vault issues a guest agent with a 2 USDC daily cap, flagged a guest so it is revocable on its own." |
| 2:24 | **the same human again** | "Same person, second agent. Refused — and refused by the chain itself, not by our database. The agent id is a hash of the nullifier, so the chain can answer 'has this human already been funded' in one call." |

**The credential sentence, verbatim** — it is a required deliverable and it is
quoted in the submission, so say it as written rather than paraphrasing:

> Small revocable budget → least identity that stops farming: Selfie Check +
> sybil floor; Orb is the config flag for real money; passport rejected — more
> identity than the risk needs.

Then the number, because it is what makes that defensible:

> Controlling one verified human costs an attacker at least ten dollars, by our
> own audited floor. A guest budget is two dollars a day. A rented identity does
> not pay for itself inside five days.

Say **"at least"**. The figure is a lower bound flagged `unsourced` in our own
anchor file, and claiming it as measured would be the one dishonest sentence in
the whole submission.

---

## Clips to keep separately, whatever else happens

Even if the edit changes, these are the ones a judge may ask for:

1. The denial, with the seller's balance visible before and after.
2. The expiry.
3. The wrong-human refusal.
4. If the credential landed: a real device-flow user code on a phone, and the
   duplicate-human refusal.

## If something goes wrong on camera

Keep rolling. `make rehearse-float` prints its failures in a block at the end
with the sentence "would not survive the demo", and a run that fails *visibly*
and gets explained is far better television than a cut that hides it. The script
is strict by default for exactly this reason.
