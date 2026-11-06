/* Streams instantly. The widget is a client component and the chunk is not
   small, so without this the page is blank for the length of that fetch. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 52 * 8, marginTop: "var(--s-3)" }} />
      <div className="skel-gap">
        <div className="skel skel-card" style={{ height: 180 }} />
      </div>
    </div>
  );
}
