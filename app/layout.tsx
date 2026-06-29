import type { ReactNode } from "react";

export const metadata = {
  title: "X Engagement Reply Agent",
  description:
    "Cred-free dry-run status for the X Engagement Reply Agent: matches, scores, drafted replies, and would-be Asana tasks.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
          background: "#0b0e14",
          color: "#e6e6e6",
        }}
      >
        {children}
      </body>
    </html>
  );
}
