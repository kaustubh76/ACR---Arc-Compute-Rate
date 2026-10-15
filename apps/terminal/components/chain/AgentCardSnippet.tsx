"use client";

import { useState } from "react";

import { Ed } from "@/components/Ed";
import { normaliseCard } from "@/lib/agentcard";
import { readCardCheck, type CardVerdict } from "@/lib/cardCheck";

/* How an agent calls this — shown, in three languages, from the gate's own answer.
 *
 * Every value in the snippets below (the header name, the audience, the chain, the
 * domain, the lifetime bound, the roles) is read from /agent/challenge at the moment
 * the reader asks, never typed here. The argument is the same one app.py makes for
 * /agent/challenge reusing the gate's own challenge object: a snippet that hardcoded
 * what the gate accepts would keep being copied after the gate changed, and a
 * developer would spend an afternoon finding out why their card is a 401.
 *
 * Sibling of HumanProof: that one asks the 401 gate what it wants; this asks the
 * agent gate, and then writes the code for you.
 */

interface Challenge {
  header: string;
  audience: string;
  chain_id: number;
  domain: { name: string; version: string };
  roles: string[];
  max_ttl_seconds: number;
  human_binding?: { field: string; verified_against: string; optional: boolean };
}

type Lang = "curl" | "ts" | "py";

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="register-row" style={{ fontSize: 13 }}>
      <span className="muted" style={{ minWidth: 132 }}>
        {label}
      </span>
      <span className="mono">{children}</span>
    </div>
  );
}

/** The three snippets, built from the challenge. Pure, so a test can pin them. */
export function snippets(ch: Challenge, api: string): Record<Lang, string> {
  const { header, audience, chain_id: chain, domain, max_ttl_seconds: ttl } = ch;
  return {
    py: `# pip: this repo's acr_oracle_client. Sign with a LOCAL key; custody signers are refused.
from acr_oracle_client.agentcard import encode_header, mint, sign_card
from acr_oracle_client.signer import LocalKeySigner

signer = LocalKeySigner("0x<your 32-byte key>")
card = mint(signer.address, name="my-agent", role="reader",
            audience="${audience}", ttl_s=300)            # <= ${ttl}s or the gate refuses
# Optional: claim the human cluster HumanIdMirror records for this wallet THIS window.
# A claim the chain cannot confirm is a 401, not a downgrade.
#   card = mint(..., human_cluster="0x<64 hex>")
header = encode_header(card, sign_card(card, signer, ${chain}))

import urllib.request
req = urllib.request.Request("${api}/agent/whoami", headers={"${header}": header})
print(urllib.request.urlopen(req).read().decode())   # -> {"tier": "carded", ...}`,

    ts: `// npm: viem. The domain names NO verifyingContract; audience + a short lifetime replace it.
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount("0x<your 32-byte key>");
const issuedAt = Math.floor(Date.now() / 1000), expiresAt = issuedAt + 300; // <= ${ttl}s
const zero32 = "0x" + "00".repeat(32);
const message = {
  agent: account.address, name: "my-agent", role: "reader", audience: "${audience}",
  scopeHash: zero32, humanCluster: zero32,           // or the cluster the chain records for you
  issuedAt: BigInt(issuedAt), expiresAt: BigInt(expiresAt),
};
const signature = await account.signTypedData({
  domain: { name: "${domain.name}", version: "${domain.version}", chainId: ${chain} },
  types: { AgentCard: [
    { name: "agent", type: "address" }, { name: "name", type: "string" },
    { name: "role", type: "string" }, { name: "audience", type: "string" },
    { name: "scopeHash", type: "bytes32" }, { name: "humanCluster", type: "bytes32" },
    { name: "issuedAt", type: "uint64" }, { name: "expiresAt", type: "uint64" } ] },
  primaryType: "AgentCard", message,
});
const card = { agent: message.agent, audience: message.audience, expires_at: expiresAt,
  human_cluster: message.humanCluster, issued_at: issuedAt, name: message.name,
  role: message.role, scope_hash: message.scopeHash };
const res = await fetch("${api}/agent/whoami", {
  headers: { "${header}": btoa(JSON.stringify({ card, signature })) },
});
console.log(await res.json());                         // -> { tier: "carded", ... }`,

    curl: `# The header is base64(JSON({card, signature})). Mint it with either snippet above, then:
CARD="$(python3 -c 'print(open("card.b64").read().strip())')"

curl -s ${api}/agent/whoami \\
  -H "${header}: $CARD"
# {"tier":"carded","ident_kind":"agent-key", ...}   with a key of your own
# {"tier":"human", "ident_kind":"human-cluster", ...} when the chain ties it to a person

# Without a card, the same route still answers, and says how to stop being anonymous:
curl -s ${api}/agent/whoami
# {"tier":"anonymous","header":"${header}","challenge":"/agent/challenge"}`,
  };
}

