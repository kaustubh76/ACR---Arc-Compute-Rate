"use client";

import { Ed } from "@/components/Ed";
import { AddressChip } from "@/components/chain/AddressChip";
import type { FloatVaultState } from "@/lib/float";
import { CHAINS } from "@/lib/chainChoice";
import { fmtPrice } from "@/lib/format";
import { useChain } from "@/lib/useChain";
import { useFloatGate, useFloatVault, useFloatYield } from "@/lib/useLive";
import { ZERO_BYTES32 } from "@/lib/worldGate";

/* Who can touch the money, and who provably cannot.
 *
 * THE SECOND HALF OF A HEADING THAT HAS BEEN PROMISING IT. `app/float/view.tsx`
 * has said "One payment, and who touches the money" since the page shipped, and
 * only the payment was ever drawn. Eleven parties can hold, move or refuse this
 * float, and until now a reader had to read the contract to find that out.
 *
 * THE COLLAPSE IS DRAWN, NOT HIDDEN. `FloatVault` enforces a real separation of
 * duty at wiring time: the approver may not be an executor, and the executor may
 * not be the approver. But `wire()` points every governance slot at the deployer,
 * so on a chain where nobody has rotated them the owner, the approver, the guest
 * registrar and the studio key are ONE key. Drawing four separate parties there
 * would be the more flattering reading and the false one. So each role is
 * compared against `owner` and says so when it matches, which is the method
 * `lib/worldGate.ts:15-21` already uses for the go-live gate: a role still equal
 * to owner has provably never been rotated, and that is a fact about the chain
 * rather than a guess about the deployment.
 *
 * NULL IS NOT NO. The venue's four permissions are the only thing standing
 * between this treasury and its own money, and a throttled read of them comes
 * back `null`. `lib/float.ts:407-411` is blunt about why that matters: "the
 * venue has closed our exit" is the single most frightening sentence this panel
 * could print, and printing it out of a rate limit would be unforgivable. Three
 * states, always.
 *
 * TWO SLOTS THIS SURFACE DOES NOT READ. The executor and the keeper can both
 * move money and neither is exposed by any route here, so their rows carry the
 * permission and the enforcement and an ellipsis where the address would go.
 * An empty cell is honest; an invented one is not, and leaving the rows out
 * entirely would hide the two keys that submit spends and move float.
 *
 * The tri-state chip is deliberately a local copy of `Yield.tsx`'s `GateMark`
 * rather than a shared import: its labels differ per column here, and the words
 * belong in the component that says them. */

/** A role still equal to owner has provably never been rotated. */
const isOwner = (a: string | undefined, owner: string | undefined) =>
  Boolean(a && owner && a.toLowerCase() === owner.toLowerCase());

/** Holds money, never holds money, or we could not tell. Never two states. */
function Holds({ state, note }: { state: "holds" | "never" | "unread"; note?: string }) {
  if (state === "unread") {
    return (
      <span className="chip chip-sim">
        <Ed x="unread" p="unread" />
      </span>
    );
  }
  if (state === "never") {
    return (
      <span className="chip chip-teal">
        <Ed x="never" p="never" />
      </span>
    );
  }
  return (
    <span className="chip chip-gold">
      {note === undefined ? <Ed x="holds" p="holds" /> : <span className="num">{note}</span>}
    </span>
  );
}

/** One venue permission, as the venue answers it about our sleeve. */
function Gate({ open, name }: { open: boolean | null; name: string }) {
  return (
    <span className={open === null ? "chip chip-sim" : open ? "chip chip-teal" : "chip chip-breach"}>
      {name}
      {open === null ? " ?" : open ? " ok" : " shut"}
    </span>
  );
}

