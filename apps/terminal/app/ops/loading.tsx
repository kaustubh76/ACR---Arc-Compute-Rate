/* Streams instantly while the ledger is fetched. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 68 * 8, marginTop: 8 }} />
      {[0, 1, 2].map((s) => (
        <div key={s} style={{ marginTop: 36 }}>
          <div className="skel skel-line" style={{ maxWidth: 180 }} />
          {[0, 1, 2].map((i) => (
            <div key={i} className="skel skel-row" />
          ))}
        </div>
      ))}
    </div>
  );
}
