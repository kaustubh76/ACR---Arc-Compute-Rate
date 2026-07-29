/* Streams instantly while the index-detail page awaits the live payload. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 160, marginTop: 8 }} />
      <div className="skel" style={{ height: 64, maxWidth: 380, marginTop: 16 }} />
      <div className="skel skel-chart" style={{ marginTop: 32 }} />
      <div className="lab-counters" style={{ marginTop: 32 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <div className="skel skel-num" style={{ height: 30, maxWidth: 110 }} />
            <div className="skel skel-line" style={{ maxWidth: 90, marginTop: 8 }} />
          </div>
        ))}
      </div>
      <div className="skel skel-row" style={{ marginTop: 32 }} />
      <div className="skel skel-row" />
    </div>
  );
}
