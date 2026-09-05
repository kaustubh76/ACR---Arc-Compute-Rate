import { BigInt, Bytes, ethereum, Address } from "@graphprotocol/graph-ts";
import { newMockEvent } from "matchstick-as";
import { PricePosted } from "../generated/ACROracle/ACROracle";
import { Traded, SeriesOpened } from "../generated/ACRFutures/ACRFutures";
import { SettlementOpened, SettlementFinalized } from "../generated/ReceiptMirror/ReceiptMirror";
import { PricePosted as PricePostedV2 } from "../generated/ACROracleV2/ACROracleV2";

export const PAYER = Address.fromString("0x00000000000000000000000000000000000000a1");
export const SELLER = Address.fromString("0x00000000000000000000000000000000000000b2");

/** A deterministic bytes32 id from a label, so tests read as names not hex. */
export function sidBytes(label: string): Bytes {
  const raw = Bytes.fromUTF8(label);
  const padded = new Uint8Array(32);
  for (let i = 0; i < raw.length && i < 32; i++) padded[i] = raw[i];
  return Bytes.fromUint8Array(padded);
}

/** Right-pad an index id to bytes32, exactly as acr_oracle_client does. */
export function indexIdBytes(id: string): Bytes {
  const raw = Bytes.fromUTF8(id);
  const padded = new Uint8Array(32);
  for (let i = 0; i < raw.length; i++) padded[i] = raw[i];
  return Bytes.fromUint8Array(padded);
}

export function wad(x: i32): BigInt {
  return BigInt.fromI32(x).times(BigInt.fromString("1000000000000000000"));
}

/**
 * A PricePosted event with an explicit block timestamp.
 *
 * `postedAt` is the block time, NOT the signed economic `timestamp` — the two
 * are deliberately different in these fixtures so a test that confuses them fails.
 */
export function pricePosted(
  index: string,
  value: BigInt,
  economicTs: i32,
  blockTs: i32,
  logIndex: i32
): PricePosted {
  const mock = newMockEvent();
  const ev = new PricePosted(
    mock.address, BigInt.fromI32(logIndex), mock.transactionLogIndex,
    mock.logType, mock.block, mock.transaction, mock.parameters, mock.receipt
  );
  ev.block.timestamp = BigInt.fromI32(blockTs);
  ev.block.number = BigInt.fromI32(1000 + logIndex);
  ev.logIndex = BigInt.fromI32(logIndex);
  ev.parameters = new Array<ethereum.EventParam>();
  ev.parameters.push(new ethereum.EventParam("indexId", ethereum.Value.fromFixedBytes(indexIdBytes(index))));
  ev.parameters.push(new ethereum.EventParam("value", ethereum.Value.fromUnsignedBigInt(value)));
  ev.parameters.push(new ethereum.EventParam("ciLo", ethereum.Value.fromUnsignedBigInt(value.minus(BigInt.fromI32(1)))));
  ev.parameters.push(new ethereum.EventParam("ciHi", ethereum.Value.fromUnsignedBigInt(value.plus(BigInt.fromI32(1)))));
  ev.parameters.push(new ethereum.EventParam("attackCostPerBp", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1234))));
  ev.parameters.push(new ethereum.EventParam("timestamp", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(economicTs))));
  ev.parameters.push(new ethereum.EventParam("signer", ethereum.Value.fromAddress(Address.fromString("0x0000000000000000000000000000000000000abc"))));
  return ev;
}

