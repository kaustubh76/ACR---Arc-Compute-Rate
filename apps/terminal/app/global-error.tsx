"use client";

/* The presses-caught-fire page: rendered only when the ROOT LAYOUT itself
   throws, so nothing from globals.css or next/font can be assumed. Styles are
   inline against the same Arc palette, system fonts only. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000b24",
          color: "#d5e0e7",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          colorScheme: "dark",
        }}
      >
        <div style={{ maxWidth: 560, padding: "0 24px", textAlign: "center" }}>
          <p
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 11,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "#e9a13f",
            }}
          >
            ACR · The Arc Compute Rate
          </p>
          <h1 style={{ fontSize: 26, fontWeight: 500, margin: "12px 0" }}>
            The presses stopped mid-run.
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "#acc6e9" }}>
            The terminal shell hit a fault. Nothing on-chain is affected; the oracle keeps
            printing on Arc.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 18,
              padding: "10px 22px",
              background: "transparent",
              color: "#ffcc6f",
              border: "1px solid rgba(233, 161, 63, 0.5)",
              borderRadius: 999,
              fontSize: 13,
              letterSpacing: "0.08em",
              cursor: "pointer",
            }}
          >
            Restart the edition
          </button>
          {error?.digest ? (
            <p
              style={{
                marginTop: 20,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 11,
                color: "rgba(213, 224, 231, 0.45)",
              }}
            >
              digest: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
