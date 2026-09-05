import { BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { CollateralFlow, PauseChange, SignerChange } from "../generated/schema";

/**
 * The events that are not prices but are still evidence.
 *
 * A tape that only carries prices cannot answer three questions a sceptical
 * reader will ask: who was allowed to sign this, was the feed deliberately
 * stopped, and did any money actually move. Each is a two-field event nobody
 * was indexing.
 */

export function recordSigner(
  event: ethereum.Event,
  contractName: string,
  signer: Bytes,
  allowed: boolean
): void {
  const rec = new SignerChange(event.transaction.hash.concatI32(event.logIndex.toI32()));
  rec.contract = event.address;
  rec.contractName = contractName;
  rec.signer = signer;
  rec.allowed = allowed;
  rec.blockTime = event.block.timestamp;
  rec.block = event.block.number;
  rec.save();
}

export function recordPause(
  event: ethereum.Event,
  contractName: string,
  paused: boolean
): void {
  const rec = new PauseChange(event.transaction.hash.concatI32(event.logIndex.toI32()));
  rec.contract = event.address;
  rec.contractName = contractName;
  rec.paused = paused;
  rec.blockTime = event.block.timestamp;
  rec.block = event.block.number;
  rec.save();
}

export function recordCollateral(
  event: ethereum.Event,
  seriesId: string,
  trader: Bytes,
  amount: BigInt,
  deposited: boolean
): void {
  const rec = new CollateralFlow(event.transaction.hash.concatI32(event.logIndex.toI32()));
  rec.series = seriesId;
  rec.trader = trader;
  rec.amount = amount;
  rec.deposited = deposited;
  rec.blockTime = event.block.timestamp;
  rec.block = event.block.number;
  rec.save();
}
