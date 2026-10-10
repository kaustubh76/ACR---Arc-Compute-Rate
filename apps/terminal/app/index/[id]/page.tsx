import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadTerminal } from "@/lib/api";
import { serverChain } from "@/lib/serverChain";
import { isIndexId } from "@/lib/indices";
import { IndexView } from "./view";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `${decodeURIComponent(id)} · ACR` };
}

export default async function IndexPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  // 404 only for ids that aren't in the roster — a degraded payload missing a
  // known index must NOT hide the page (the client ladder can still read the
  // print straight from ACROracle); the view carries its own soft guard.
  if (!isIndexId(id)) notFound();
  const chain = await serverChain();
  const initial = await loadTerminal(chain);
  return <IndexView initial={initial} id={id} />;
}
