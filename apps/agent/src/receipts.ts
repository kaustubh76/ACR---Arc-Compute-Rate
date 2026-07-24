/** Settlement receipts — decoding, printing, and the judge-facing summary. */

import type { PaymentResult } from "./payer.js";

/** Decode the base64 PAYMENT-RESPONSE / X-PAYMENT-RESPONSE confirmation. */
export function decodeConfirmation(
  headers: Headers,
): { transaction: string; network: string; payer: string } | null {
  const raw = headers.get("PAYMENT-RESPONSE") ?? headers.get("X-PAYMENT-RESPONSE");
  if (!raw) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return {
      transaction: String(obj.transaction ?? obj.txHash ?? ""),
      network: String(obj.network ?? obj.networkId ?? ""),
      payer: String(obj.payer ?? ""),
    };
  } catch {
    return null;
  }
}

export function printReceipt(n: number, url: string, r: PaymentResult): void {
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  const tx = r.transaction || "(unsettled)";
  console.log(
    `  Nº ${String(n).padStart(3, " ")}  ${path.padEnd(24)} $${r.paidUsdc.toFixed(6)}  ${tx}`,
  );
}

export interface Summary {
  payments: number;
  totalUsdc: number;
  transactions: string[];
}

export function summarize(results: PaymentResult[]): Summary {
  return {
    payments: results.length,
    totalUsdc: results.reduce((s, r) => s + r.paidUsdc, 0),
    transactions: [...new Set(results.map((r) => r.transaction).filter(Boolean))],
  };
}

export function printSummary(s: Summary, mode: string): void {
  console.log("\n─ settlement summary ────────────────────────────");
  console.log(`  gate            ${mode}`);
  console.log(`  paid queries    ${s.payments}`);
  console.log(`  total spent     $${s.totalUsdc.toFixed(6)} USDC`);
  console.log(`  settlements     ${s.transactions.length} distinct tx refs`);
  if (s.transactions.length > 0) {
    console.log(`  first / last    ${s.transactions[0]} … ${s.transactions[s.transactions.length - 1]}`);
  }
}
