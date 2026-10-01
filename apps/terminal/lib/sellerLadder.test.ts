import { test } from "node:test";
import assert from "node:assert/strict";

import { isHostFailure } from "./apiBase";
import { makeLadder } from "./sellerLadder";

/* The mechanism that is the only reason the live terminal reaches mainnet:
   `ACR_API` still names a SUSPENDED Render service, so every request falls
   through this. It shipped with the pure policy tested and the ladder itself
   not, which was the wrong half to leave uncovered. */

const DEAD = "https://dead.example";
const LIVE = "https://live.example";

/** A fake attempt: `byHost` says what each host does. Records the call order. */
function spy(byHost: Record<string, "ok" | "5xx" | "402" | "throw">) {
  const calls: string[] = [];
  const attempt = async (base: string) => {
    calls.push(base);
    const how = byHost[base];
    if (how === "throw") throw new Error(`${base} unreachable`);
    const status = how === "ok" ? 200 : how === "402" ? 402 : 503;
    const bad = isHostFailure(status);
    return { ok: !bad, hostFailed: bad, value: `${base}:${status}` };
  };
  return { attempt, calls };
}

test("a healthy configured host wins, and the published one is never tried", async () => {
  const { attempt, calls } = spy({ [DEAD]: "ok", [LIVE]: "ok" });
  const l = makeLadder([DEAD, LIVE]);
  assert.equal(await l.run(attempt), `${DEAD}:200`);
  assert.deepEqual(calls, [DEAD], "a working override must never be second-guessed");
  assert.equal(l.state().fellBack, false);
});

test("a 5xx falls through, and the fallback STICKS", async () => {
  const { attempt, calls } = spy({ [DEAD]: "5xx", [LIVE]: "ok" });
  const l = makeLadder([DEAD, LIVE]);
  assert.equal(await l.run(attempt), `${LIVE}:200`);
  assert.equal(l.state().active, LIVE);
  assert.equal(l.state().fellBack, true);

  // The second call must not re-pay the dead host: on a page with a dozen
  // proxied routes that is a dozen wasted round trips per render.
  calls.length = 0;
  assert.equal(await l.run(attempt), `${LIVE}:200`);
  assert.deepEqual(calls, [LIVE], "the failure is paid once, not per request");
});

test("a 402 is an ANSWER and must not move us off the host", async () => {
  // The x402 paywall working exactly as designed. Falling through would send a
  // paid request to a seller that never quoted it.
  const { attempt, calls } = spy({ [DEAD]: "402", [LIVE]: "ok" });
  const l = makeLadder([DEAD, LIVE]);
  assert.equal(await l.run(attempt), `${DEAD}:402`);
  assert.deepEqual(calls, [DEAD]);
  assert.equal(l.state().fellBack, false, "a 402 is not a host failure");
});

test("an unreachable host falls through too — a throw is how that arrives", async () => {
  const { attempt, calls } = spy({ [DEAD]: "throw", [LIVE]: "ok" });
  const l = makeLadder([DEAD, LIVE]);
  // The caller's attempt is responsible for turning a throw into hostFailed;
  // this asserts the ladder honours it rather than letting it escape.
  const wrapped = async (base: string) => {
    try {
      return await attempt(base);
    } catch {
      return { ok: false, hostFailed: true, value: `${base}:threw` };
    }
  };
  assert.equal(await l.run(wrapped), `${LIVE}:200`);
  assert.deepEqual(calls, [DEAD, LIVE]);
});

test("both down returns the FIRST answer, not the second", async () => {
  // The caller asked the configured host. Its error is the one worth surfacing;
  // reporting the cushion's error would send someone debugging the wrong host.
  const { attempt } = spy({ [DEAD]: "5xx", [LIVE]: "5xx" });
  const l = makeLadder([DEAD, LIVE]);
  assert.equal(await l.run(attempt), `${DEAD}:503`);
  assert.equal(l.state().active, DEAD, "a failed fallback does not become active");
  assert.equal(l.state().fellBack, false);
});

test("one candidate means no fallback behaviour at all", async () => {
  const { attempt, calls } = spy({ [LIVE]: "5xx" });
  const l = makeLadder([LIVE]);
  assert.equal(await l.run(attempt), `${LIVE}:503`);
  assert.deepEqual(calls, [LIVE], "nothing to climb to, so nothing is retried");
});

test("the fallback is announced, because silence is what cost two days", async () => {
  const seen: Array<[string, string]> = [];
  const { attempt } = spy({ [DEAD]: "5xx", [LIVE]: "ok" });
  const l = makeLadder([DEAD, LIVE], (from, to) => seen.push([from, to]));
  await l.run(attempt);
  assert.deepEqual(seen, [[DEAD, LIVE]], "the operator has to be able to find out");
  // ...and only once, since the fallback stuck.
  await l.run(attempt);
  assert.equal(seen.length, 1);
});
