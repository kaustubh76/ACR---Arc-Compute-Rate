import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Attested } from "../generated/AttestationRegistry/AttestationRegistry";
import { Attestation } from "../generated/schema";
import { loadSeller } from "./parties";

/**
 * A seller's attested metadata — the hedonic features the rating tiers on.
 *
 * Attestations are immutable rows; `Seller.latestAttestation` points at the
 * newest by the signed `timestamp`, not by block order, because
 * `attestWithSig` lets a relayer submit an older signed attestation after a
 * newer one (AttestationRegistry guards replay with a nonce, not with ordering).
 */
export function handleAttested(event: Attested): void {
  const seller = loadSeller(event.params.seller, event.block.timestamp);

  const id = event.transaction.hash.concatI32(event.logIndex.toI32());
  const att = new Attestation(id);
  att.seller = seller.id;
  att.service = event.params.service;
  att.modelClass = event.params.modelClass;
  att.latencySloMs = event.params.latencySloMs.toI32(); // uint32 decodes as BigInt; an SLO in ms fits i32
  att.schemaId = event.params.schemaId;
  att.timestamp = event.params.timestamp;
  att.blockTime = event.block.timestamp;
  att.save();

  const current = seller.latestAttestation;
  if (current === null) {
    seller.latestAttestation = att.id;
  } else {
    const prev = Attestation.load(current as Bytes);
    if (prev == null || att.timestamp.ge(prev.timestamp)) {
      seller.latestAttestation = att.id;
    }
  }
  seller.lastSeen = event.block.timestamp;
  seller.save();
}
