/* Streams instantly while the loop awaits the live payload. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 68 * 7, marginTop: 8 }} />
      <div className="flow" style={{ marginTop: 32 }}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flow-station">
            <div className="skel skel-card" style={{ height: 96 }} />
          </div>
        ))}
      </div>
      <div className="skel skel-line" style={{ marginTop: 24 }} />
      <div className="skel skel-line" />
    </div>
  );
}