export function seriesOpened(seriesId: i32, index: string): SeriesOpened {
  const mock = newMockEvent();
  const ev = new SeriesOpened(
    mock.address, mock.logIndex, mock.transactionLogIndex,
    mock.logType, mock.block, mock.transaction, mock.parameters, mock.receipt
  );
  ev.parameters = new Array<ethereum.EventParam>();
  ev.parameters.push(new ethereum.EventParam("seriesId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(seriesId))));
  ev.parameters.push(new ethereum.EventParam("indexId", ethereum.Value.fromFixedBytes(indexIdBytes(index))));
  ev.parameters.push(new ethereum.EventParam("expiryTs", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(999999))));
  ev.parameters.push(new ethereum.EventParam("multiplier", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1))));
  ev.parameters.push(new ethereum.EventParam("maker", ethereum.Value.fromAddress(Address.fromString("0x0000000000000000000000000000000000000dad"))));
  return ev;
}

export function traded(seriesId: i32, mark: BigInt, blockTs: i32, logIndex: i32): Traded {
  const mock = newMockEvent();
  const ev = new Traded(
    mock.address, BigInt.fromI32(logIndex), mock.transactionLogIndex,
    mock.logType, mock.block, mock.transaction, mock.parameters, mock.receipt
  );
  ev.block.timestamp = BigInt.fromI32(blockTs);
  ev.block.number = BigInt.fromI32(2000 + logIndex);
  ev.logIndex = BigInt.fromI32(logIndex);
  ev.parameters = new Array<ethereum.EventParam>();
  ev.parameters.push(new ethereum.EventParam("seriesId", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(seriesId))));
  ev.parameters.push(new ethereum.EventParam("taker", ethereum.Value.fromAddress(Address.fromString("0x00000000000000000000000000000000000000ff"))));
  ev.parameters.push(new ethereum.EventParam("qty", ethereum.Value.fromSignedBigInt(BigInt.fromI32(2))));
  ev.parameters.push(new ethereum.EventParam("mark", ethereum.Value.fromUnsignedBigInt(mark)));
  return ev;
}

/** The entity id a mapping derives for an event — txHash ++ logIndex. */
export function eventId(ev: ethereum.Event): string {
  return ev.transaction.hash.concatI32(ev.logIndex.toI32()).toHexString();
}

/** A ReceiptMirror SettlementOpened, with explicit block time and settledAt. */
export function settlementOpened(
  sid: string,
  index: string,
  amountUsdc: BigInt,
  settledAt: i32,
  blockTs: i32,
  logIndex: i32,
  synthetic: boolean = true,
  late: boolean = false
): SettlementOpened {
  const mock = newMockEvent();
  const ev = new SettlementOpened(
    mock.address, BigInt.fromI32(logIndex), mock.transactionLogIndex,
    mock.logType, mock.block, mock.transaction, mock.parameters, mock.receipt
  );
  ev.block.timestamp = BigInt.fromI32(blockTs);
  ev.block.number = BigInt.fromI32(3000 + logIndex);
  ev.logIndex = BigInt.fromI32(logIndex);
  ev.parameters = new Array<ethereum.EventParam>();
  ev.parameters.push(new ethereum.EventParam("settlementId", ethereum.Value.fromFixedBytes(sidBytes(sid))));
  ev.parameters.push(new ethereum.EventParam("payer", ethereum.Value.fromAddress(PAYER)));
  ev.parameters.push(new ethereum.EventParam("seller", ethereum.Value.fromAddress(SELLER)));
  ev.parameters.push(new ethereum.EventParam("indexId", ethereum.Value.fromFixedBytes(indexIdBytes(index))));
  ev.parameters.push(new ethereum.EventParam("amountUsdc", ethereum.Value.fromUnsignedBigInt(amountUsdc)));
  ev.parameters.push(new ethereum.EventParam("settledAt", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(settledAt))));
  ev.parameters.push(new ethereum.EventParam("mirrorLagSeconds", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(blockTs - settledAt))));
  ev.parameters.push(new ethereum.EventParam("gatewayRef", ethereum.Value.fromFixedBytes(sidBytes("ref-" + sid))));
  ev.parameters.push(new ethereum.EventParam("synthetic", ethereum.Value.fromBoolean(synthetic)));
  ev.parameters.push(new ethereum.EventParam("late", ethereum.Value.fromBoolean(late)));
  return ev;
}

