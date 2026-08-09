/* Decoding `AttestationRegistry`'s on-chain record into words.
 *
 * Split out from the reader for the reason readResult.ts states about itself:
 * `npm test` runs only lib/*.test.ts, so a decision that lives inside a route
 * handler is a decision nobody can assert on. The uint8 tables below ARE that
 * decision, and they are the one thing here that rots in silence — reorder the
 * Solidity enum and nothing throws, nothing goes empty, and /sellers quietly
 * prints "gpu" where the chain said "inference", under a fresh block number
 * that makes it look checked. The house splits this way twice already
 * (onchainCodec/onchain, futuresCodec/futuresOnchain).
 *
 * The encodings are documented in the struct itself, contracts/src/
 * AttestationRegistry.sol:13-14:
 *     uint8 service;     // 0=inference, 1=gpu, 2=data
 *     uint8 modelClass;  // 0=frontier,1=mid,2=small,3=open
 * lib/chain.test.ts asserts these tables against that file, so a Solidity
 * reorder fails a test instead of mislabelling every record.
 */

/** uint8 -> service, in the contract's declared order. */
export const SERVICE_BY_CODE = ["inference", "gpu", "data"] as const;

/** uint8 -> model class, in the contract's declared order. */
export const CLASS_BY_CODE = ["frontier", "mid", "small", "open"] as const;

/** A code the tables do not cover renders as `?<n>`, never as a guess.
 *
 *  A contract upgrade that adds a fourth service would otherwise silently
 *  label it `inference` (index 0 of a stale table) or crash the panel. Showing
 *  the raw number is the honest third option: the reader sees the chain said
 *  something this build does not know, which is true and checkable.
 */
export function nameFor(table: readonly string[], code: number): string {
  return table[code] ?? `?${code}`;
}

/** The `bytes32 schemaId` as the string it was packed from.
 *
 *  Mirrors registry.py's right-strip-then-utf8: the contract stores a short
 *  ASCII id ("openai/chat@1") zero-padded to 32 bytes. Trailing NULs are
 *  padding, not content, so they are stripped before decoding rather than
 *  after — a `\0` inside the decoded string would render as a box glyph.
 *  Returns "" for the zero word, which is what an unset schema is.
 */
export function schemaFromBytes32(hex: string): string {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes: number[] = [];
  for (let i = 0; i + 1 < body.length; i += 2) bytes.push(parseInt(body.slice(i, i + 2), 16));
  while (bytes.length && bytes[bytes.length - 1] === 0) bytes.pop();
  if (!bytes.length) return "";
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
  } catch {
    return "";
  }
}
