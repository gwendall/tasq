import { ImageResponse } from "next/og";

export const alt = "Tasq - the project tracker you share with your agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-static";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#f5f2e9",
          color: "#181914",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 28, height: 28, background: "#d6ff3f", border: "3px solid #181914" }} />
          <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.04em" }}>tasq</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 78, fontWeight: 700, lineHeight: 1.02, letterSpacing: "-0.055em" }}>
            No duplicate work.
          </div>
          <div style={{ display: "flex", fontSize: 78, fontWeight: 700, lineHeight: 1.02, letterSpacing: "-0.055em" }}>
            Agents stay aligned.
          </div>
          <div style={{ display: "flex", marginTop: 28, fontSize: 30, color: "#56574f", maxWidth: 900 }}>
            The project tracker you share with your agents.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            background: "#181914",
            color: "#f5f2e9",
            padding: "18px 24px",
            fontSize: 26,
            alignSelf: "flex-start",
          }}
        >
          <span style={{ color: "#d6ff3f" }}>$</span>
          <span>npx @tasq-run/cli demo</span>
        </div>
      </div>
    ),
    size,
  );
}
