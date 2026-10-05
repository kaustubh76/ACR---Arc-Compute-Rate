/* Streams instantly while the statement is fetched. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 62 * 8, marginTop: 8 }} />
      <div className="skel skel-card skel-gap" />
      {[0, 1].map((s) => (
        <div className="skel-gap" key={s}>
          <div className="skel skel-line" style={{ maxWidth: 200 }} />
          {[0, 1, 2].map((i) => (
            <div key={i} className="skel skel-row" />
          ))}
        </div>
      ))}
    </div>
  );
}
