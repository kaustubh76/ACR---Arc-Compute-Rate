/* Streams instantly while the front page awaits the live payload. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="hero" style={{ marginTop: 10 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skel-card">
            <div className="skel skel-line" style={{ maxWidth: 120 }} />
            <div className="skel skel-num" style={{ marginTop: 14 }} />
            <div className="skel skel-line" style={{ maxWidth: 180, marginTop: 12 }} />
            <div className="skel" style={{ height: 36, marginTop: 14 }} />
          </div>
        ))}
      </div>
      <div className="skel skel-line" style={{ maxWidth: 68 * 8, marginTop: 36 }} />
      <div className="skel skel-line" style={{ maxWidth: 68 * 6 }} />
      <div style={{ marginTop: 36 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skel skel-row" />
        ))}
      </div>
    </div>
  );
}
