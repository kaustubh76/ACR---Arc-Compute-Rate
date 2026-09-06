import { Bytes } from "@graphprotocol/graph-ts";
import {
  HumanClusterResolved,
  HumanClusterRebound,
  SignerSet,
} from "../generated/HumanIdMirror/HumanIdMirror";
import { HumanCluster } from "../generated/schema";
import { loadHumanCluster, loadPayer } from "./parties";
import { recordSigner } from "./witness";

/** Rebinding to this is how the owner clears a resolution. */
const ZERO32 = Bytes.fromHexString(
  "0x0000000000000000000000000000000000000000000000000000000000000000"
);

/**
 * A wallet joins a human's cluster for one rotation window.
 *
 * What arrives here is deliberately NOT a World ID nullifier — it is
 * `keccak256(nullifier, salt, window)`, so the durable identifier never reaches
 * the chain and this tape cannot be joined to another service's data keyed by
 * the same human. See HumanIdMirror.sol for why that prevents cross-service
 * correlation without making a fleet unlinkable.
 */
export function handleHumanClusterResolved(event: HumanClusterResolved): void {
  const now = event.block.timestamp;
  const window = event.params.window;
  const clusterId = event.params.clusterId;

  const cluster = loadHumanCluster(clusterId, window, event.params.sandbox, now);
  const payer = loadPayer(event.params.wallet, now);

  // Only count a wallet into the cluster once. The contract already refuses a
  // second cluster for a wallet inside one window, but the handler must not rely
  // on that: an event is a fact about the past, and a mapping that double counted
  // on a replayed log would overstate the number the human-denominated bound
  // rests on.
  const prior = payer.cluster;
  const priorWindow = payer.clusterWindow;
  let alreadyHere = false;
  if (prior !== null && priorWindow !== null) {
    alreadyHere = priorWindow!.equals(window) && prior!.equals(clusterId);
  }
  if (!alreadyHere) {
    cluster.walletCount = cluster.walletCount + 1;
  }

  // Did this wallet already settle inside the window it is only now being
  // resolved for? Then `Settlement.human` was stamped false on those fills and
  // the entity is immutable — its human volume is understated for good. A FLAG,
  // not a repair: repairing this count while the rollups it must agree with
  // cannot be repaired would leave two published numbers contradicting one
  // another. Resolve humans BEFORE generating tape.
  const lastSettled = payer.lastSettledWindow;
  if (lastSettled !== null && lastSettled!.equals(window)) {
    payer.resolvedLate = true;
  }

  payer.cluster = clusterId;
  payer.clusterWindow = window;
  payer.lastSeen = now;

  cluster.save();
  payer.save();
}

/**
 * The owner corrects a grouping.
 *
 * Rare and loud by construction: `record` cannot rebind, so every one of these is
 * a governance action someone took deliberately. Like a late resolution it does
 * NOT reach back into settlements already stamped, and for the same reason.
 */
export function handleHumanClusterRebound(event: HumanClusterRebound): void {
  const now = event.block.timestamp;
  const window = event.params.window;
  const to = event.params.to;
  const payer = loadPayer(event.params.wallet, now);

  // The payer carries only its most recent window. A correction to an older one
  // stays queryable on chain, but it cannot move a field that is no longer
  // describing that window.
  const priorWindow = payer.clusterWindow;
  if (priorWindow === null) return;
  if (!priorWindow!.equals(window)) return;

  // A rebind carries no provenance, so this path LOADS clusters and never
  // creates one: a cluster invented here would have to guess whether it stood
  // for a Sandbox identity or an Orb-verified person, and guessing on that
  // subject means claiming more than the tape knows. The contract refuses a
  // rebind into an unrecorded cluster for the same reason, so a missing entity
  // here means the log is ahead of the store rather than that a guess is needed.
  const prior = payer.cluster;
  if (prior !== null) {
    const old = HumanCluster.load(prior!);
    if (old !== null) {
      old.walletCount = old.walletCount - 1;
      old.save();
    }
  }

  if (to.equals(ZERO32)) {
    payer.cluster = null;
    payer.clusterWindow = null;
  } else {
    const next = HumanCluster.load(to);
    if (next === null) return; // unrecorded target — the contract refuses these
    next.walletCount = next.walletCount + 1;
    next.save();
    payer.cluster = to;
    payer.clusterWindow = window;
  }

  payer.lastSeen = now;
  payer.save();
}

export function handleHumanIdSignerSet(event: SignerSet): void {
  recordSigner(event, "HumanIdMirror", event.params.signer, event.params.allowed);
}
