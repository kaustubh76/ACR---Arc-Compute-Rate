/* Streams instantly while the developers page awaits the live payload. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 68 * 8, marginTop: 8 }} />
      <div className="skel skel-num" style={{ marginTop: 24 }} />
      <div className="skel" style={{ height: 220, marginTop: 32 }} />
      <div style={{ marginTop: 36 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="skel skel-row" />
        ))}
      </div>
    </div>
  );
}
