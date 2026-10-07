"use client";

import Link from "next/link";

import { Ed } from "@/components/Ed";
import { LoopFlow } from "@/components/loop/LoopFlow";
import { PersonNotWallet } from "@/components/loop/PersonNotWallet";
import { ScreenLab } from "@/components/loop/ScreenLab";
import { TierColumns } from "@/components/loop/TierColumns";
import type { TerminalData } from "@/lib/types";
import { useConnection } from "@/lib/useConnection";
import type { Envelope } from "@/lib/types";

/* /loop — the page a visitor drives.
 *
 * Everything else on the Terminal shows the loop; this page hands over the
 * controls. Four instruments, each fed by the same routes the rest of the site
 * reads and each with one thing to press: drive the loop for a wallet and move
 * the agent's threshold; call the gate three ways; send a message through
 * Google Cloud Model Armor; prove a person and watch three wallets become one
 * bill. Nothing here spends, and no key of the visitor's is ever asked for.
 */

export function LoopView({ initial }: { initial: Envelope<TerminalData> }) {
  const conn = useConnection(initial);
  const data: TerminalData = conn.env.data;
  /* The press naps between visits on the free tier. Every instrument below is
     told so, and says so on its button, instead of sitting dead or timing out
     without a word — the first press a judge makes is the one that would. */
  const wake = { waking: conn.state === "waking", wakeS: conn.wakeRemainingS ?? null };

  return (
    <>
      <p className="label">
        <Ed x="Machine commerce, driven from the browser" p="Robots buying, with you at the controls" />
      </p>
      <h1 className="display" style={{ fontSize: 42, marginTop: 6 }}>
        <Ed x="The loop" p="The loop" />
      </h1>
      <Ed
        as="p"
        className="standfirst"
        style={{ marginTop: 10 }}
        x="A payment is benchmarked the moment it lands; the buyer reads its own bill and changes shops; the gate knows who is calling, screens what they send, and bills a person rather than a wallet. Press the buttons."
        p="Each buy is checked against the fair rate as it lands, the robot reads its bill and switches shops, and the gate knows who is asking."
      />

      <LoopFlow wake={wake} />
      <TierColumns wake={wake} />
      <ScreenLab wake={wake} />
      <PersonNotWallet data={data} wake={wake} />

      <section className="section">
        <div className="section-head">
          <Ed x="Read on" p="Read on" className="label" />
        </div>
        <div className="btn-row">
          <Link href="/tape" className="chip"><Ed x="Read the tape →" p="See the receipts →" /></Link>
          <Link href="/developers" className="chip"><Ed x="For coders →" p="For coders →" /></Link>
          <Link href="/ops" className="chip"><Ed x="Ops console →" p="Systems ledger →" /></Link>
        </div>
      </section>
    </>
  );
}
