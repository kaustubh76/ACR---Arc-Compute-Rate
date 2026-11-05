/**
 * English in, policy on chain — with the validation that makes that safe.
 *
 * The treasurer writes a sentence in Arc Studio. Studio emits JSON. This module
 * decides whether that JSON is allowed anywhere near the vault, and the answer
 * has to be all-or-nothing: a REJECTED config leaves the chain holding the last
 * good policy, because a half-applied policy is worse than an unchanged one —
 * nobody can tell which rules are live.
 *
 * Two layers, deliberately:
 *
 *   `policy.schema.json` is the artifact handed to Studio — the contract its
 *   output has to satisfy, in a format a model can be pointed at.
 *
 *   `PolicySchema` below is what actually runs before a transaction is built.
 *
 * Two sources of truth would normally be a bug waiting to happen, so
 * `policy.test.ts` asserts they agree: same required fields, same bounds. That
 * is the same trick `mcp/src/printAge.test.ts` uses to pin a constant across
 * Python and TypeScript — a gate, rather than a hope.
 */
import { z } from "zod";

/** A USDC amount as a decimal string. Never a float: 6dp money through a double is a rounding bug with a plausible story. */
const USDC_RE = /^[0-9]+(\.[0-9]{1,6})?$/;
const Usdc = z.string().regex(USDC_RE, "a USDC amount like \"25\" or \"2.50\"");
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an 0x address");

export const AgentSchema = z
  .object({
    dailyCapUsdc: Usdc,
    perRequestUsdc: Usdc,
    frozen: z.boolean(),
    allowedSellers: z.array(Address).optional(),
  })
  .strict();

export const PolicySchema = z
  .object({
    bufferHours: z.number().int().min(1).max(168),
    maxPremiumBps: z.number().int().min(0).max(2000),
    humanMaxPremiumBps: z.number().int().min(0).max(10000),
    maxPrintAge: z.number().int().min(60).max(86400),
    upperBandBps: z.number().int().min(0).max(10000).default(1500),
    lowerBandBps: z.number().int().min(0).max(10000).default(1000),
    minTicketUsdc: Usdc.default("1"),
    workingShareBps: z.number().int().min(0).max(10000),
    agents: z.record(z.string().min(1), AgentSchema),
  })
  .strict()
  // The cross-field rules. These are not style: each one describes a policy
  // that would read as a rule while enforcing nothing, and the vault refuses
  // them too — so catching them here turns a reverted transaction into a
  // sentence the treasurer can act on.
  .refine((p) => p.humanMaxPremiumBps >= p.maxPremiumBps, {
    message:
      "humanMaxPremiumBps is below maxPremiumBps: an approval must widen the band, never narrow it",
    path: ["humanMaxPremiumBps"],
  })
  .refine((p) => Object.keys(p.agents).length > 0, {
    message: "a policy with no agents authorises nothing and is probably a mistake",
    path: ["agents"],
  })
  .superRefine((p, ctx) => {
    for (const [name, a] of Object.entries(p.agents)) {
      // zod runs refinements over DIRTY input: a field that failed its own
      // regex still arrives here. So re-check the shape before doing
      // arithmetic on it, or a malformed amount throws out of `validate` and
      // the caller gets a crash where it asked for a list of problems. The
      // field-level error is already reported; this rung just has nothing to
      // add about a value that is not a number.
      if (!USDC_RE.test(a.dailyCapUsdc ?? "") || !USDC_RE.test(a.perRequestUsdc ?? "")) continue;
      if (usdcUnits(a.perRequestUsdc) > usdcUnits(a.dailyCapUsdc)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", name, "perRequestUsdc"],
          message:
            "perRequestUsdc is above dailyCapUsdc, so the threshold is unreachable — a limit that reads as a limit while enforcing nothing",
        });
      }
      if (usdcUnits(a.dailyCapUsdc) === 0n || usdcUnits(a.perRequestUsdc) === 0n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents", name],
          message: "a zero cap or threshold cannot go live: freeze the agent instead, which says so",
        });
      }
    }
  });

export type Policy = z.infer<typeof PolicySchema>;

/**
 * A decimal USDC string to 6dp integer units, exactly.
 *
 * `Number(s) * 1e6` is the obvious version and it is wrong for the same reason
 * it is wrong in `prices.ts`: money through a double rounds, and the rounding
 * looks like a typo rather than a bug.
 */
export function usdcUnits(s: string): bigint {
  const [whole = "0", frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

export type Validated =
  | { ok: true; policy: Policy }
  | { ok: false; errors: string[] };

/**
 * Validate a candidate config.
 *
 * Returns every problem rather than the first, because a treasurer fixing a
 * policy one error per round trip will stop reading them.
 */
export function validate(input: unknown): Validated {
  let r: ReturnType<typeof PolicySchema.safeParse>;
  try {
    r = PolicySchema.safeParse(input);
  } catch (e) {
    // A validator that throws is worse than one that refuses: the caller asked
    // "is this safe to put on chain" and deserves an answer either way.
    return { ok: false, errors: [`(root): could not be validated — ${(e as Error).message}`] };
  }
  if (r.success) return { ok: true, policy: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => {
      const where = i.path.length > 0 ? i.path.join(".") : "(root)";
      return `${where}: ${i.message}`;
    }),
  };
}

/** The on-chain `Policy` tuple, in the vault's field order. */
export function toVaultPolicy(p: Policy) {
  return {
    maxPremiumBps: p.maxPremiumBps,
    humanMaxPremiumBps: p.humanMaxPremiumBps,
    maxPrintAge: p.maxPrintAge,
    upperBandBps: p.upperBandBps,
    lowerBandBps: p.lowerBandBps,
    workingShareBps: p.workingShareBps,
    bufferHours: p.bufferHours,
    minTicketUsdc: usdcUnits(p.minTicketUsdc),
  };
}
