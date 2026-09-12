/* What guards agent-to-agent traffic, and how to say it in one line.
 *
 * Shapes live here rather than in the route that fetches them, matching
 * lib/humans.ts: the proxy, the hook and the footer all need them, and a type
 * exported from a route handler is a type that moves when the route does.
 *
 * THE DISTINCTION THIS FILE EXISTS TO KEEP. A screen that fell back to its
 * offline floor and a screen that is inspecting nothing look identical from
 * outside — that sentence is in armor.py's own docstring, and it is the reason
 * `/armor/info` reports which backend answered. So `screenState` has four
 * outcomes, not two, and "unread" is never rendered as "off".
 */

/* Only the fields a surface RENDERS are declared. `/armor/info` and `/agent/info`
 * each answer with a dozen more (mode, template, roles, TTL bound…); those belong
 * to /ops and to the snippet on /developers, which read them from their own
 * routes. A field declared here and rendered nowhere was the shape of the last
 * audit's findings — a type that promised the footer said more than it did. */
export interface ArmorInfo {
  backend: string;
  screened: number;
  blocked: number;
  live: boolean;
}

export interface AgentGateInfo {
  audience: string;
  human_binding_verifiable: boolean;
  cards_verified: number;
  human_tier_granted: number;
}

export interface GateData {
  agent: AgentGateInfo | null;
  armor: ArmorInfo | null;
}

export type ScreenState = "unread" | "off" | "floor" | "live";

/** Which of four states the screen is in.
 *
 *  `unread` for a null info — the press did not answer, which is NOT "no screen".
 *  Returning "off" for an unread service would let a footer report a deliberate
 *  configuration where it should report its own blindness.
 *
 *  `floor` is the honest name for `LocalScreen`: six offline substrings, useful
 *  and not a screen in the sense the word implies. Reporting it as `live` is
 *  precisely the overclaim /armor/info was built to prevent.
 */
export function screenState(armor: ArmorInfo | null | undefined): ScreenState {
  if (armor == null) return "unread";
  if (armor.backend === "off") return "off";
  return armor.live && armor.backend === "gcp" ? "live" : "floor";
}

/** How many inspections the screen has actually performed, or null when unread.
 *
 *  Null rather than 0 for the same reason `countHumans` returns null: a screen
 *  nobody could ask and a screen that has inspected nothing are different facts,
 *  and before the screen had a call site at all this number was structurally
 *  stuck at zero — so a confident "0" is exactly the reading not to repeat. */
export function screenedCount(armor: ArmorInfo | null | undefined): number | null {
  if (armor == null || typeof armor.screened !== "number") return null;
  return armor.screened;
}

/** How many of those inspections refused something, or null when unread. Paired
 *  with `screenedCount` because "3 inspected" alone reads as a screen that passes
 *  everything, and "1 blocked" alone as one that has no idea what it let through. */
export function blockedCount(armor: ArmorInfo | null | undefined): number | null {
  if (armor == null || typeof armor.blocked !== "number") return null;
  return armor.blocked;
}
