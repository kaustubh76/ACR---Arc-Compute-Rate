/* Streams instantly while the queue is fetched. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 52 * 8, marginTop: "var(--s-3)" }} />
      {[0, 1].map((i) => (
        <div className="skel-gap" key={i}>
          <div className="skel skel-card" style={{ height: 160 }} />
        </div>
      ))}
    </div>
  );
}
