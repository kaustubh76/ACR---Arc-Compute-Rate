/* Streams instantly while the exchange floor awaits the live payload. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 68 * 8, marginTop: 8 }} />
      <div style={{ marginTop: 36 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skel skel-row" />
        ))}
      </div>
      <div className="skel" style={{ height: 52, marginTop: 36 }} />
      <div className="skel" style={{ height: 120, marginTop: 36 }} />
    </div>
  );
}