export function AgentCardSnippet({ api }: { api: string }) {
  const [asking, setAsking] = useState(false);
  const [ch, setCh] = useState<Challenge | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>("py");
  const [copied, setCopied] = useState(false);
  /* "Check your card": the visitor's own AGENT-CARD value, sent once through
     /api/probe to GET /agent/whoami and read back. Component state only:
     never stored, never put in a URL. */
  const [draft, setDraft] = useState("");
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<CardVerdict | null>(null);
  const draftIsCard = normaliseCard(draft) !== null;

  async function checkCard() {
    setChecking(true);
    setVerdict(null);
    try {
      /* The gate's chain id rides along, so a refused card can be told the one
         number it most often gets wrong, without the reader first having to
         press "Ask the gate" above. */
      const gateChain = ch
        ? Promise.resolve<number | null>(ch.chain_id)
        : fetch("/api/probe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: "/agent/challenge" }),
          })
            .then((r) => r.json() as Promise<{ body?: string }>)
            .then((o) => (o.body ? Number((JSON.parse(o.body) as { chain_id?: unknown }).chain_id) || null : null))
            .catch(() => null);
      const res = await fetch("/api/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/agent/whoami", agent_card: draft }),
      });
      const out = (await res.json()) as { status?: number; body?: string; detail?: string };
      setVerdict(readCardCheck(res.status, out, Math.floor(Date.now() / 1000), await gateChain));
    } catch {
      setVerdict({ kind: "unreachable", reason: "could not reach the press from here. Press again" });
    } finally {
      setChecking(false);
    }
  }

  async function ask() {
    setAsking(true);
    setNote(null);
    try {
      const res = await fetch("/api/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "/agent/challenge" }),
      });
      const out = (await res.json()) as { body?: string; detail?: string };
      if (!out.body) throw new Error(out.detail ?? "no answer");
      setCh(JSON.parse(out.body) as Challenge);
    } catch {
      setNote("the press did not answer in time. It sleeps between visits, so press again");
    } finally {
      setAsking(false);
    }
  }

  const code = ch ? snippets(ch, api)[lang] : "";

  async function copy() {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — the text is selectable */
    }
  }

  return (
    <section className="section">
      <div className="section-head">
        <Ed x="The agent gate" p="The robot gate" className="label" />
      </div>

      <Ed
        as="p"
        className="muted"
        style={{ fontSize: 13, maxWidth: 68 * 9, marginTop: 0 }}
        x="An agent names itself with a signed card and the gate believes the key, not a registry: nobody is enrolled and there is no list to run. The card carries its own audience and a short lifetime in place of a contract address, and may claim a human the chain can confirm."
        p="A robot shows an ID card it made itself, no sign-up. It names the service it is for, expires fast, and can name the person behind it."
      />

      <button
        type="button"
        className="chip"
        onClick={ask}
        disabled={asking}
        style={{ cursor: asking ? "default" : "pointer" }}
      >
        <Ed x="Ask the gate what it wants" p="Ask what it needs" />
      </button>

      {/* CHECK YOUR OWN CARD. The gate explains every refusal; the page used to
          offer only a card it minted itself, so a team testing their agent had
          to read 401s off their own logs to learn what the gate made of it. */}
      <div className="register-row is-stacked" style={{ fontSize: 13, marginTop: 12 }}>
        <span className="muted">
          <Ed x="check your card" p="check your robot's ID" />
        </span>
        <span>
          <input
            type="text"
            className="mono"
            aria-label="your agent card header value"
            placeholder="eyJjYXJkIjp7… (the AGENT-CARD header value, never a private key)"
            value={draft}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setDraft(e.target.value);
              setVerdict(null);
            }}
            style={{ width: "100%", maxWidth: 520 }}
          />
          {draft.trim() && !draftIsCard ? (
            <span className="muted" style={{ display: "block", fontSize: 12, color: "var(--breach)" }}>
              <Ed
                x="Not a card: paste the AGENT-CARD header value itself, base64 that starts eyJ."
                p="That is not an ID card. Paste the value that starts with eyJ."
              />
            </span>
          ) : null}
        </span>
        <span>
          <button type="button" className="mini-btn green" onClick={checkCard} disabled={!draftIsCard || checking}>
            {checking ? <Ed x="checking…" p="checking…" /> : <Ed x="check it" p="check it" />}
          </button>
        </span>
      </div>
      {verdict ? (
        <div role="status" style={{ marginTop: 4 }}>
          {verdict.kind === "accepted" ? (
            <>
              <Row label={<Ed x="the gate says" p="the gate says" />}>
                <span className="green">{verdict.tier}</span>
                {verdict.identKind ? ` · ${verdict.identKind}` : null}
              </Row>
              <Row label={<Ed x="agent" p="robot" />}>{verdict.agent ?? "…"}</Row>
              <Row label={<Ed x="role · audience" p="kind · made out to" />}>
                {verdict.role ?? "…"} · {verdict.audience ?? "…"}
              </Row>
              <Row label={<Ed x="expires in" p="good for" />}>{verdict.expiresInS === null ? "…" : `${verdict.expiresInS}s`}</Row>
              {verdict.humanNote ? <Row label={<Ed x="human claim" p="real-person claim" />}>{verdict.humanNote}</Row> : null}
            </>
          ) : verdict.kind === "anonymous" ? (
            <Row label={<Ed x="the gate says" p="the gate says" />}>
              <Ed x="anonymous: the card did not reach the gate" p="no ID seen: the card did not arrive" />
            </Row>
          ) : verdict.kind === "refused" ? (
            <>
              <Row label={<Ed x="refused" p="refused" />}>
                <span className="vermilion">{verdict.reason}</span>
              </Row>
              {verdict.hint ? <Row label={<Ed x="what to change" p="what to fix" />}>{verdict.hint}</Row> : null}
            </>
          ) : (
            <Row label={<Ed x="no answer" p="no answer" />}>{verdict.reason}</Row>
          )}
        </div>
      ) : null}

      {ch && (
        <div style={{ marginTop: 14 }}>
          <Row label={<Ed x="header" p="sent as" />}>{ch.header}</Row>
          <Row label={<Ed x="audience" p="made out to" />}>{ch.audience}</Row>
          <Row label={<Ed x="chain" p="network" />}>{ch.chain_id}</Row>
          <Row label={<Ed x="domain" p="signed under" />}>
            {ch.domain.name} · v{ch.domain.version} · <Ed x="no verifyingContract" p="no contract address on purpose" />
          </Row>
          <Row label={<Ed x="lifetime" p="good for at most" />}>{ch.max_ttl_seconds}s</Row>
          <Row label={<Ed x="roles" p="kinds of caller" />}>{ch.roles.join(" · ")}</Row>
          {ch.human_binding && (
            <Row label={<Ed x="human claim" p="real-person claim" />}>
              {ch.human_binding.field} · <Ed x="checked against" p="confirmed by" /> {ch.human_binding.verified_against}
            </Row>
          )}

          <div style={{ marginTop: 14, display: "flex", gap: 6, alignItems: "center" }}>
            <Ed x="How an agent calls this" p="How a robot uses it" className="label" />
            {(["py", "ts", "curl"] as Lang[]).map((l) => (
              <button
                key={l}
                type="button"
                className={`mini-btn${lang === l ? " green" : ""}`}
                onClick={() => setLang(l)}
                aria-pressed={lang === l}
              >
                {l === "py" ? "Python" : l === "ts" ? "TypeScript" : "curl"}
              </button>
            ))}
          </div>
          <div className="specimen" style={{ marginTop: 8 }}>
            <button type="button" className="copy-btn" onClick={copy}>
              {copied ? "copied" : "copy"}
            </button>
            <pre style={{ maxHeight: 420, overflow: "auto", paddingRight: 64 }}>{code}</pre>
          </div>
          <Ed
            as="p"
            className="muted"
            style={{ fontSize: 12.5, marginTop: 8 }}
            x="Every value above came from the gate's own challenge just now. A snippet that hardcoded them would keep being copied after the gate changed."
            p="Everything in that code came from the gate itself just now, so it cannot be out of date."
          />
        </div>
      )}

      {note && (
        <p className="mono muted" role="status" style={{ fontSize: 12.5, marginTop: 12 }}>
          {note}
        </p>
      )}
    </section>
  );
}
