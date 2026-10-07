/* The human proof, minted where a developer can watch it happen.
 *
 * Mirrors `scripts/prove_human.py::proof_header` field for field: a CAIP-122
 * ("Sign-In With X") message naming the gate's single-use nonce and the resource
 * the proof is for, signed EIP-191 by the wallet, carried as base64 JSON — the
 * shape `AgentKitVerifier` in humanid.py recovers. Isomorphic like `agentcard.ts`,
 * and used from exactly one place: the server-side prove route, which signs with
 * the demo human's key. A visitor's own key is never asked for.
 */

export interface HumanProofOptions {
  privateKey: `0x${string}`;
  /** The nonce the 401 challenge issued. Single use; spent on presentation. */
  nonce: string;
  /** The resource the challenge is bound to — a proof for another route is refused. */
  resource: string;
  /** The gate's host, named in the message the way SIWE names its domain. */
  host: string;
}

export interface HumanProofPayload {
  address: `0x${string}`;
  nonce: string;
  issuedAt: string;
  uri: string;
  chainId: string;
  signedMessage: string;
  signature: `0x${string}`;
  type: "eip191";
}

/** The CAIP-122 message text. Exported so a test can pin it without signing. */
export function humanProofMessage(host: string, address: string, resource: string, nonce: string, issuedAt: string): string {
  return (
    `${host} wants you to sign in with your account:\n${address}\n\n` +
    `URI: ${resource}\nVersion: 1\nChain ID: 480\nNonce: ${nonce}\nIssued At: ${issuedAt}`
  );
}

/** Sign the challenge. Returns the header value and the signing address. */
export async function signHumanChallenge(opts: HumanProofOptions): Promise<{ header: string; address: `0x${string}`; payload: HumanProofPayload }> {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(opts.privateKey);
  const issuedAt = new Date().toISOString();
  const raw = humanProofMessage(opts.host, account.address, opts.resource, opts.nonce, issuedAt);
  const signature = await account.signMessage({ message: raw });
  const payload: HumanProofPayload = {
    address: account.address,
    nonce: opts.nonce,
    issuedAt,
    uri: opts.resource,
    chainId: "eip155:480",
    signedMessage: raw,
    signature,
    type: "eip191",
  };
  // ASCII throughout (hex, ISO date, plain text), so `btoa` is safe in both runtimes.
  return { header: btoa(JSON.stringify(payload)), address: account.address, payload };
}
