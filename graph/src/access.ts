import { BigInt } from "@graphprotocol/graph-ts";
import { AccessGranted } from "../generated/FeedAccessAttestor/FeedAccessAttestor";
import { FeedAccess } from "../generated/schema";

/** Paid feed access, already mirrored on chain since block 55149161. */
export function handleAccessGranted(event: AccessGranted): void {
  const id = event.transaction.hash.concatI32(event.logIndex.toI32());
  const fa = new FeedAccess(id);
  fa.beneficiary = event.params.beneficiary;
  fa.payer = event.params.payer;
  fa.paidUntil = event.params.paidUntil;
  fa.amountUsdc = event.params.amountUsdc;
  fa.nonce = event.params.nonce;
  fa.blockTime = event.block.timestamp;
  fa.save();
}