export function WhoTouches({ vault }: { vault: FloatVaultState }) {
  const { gate } = useFloatGate();
  const { earned } = useFloatYield();
  const { vault: envelope } = useFloatVault();
  const g = gate?.data?.gate;
  const y = earned?.data ?? null;
  const explorer = CHAINS[useChain()].profile.explorer;
  /* A part-read treasury reports fields ABSENT rather than zero, and an absent
     buffer is not an empty one. */
  const partial = Boolean(vault.partial || envelope?.data?.partial);

  const gates = y?.gates ?? null;
  const owner = g?.owner;
  const bound = g ? g.treasurerBinding.toLowerCase() !== ZERO_BYTES32 : null;

  /* Not read anywhere on this page, so not claimed anywhere on this page. */
  const unread = (
    <span className="label muted">
      <Ed x="not read here" p="not shown here" />
    </span>
  );

  return (
    <div className="table-scroll">
      <table className="sheet">
        <thead>
          <tr>
            <th>
              <Ed x="Party" p="Who" />
            </th>
            <th>
              <Ed x="Address" p="Address" />
            </th>
            <th>
              <Ed x="Holds float" p="Holds money" />
            </th>
            <th>
              <Ed x="What it may do with it" p="What it is allowed to do" />
            </th>
            <th>
              <Ed x="What enforces that" p="What stops it" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <Ed x="agent" p="the robot" />
            </td>
            <td>{vault.agents?.[0]?.agent_id ? <span className="mono">{vault.agents[0].name}</span> : unread}</td>
            <td>
              <Holds state="never" />
            </td>
            <td>
              <Ed x="asks, and nothing else. It signs no transfer and is nobody's payee." p="only asks. It never gets the money." />
            </td>
            <td>
              <span className="mono">test_the_agents_own_wallet_holds_nothing_before_and_after</span>
            </td>
          </tr>

          <tr>
            <td>
              <Ed x="treasury" p="the treasury" />
            </td>
            <td>{vault.vault ? <AddressChip address={vault.vault} explorer={explorer} /> : unread}</td>
            <td>
              <Holds
                note={vault.buffer_usdc === undefined ? undefined : `${fmtPrice(vault.buffer_usdc)} USDC`}
                state={partial && vault.buffer_usdc === undefined ? "unread" : "holds"}
              />
            </td>
            <td>
              <Ed
                x="pays an allowed seller, once the asking price clears the benchmark and the caps"
                p="pays a shop on the list, if the price is fair and within the limits"
              />
            </td>
            <td>
              <span className="mono">twelve rungs, then usdc.transfer</span>
            </td>
          </tr>

          <tr>
            <td>
              <Ed x="working sleeve" p="savings" />
            </td>
            <td>
              {vault.working ? <AddressChip address={vault.working.address} explorer={explorer} /> : unread}
            </td>
            <td>
              <Holds
                note={vault.working ? `${fmtPrice(vault.working.value_usdc)} USDC` : undefined}
                state={vault.working === undefined ? "unread" : vault.working === null ? "never" : "holds"}
              />
            </td>
            <td>
              <Ed
                x="returns the exact shortfall to the treasury, in the paying transaction"
                p="sends back exactly what is missing, in the same go"
              />
            </td>
            <td>
              <span className="mono">onlyTreasury</span>
            </td>
          </tr>

          <tr>
            <td>
              <Ed x="reserve sleeve" p="the reserve" />
            </td>
            <td>{vault.reserve ? <AddressChip address={vault.reserve.address} explorer={explorer} /> : unread}</td>
            <td>
              <Holds
                note={vault.reserve ? `${fmtPrice(vault.reserve.value_usdc)} USDC` : undefined}
                state={vault.reserve === undefined ? "unread" : vault.reserve === null ? "never" : "holds"}
              />
            </td>
            <td>
              {vault.reserve === null ? (
                <Ed x="nothing: no reserve is wired, so the pull skips it" p="nothing yet: it is not switched on" />
              ) : (
                <Ed x="returns the shortfall the working sleeve could not cover" p="covers what savings could not" />
              )}
            </td>
            <td>
              <span className="mono">onlyTreasury</span>
            </td>
          </tr>

          <tr>
            <td>
              <Ed x="yield venue" p="the savings provider" />{" "}
              <span className="chip chip-sim">
                <Ed x="not ours" p="not ours" />
              </span>
            </td>
            <td>{y?.venue ? <AddressChip address={y.venue} explorer={explorer} /> : unread}</td>
            <td>
              <Holds
                note={y?.value_usdc === undefined ? undefined : `${fmtPrice(y.value_usdc)} USDC`}
                state={y?.value_usdc === undefined ? "unread" : "holds"}
              />
            </td>
            <td>
              <Ed
                x="holds our deposit, and is the one party here that could refuse us our own exit"
                p="holds our spare money, and is the only one here that could stop us taking it back"
              />{" "}
              <Gate name="in" open={gates?.receive_assets ?? null} />{" "}
              <Gate name="out" open={gates?.send_shares ?? null} />
            </td>
            <td>
              <Ed
                x="nothing we control. We ask its four permissions rather than trust them."
                p="nothing we control. We ask it, rather than assume."
              />
            </td>
          </tr>

          <tr>
            <td>
              <Ed x="seller" p="the shop" />
            </td>
            <td>{vault.seller ? <AddressChip address={vault.seller} explorer={explorer} /> : unread}</td>
            <td>
              <Holds state="holds" />
            </td>
            <td>
              <Ed x="receives, and only if it is on this agent's own allowlist" p="gets paid, and only if it is on the list" />
            </td>
            <td>
              <span className="mono">allowedSeller[agentId][seller]</span>
            </td>
          </tr>

          <tr>
            <td>
              <Ed x="executor" p="the submitter" />
            </td>
            <td>{unread}</td>
            <td>
              <Holds state="never" />
            </td>
            <td>
              <Ed
                x="submits a spend and opens a checkpoint. It cannot change a policy, lift a band or approve."
                p="can ask for a payment. It cannot change the rules or approve one."
              />
            </td>
            <td>
              <span className="mono">onlyExecutor</span>
            </td>
          </tr>

          <tr>
            <td>
              <Ed x="keeper" p="the housekeeper" />
            </td>
            <td>{unread}</td>
            <td>
              <Holds state="never" />
            </td>
            <td>
              <Ed
                x="moves float between the buffer and the sleeves, and writes the prints. It can pay nobody."
                p="moves money between ready cash and savings. It can pay nobody."
              />
            </td>
            <td>
              <span className="mono">onlyKeeper</span>
            </td>
          </tr>

          <tr>
            <td>
              <Ed x="approver" p="the approver" />{" "}
              {g && isOwner(g.humanApprover, owner) ? (
                <span className="chip chip-sim">
                  <Ed x="same key as owner" p="same key as the owner" />
                </span>
              ) : null}
            </td>
            <td>{g ? <AddressChip address={g.humanApprover} explorer={explorer} /> : unread}</td>
            <td>
              <Holds state="never" />
            </td>
            <td>
              <Ed
                x="releases one parked spend, whose exact hash this contract opened, inside its window, once"
                p="can let one held payment through, once, before it expires"
              />
            </td>
            <td>
              <span className="mono">ecrecover against treasurerBinding</span>
            </td>
          </tr>

          <tr>
            <td>
              <Ed x="guest registrar" p="the sign-up key" />{" "}
              {g && isOwner(g.guestRegistrar, owner) ? (
                <span className="chip chip-sim">
                  <Ed x="same key as owner" p="same key as the owner" />
                </span>
              ) : null}
            </td>
            <td>{g ? <AddressChip address={g.guestRegistrar} explorer={explorer} /> : unread}</td>
            <td>
              <Holds state="never" />
            </td>
            <td>
              <Ed
                x="writes the fixed guest template and nothing else. It cannot reach an existing budget or pick a number."
                p="can give a visitor the standard budget. It cannot change anyone else's or choose the amount."
              />
            </td>
            <td>
              <span className="mono">onlyRegistrar, template only</span>
            </td>
          </tr>

          <tr>
            <td>
              <Ed x="owner" p="the owner" />
            </td>
            <td>{g ? <AddressChip address={g.owner} explorer={explorer} /> : unread}</td>
            <td>
              <Holds state="never" />
            </td>
            <td>
              <Ed
                x="wires the roles, sets the policy and the caps, pauses, and can withdraw the float outright"
                p="sets the rules and the limits, can switch it off, and can take the money out"
              />
            </td>
            <td>
              <span className="mono">onlyOwner, two-step transfer</span>
            </td>
          </tr>
        </tbody>
      </table>

      {bound === false ? (
        <Ed
          as="p"
          className="muted"
          style={{ fontSize: "var(--t-4)", marginTop: "var(--s-3)", maxWidth: "var(--measure)" }}
          x="No person is pinned to this treasury yet, so the approver row is a key rather than a human. Binding one is a single owner transaction and it cannot be undone or re-aimed."
          p="No person is tied to this account yet, so approvals are a key, not a human. Setting one is permanent."
        />
      ) : null}
    </div>
  );
}
