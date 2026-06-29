import Link from "next/link";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>X Engagement Reply Agent</h1>
      <p style={{ color: "#9aa4b2", lineHeight: 1.6 }}>
        Public, no-login view of the latest organic run. Reply drafts are written
        by Amazon Bedrock and article matching uses the no-token investors-mcp
        endpoint. The pages below serve the saved run snapshot, so they never
        write to Asana.
      </p>
      <ul style={{ lineHeight: 1.9 }}>
        <li>
          <Link href="/status" style={{ color: "#5e9bff" }}>
            /status
          </Link>{" "}
          — public, no-login run summary, matches with visible scores, drafted
          replies, and would-be Asana tasks.
        </li>
        <li>
          <code>/api/monitor-x?dryRun=true&amp;author=exampleauthor</code> — run the
          monitor and return the run-summary JSON.
        </li>
      </ul>
    </main>
  );
}
