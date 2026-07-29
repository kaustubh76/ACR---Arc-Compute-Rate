/* Streams instantly while the attack lab awaits the live payload. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 68 * 7, marginTop: 8 }} />
      <div className="lab" style={{ marginTop: 32 }}>
        <div>
          <div className="skel skel-line" style={{ maxWidth: 140 }} />
          <div className="skel" style={{ height: 40, maxWidth: 280, marginTop: 12 }} />
          <div className="skel" style={{ height: 44, maxWidth: 220, marginTop: 24 }} />
          <div className="skel skel-line" style={{ marginTop: 24 }} />
          <div className="skel skel-line" />
        </div>
        <div>
          <div className="skel skel-chart" style={{ height: 280 }} />
        </div>
      </div>
    </div>
  );
}
