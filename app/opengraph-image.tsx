import { ImageResponse } from "next/og";

export const alt = "Web Cursor — AI React Playground";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#080807",
          color: "#f7f4ec",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "center",
          padding: "72px",
          width: "100%",
        }}
      >
        <div
          style={{
            color: "#f25516",
            display: "flex",
            fontSize: 30,
            fontWeight: 700,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
          }}
        >
          Web Cursor
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 76,
            fontWeight: 600,
            letterSpacing: "-0.045em",
            marginTop: 28,
            textAlign: "center",
          }}
        >
          Generate. Run. Repair.
        </div>
        <div
          style={{
            color: "#c7bca8",
            display: "flex",
            fontSize: 32,
            marginTop: 28,
            textAlign: "center",
          }}
        >
          AI React projects with browser runtime feedback
        </div>
      </div>
    ),
    size,
  );
}
