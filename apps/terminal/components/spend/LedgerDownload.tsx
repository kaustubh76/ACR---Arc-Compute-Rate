"use client";

import { useState } from "react";
import { Ed } from "@/components/Ed";
import { apiKey } from "@/lib/chainChoice";
import { cardHeaders, readerCardNow } from "@/lib/readerCard";
import { useChain } from "@/lib/useChain";

/* The beancount download, which cannot be a link any more.
 *
 * A LINK CANNOT CARRY A HEADER. That is the whole reason this component exists.
 * The ledger was `<a href download>`, which is the right markup for a file and
 * stops being possible the moment the file needs a credential: a browser
 * navigation sends cookies and nothing else, so with `ACR_OPERATOR_READ_SCOPE`
 * on, clicking it would download a 401 as a file named `acr-fleet.beancount`.
 *
 * THE ALTERNATIVE WAS A CARD IN THE QUERY STRING, and it is worth writing down
 * why it was refused: a URL is written to access logs, kept in history, sent in
 * a `Referer`, and is the only thing a shared cache keys on. A download link
 * carrying a bearer token leaks it to all four at once. Fetching with a header
 * and saving a Blob costs this file; a card in a URL would have cost nothing
 * and been wrong.
 *
 * IT STILL WORKS WITH NO CARD. With the flag unset the fetch simply has no
 * header, the press answers 200, and the reader gets the same file they always
 * did. This is not a gate — it is the same download, able to carry a credential
 * when there is one.
 *
 * THE FILENAME COMES FROM THE PRESS, not from here. The proxy already sets
 * `Content-Disposition: attachment; filename="<slug>.beancount"` and a
 * same-origin fetch can read it, so the name a reader gets is still the press's
 * decision and the two cannot drift. The slug is the fallback, not the source.
 *
 * It lives beside `EscalationActions` rather than under a new `traction/`
 * folder: it is a spend artifact that /traction happens to link to, and
 * `lib/coverage.test.ts` carries one entry either way.
 */

type Phase = "idle" | "working" | "refused" | "failed" | "absent";

/** `filename="x.beancount"` out of a Content-Disposition, or null.
 *
 *  Deliberately small: only the unquoted and double-quoted forms this proxy
 *  actually emits. A full RFC 6266 parser (RFC 5987 `filename*`, encodings,
 *  continuations) would be more code than the header it reads, for a header we
 *  write ourselves one file away. Exported so a test can hold it. */
export function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const m = /filename="([^"]+)"|filename=([^;]+)/.exec(disposition);
  const name = (m?.[1] ?? m?.[2] ?? "").trim();
  // A server-set name reaches a filesystem, so only a basename is accepted: a
  // `filename` carrying a slash or a `..` is not a name, whoever sent it.
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  return name;
}

export function LedgerDownload({ slug }: { slug: string }) {
  const chain = useChain();
  const [phase, setPhase] = useState<Phase>("idle");

  async function save() {
    setPhase("working");
    let url: string | null = null;
    try {
      const res = await fetch(
        apiKey(`/api/operator/ledger?business=${encodeURIComponent(slug)}`, chain),
        { headers: cardHeaders(readerCardNow()) },
      );
      if (res.status === 401 || res.status === 403) {
        setPhase("refused");
        return;
      }
      if (res.status === 404) {
        /* NOT "RETRY". A 404 here is the press having no ledger route, and
           `res.status` was being read and thrown away while all three of 404,
           502 and 504 collapsed into a button inviting an action that cannot
           succeed. The proxy beside this one already refuses to flatten a
           refusal into a bad gateway for the same reason. */
        setPhase("absent");
        return;
      }
      if (!res.ok) {
        setPhase("failed");
        return;
      }
      const blob = await res.blob();
      url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFrom(res.headers.get("Content-Disposition")) ?? `${slug}.beancount`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setPhase("idle");
    } catch {
      setPhase("failed");
    } finally {
      // Revoked in `finally`: a Blob held by an object URL is held until the tab
      // closes, and this page lists one of these per business.
      if (url) URL.revokeObjectURL(url);
    }
  }

  if (phase === "refused") {
    return (
      <span className="label">
        <Ed x="ledger · needs a card" p="the file · needs your card" />
      </span>
    );
  }

  if (phase === "absent") {
    return (
      <span className="label">
        <Ed x="ledger · not on this press" p="the file · not on this service" />
      </span>
    );
  }

  return (
    <button
      type="button"
      className="section-link"
      onClick={() => void save()}
      disabled={phase === "working"}
    >
      {phase === "working" ? (
        <Ed x="ledger · saving" p="the file · saving" />
      ) : phase === "failed" ? (
        <Ed x="ledger · retry" p="the file · try again" />
      ) : (
        <Ed x="ledger" p="the file" />
      )}
    </button>
  );
}
