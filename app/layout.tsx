import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Decidueye — X Engagement Reply Agent",
  description:
    "Polls watched X authors, matches posts against Soofi article content via the hosted investors-mcp MCP, drafts prompt-driven replies, and prepares Asana approval tasks.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">
        <main className="mx-auto max-w-5xl px-5 py-8">{children}</main>
        <footer className="mx-auto max-w-5xl px-5 pb-10 pt-4 text-xs text-slate-500">
          Decidueye · standalone X Engagement Reply Agent · soofi.xyz Agent Network
        </footer>
      </body>
    </html>
  );
}
