/* Streams instantly while the vault is read. The shapes match what lands: a
   caption, the money path, and the ladder's twelve rungs. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="setting type">
      <div className="skel-caption" />
      <div className="skel skel-line" style={{ maxWidth: 58 * 8, marginTop: "var(--s-3)" }} />
      <div className="skel-gap">
        <div className="skel skel-chart" style={{ height: 180 }} />
      </div>
      <div className="skel-gap">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div className="skel skel-line" key={i} style={{ marginTop: "var(--s-3)" }} />
        ))}
      </div>
    </div>
  );
}
