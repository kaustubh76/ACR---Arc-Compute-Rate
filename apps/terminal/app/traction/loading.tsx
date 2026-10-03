/* Streams instantly while the numbers are counted. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 60 * 8, marginTop: 8 }} />
      <div className="skel skel-card" style={{ marginTop: 28 }} />
      {[0, 1].map((s) => (
        <div key={s} style={{ marginTop: 36 }}>
          <div className="skel skel-line" style={{ maxWidth: 190 }} />
          {[0, 1, 2].map((i) => (
            <div key={i} className="skel skel-row" />
          ))}
        </div>
      ))}
    </div>
  );
}
