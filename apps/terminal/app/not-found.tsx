import Link from "next/link";

export default function NotFound() {
  return (
    <div className="editorial-404">
      <h1>No such page is published.</h1>
      <p className="standfirst" style={{ marginTop: 8 }}>
        The fixing you are looking for does not exist in this edition.
      </p>
      <p style={{ marginTop: 24 }}>
        <Link href="/" className="section-link">
          ← Return to the Fixing
        </Link>
      </p>
    </div>
  );
}