export function settlementFinalized(
  sid: string,
  quantity: BigInt,
  blockTs: i32,
  logIndex: i32
): SettlementFinalized {
  const mock = newMockEvent();
  const ev = new SettlementFinalized(
    mock.address, BigInt.fromI32(logIndex), mock.transactionLogIndex,
    mock.logType, mock.block, mock.transaction, mock.parameters, mock.receipt
  );
  ev.block.timestamp = BigInt.fromI32(blockTs);
  ev.block.number = BigInt.fromI32(4000 + logIndex);
  ev.logIndex = BigInt.fromI32(logIndex);
  ev.parameters = new Array<ethereum.EventParam>();
  ev.parameters.push(new ethereum.EventParam("settlementId", ethereum.Value.fromFixedBytes(sidBytes(sid))));
  ev.parameters.push(new ethereum.EventParam("payer", ethereum.Value.fromAddress(PAYER)));
  ev.parameters.push(new ethereum.EventParam("seller", ethereum.Value.fromAddress(SELLER)));
  ev.parameters.push(new ethereum.EventParam("unit", ethereum.Value.fromI32(0)));
  ev.parameters.push(new ethereum.EventParam("quantity", ethereum.Value.fromUnsignedBigInt(quantity)));
  ev.parameters.push(new ethereum.EventParam("finalizeLagSeconds", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(5))));
  return ev;
}

/**
 * A v2 PricePosted — the same economic print as `pricePosted`, plus the four
 * fields that make it reproducible. `economicTs` is what identifies the print;
 * `blockTs` is when THIS oracle happened to post it.
 */
export function pricePostedV2(
  index: string,
  value: BigInt,
  economicTs: i32,
  blockTs: i32,
  logIndex: i32,
  policy: string = "acr.cleaning.v1",
  humanBound: BigInt = BigInt.zero()
): PricePostedV2 {
  const mock = newMockEvent();
  const ev = new PricePostedV2(
    mock.address, BigInt.fromI32(logIndex), mock.transactionLogIndex,
    mock.logType, mock.block, mock.transaction, mock.parameters, mock.receipt
  );
  ev.block.timestamp = BigInt.fromI32(blockTs);
  ev.block.number = BigInt.fromI32(5000 + logIndex);
  ev.logIndex = BigInt.fromI32(logIndex);
  ev.parameters = new Array<ethereum.EventParam>();
  ev.parameters.push(new ethereum.EventParam("indexId", ethereum.Value.fromFixedBytes(indexIdBytes(index))));
  ev.parameters.push(new ethereum.EventParam("policyHash", ethereum.Value.fromFixedBytes(sidBytes(policy))));
  ev.parameters.push(new ethereum.EventParam("signer", ethereum.Value.fromAddress(Address.fromString("0x0000000000000000000000000000000000000abc"))));
  ev.parameters.push(new ethereum.EventParam("value", ethereum.Value.fromUnsignedBigInt(value)));
  ev.parameters.push(new ethereum.EventParam("ciLo", ethereum.Value.fromUnsignedBigInt(value.minus(BigInt.fromI32(1)))));
  ev.parameters.push(new ethereum.EventParam("ciHi", ethereum.Value.fromUnsignedBigInt(value.plus(BigInt.fromI32(1)))));
  ev.parameters.push(new ethereum.EventParam("attackCostPerBp", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1234))));
  ev.parameters.push(new ethereum.EventParam("humanAdjustedBound", ethereum.Value.fromUnsignedBigInt(humanBound)));
  ev.parameters.push(new ethereum.EventParam("windowStart", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(economicTs - 3600))));
  ev.parameters.push(new ethereum.EventParam("windowEnd", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(economicTs))));
  ev.parameters.push(new ethereum.EventParam("timestamp", ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(economicTs))));
  return ev;
}
