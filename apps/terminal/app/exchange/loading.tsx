/* Streams instantly while the exchange floor awaits the live payload. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 68 * 8, marginTop: 8 }} />
      <div className="skel-gap">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skel skel-row" />
        ))}
      </div>
      <div className="skel skel-gap" style={{ height: 52 }} />
      <div className="skel skel-gap" style={{ height: 120 }} />
    </div>
  );
}
