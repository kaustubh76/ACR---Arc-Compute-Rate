/* Streams instantly while the term-structure page awaits the live payload. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 68 * 7, marginTop: 8 }} />
      <div className="skel skel-chart" style={{ height: 280, marginTop: 32 }} />
      <div style={{ marginTop: 36 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skel skel-row" />
        ))}
      </div>
    </div>
  );
}
