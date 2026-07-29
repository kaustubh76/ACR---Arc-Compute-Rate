import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadTerminal } from "@/lib/api";
import { isIndexId } from "@/lib/indices";
import { IndexView } from "./view";

export const dynamic = "force-dynamic";

export function generateMetadata({ params }: { params: { id: string } }): Metadata {
  return { title: `${decodeURIComponent(params.id)} — ACR` };
}

export default async function IndexPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  // 404 only for ids that aren't in the roster — a degraded payload missing a
  // known index must NOT hide the page (the client ladder can still read the
  // print straight from ACROracle); the view carries its own soft guard.
  if (!isIndexId(id)) notFound();
  const initial = await loadTerminal();
  return <IndexView initial={initial} id={id} />;
}
