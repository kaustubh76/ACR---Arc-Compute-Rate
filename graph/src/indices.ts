import { Bytes } from "@graphprotocol/graph-ts";

/**
 * Decode an ACROracle `bytes32 indexId` back to its string id.
 *
 * The poster encodes with `raw.ljust(32, b"\x00")` (acr_oracle_client/client.py
 * :28), i.e. right-padded ASCII — not a keccak hash — so the id is recoverable
 * and the subgraph can key on "ACR-INF" rather than on an opaque word.
 */
export function decodeIndexId(indexId: Bytes): string {
  let out = "";
  for (let i = 0; i < indexId.length; i++) {
    const c = indexId[i];
    if (c == 0) break; // right-padded: the first NUL ends the string
    out += String.fromCharCode(c);
  }
  return out;
}
