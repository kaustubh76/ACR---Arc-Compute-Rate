import Link from "next/link";
import { Ed } from "@/components/Ed";

export default function NotFound() {
  return (
    <div className="editorial-404">
      <h1>
        <Ed x="No such page is published." p="That page doesn’t exist." />
      </h1>
      <Ed
        as="p"
        className="standfirst"
        style={{ marginTop: 8 }}
        x="The fixing you are looking for does not exist in this edition."
        p="There is nothing at this address — the front page has everything."
      />
      <p style={{ marginTop: 24 }}>
        <Link href="/" className="section-link">
          <Ed x="← Return to the Fixing" p="← Back to the front page" />
        </Link>
        <span className="muted" style={{ margin: "0 10px" }}>
          ·
        </span>
        <Link href="/companion" className="section-link">
          <Ed x="The reader’s companion →" p="New here? The reader’s companion →" />
        </Link>
      </p>
    </div>
  );
}
