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
- **Length is no longer a risk.** It used to be: the plan was ~2:45 across two
  cuts, against per-track limits we could not read (the event page would not
  load; the prizes page showed anything from "under 3 mins" to "5 minutes or
  less"), leaving about fifteen seconds of margin and nothing to spare. The
  IDKit entry is withdrawn, so **Cut 1 is the whole video at 1:58** and clears
  even the tightest limit we saw. Nothing needs dropping. Still worth a glance
  at the form, but it is no longer load-bearing.

---

## Cut 1 · Agent Pass (target 0:00 – 1:58)

| time | screen | say, roughly |
|---|---|---|
| 0:00 | step 1, the roles | "The approver and the executor are different keys. One compromised key cannot open a payment and then approve it — the vault refuses that wiring." |
| 0:12 | step 2, agent wallet | "This is the agent's own wallet. Zero. It holds nothing before this run and nothing after it." |
| 0:20 | step 3, in policy | "A small purchase inside policy just pays. No human is asked. And the line under it is the vault's own receipt — its record of the quote, the fair price and the premium, not our claim about them. That contrast matters." |
| 0:32 | step 4, parked | "Now it asks to pay 18.54 against a fair price of 18.00 — a 3% premium. Watch the vault refuse it in its own words, from a transaction and not from a preview. **And it does not throw the request away.** A checkpoint opens, on chain, naming the agent and the exact request hash." |
| 0:44 | step 4, the two nonces | "One detail that makes the escalation real. That refusal burns the nonce of the request it refused, so a price move can never make it payable later. The request we parked still holds its nonce — and that is the one a human is about to clear." |
| 1:03 | step 5, approved | "A human authenticates. The token is validated against nine named checks. Then one single-use signature, and the money moves — 18.54 lands on the seller. The checkpoint is consumed; the same approval cannot be used twice." |
| 1:28 | **step 6, DENIED** | "Same request, human says no. `CheckpointResolved(denied)` on chain, **and the seller's balance does not move.** The refusal is evidence, not silence." |
| 1:43 | step 7, EXPIRED | "Nobody answers. The window closes on chain time, not ours, and it is recorded as expired." |
| 1:50 | step 8, wrong human | "A perfectly valid proof from the wrong person. Correct signature, right assurance class, in date — refused, because it is not the enrolled treasurer." |

### Two optional beats, in the order to cut them

Both sit outside the 1:58 and are listed worst-last, so nobody is improvising at
two in the morning. Cut the second one first.

**1 · The page, 15 seconds, as the closing frame.** Everything above is terminal
output, and this entry has one thing a judge can verify without running
anything. Open `/float/approve`:

> "This is the page asking World right now, not a screenshot. It fetched the
> issuer's own discovery document when I loaded it: these are the assurance
> classes World advertises, this is the round trip in milliseconds, and this is
> the check that the document names itself as the host we asked. It is
> unauthenticated, so you can open the same URL and compare. Below it, the gate
> read off the chain: still three transactions short of armed, and it says
> which."

**Do not say** that the page proves anyone approved anything. It proves World
answers us and what World will accept. Those are different claims and the second
one is still unearned.

*Closing rather than opening on purpose:* the terminal run builds the argument,
and the page is the "check it yourself" payoff. It is also the cheaper thing to
drop, because cutting a closing frame costs nothing while re-shooting an opening
one costs a take.

**2 · Leg 10, the guest budget, 20 seconds.** It stopped being covered by
anything when Cut 2 was deleted with the IDKit entry, and it is now an Agent
Pass capability rather than an IDKit one:

> "The same verified identity that approves a payment also opens a budget. One
> human, one budget — and watch the second attempt refused three times over: by
> our ledger, by the spent nonce, and by the chain itself saying `agent exists`.
> That last one needs no second person to demonstrate."

**The sentence to get right**, because it is the whole argument and the easiest
thing to overstate:

> An approval **widens** the band. It never removes it. A person can authorise
> paying more than usual. Nobody — including the approver — can authorise paying
> an unpriced amount to an unapproved seller.

**Do not claim** that the approver is the only trusted party. Our own audit
found that the executor can resolve an open checkpoint, including writing
EXPIRED over a signature a human already gave. It is disclosed in the
submission; if a judge asks, say so plainly and say it is unrepaired.

## Cut 2 · IDKit — NOT RECORDED

Withdrawn, and the shot list is deleted rather than left to tempt anyone at 2am.
The entry rested on Selfie Check, which the World team confirmed on 2026-11-06
is no longer offered. This cut's own instruction was already *"if the credential
has not landed, do not record this cut — a half-built module is not entered, and
an unfinished widget on camera costs more than an absent entry."* The credential
will never land, so the instruction resolves to: do not record it.

The guest code, its 31 tests and the join page remain in the repo and green. If
a judge asks what the second track was, point at
`SUBMISSION-WORLD-IDKIT.md`, which is kept intact and marked withdrawn.

**An optional beat for Cut 1 instead, if it fits inside 1:58 — and it is real
rather than reasoned.** The live token came back with `amr` =
`["pop","user","mfa"]`, the passkey shape that World's own docs say *"does not
assert a fresh World proof"*. So `acr` said orb while the authentication was a
passkey unlock. The spend cleared, correctly: orb assurance is what that path
asks for. The same token would be **refused for a policy change**, because that
path requires `face` in `amr` and forbids `mfa`. One sentence on camera: *"this
token can move money and cannot change the rules."* Cut it first if time is
tight — the paid and denied beats carry the argument without it.

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
