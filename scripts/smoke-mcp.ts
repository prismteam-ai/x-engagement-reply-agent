/**
 * Live smoke test for the no-token investors-mcp path.
 *
 * Hits the real hosted MCP (no auth header) with a sample finance/crypto post
 * and prints the top Soofi-article matches plus their visible scores. Proves the
 * cred-free Streamable-HTTP path end to end.
 *
 * Run:  pnpm tsx scripts/smoke-mcp.ts
 *   or  pnpm tsx scripts/smoke-mcp.ts "custom query text"
 *
 * Override the endpoint with INVESTORS_MCP_URL.
 */
import { resolveInvestorsMcpUrl } from "@/mcp/investor-content-client";
import { getTopSoofiArticleSimilarities } from "@/matching/article-similarity";

const SAMPLE_POST =
  "On-chain property records and tokenized real-world assets could make ownership and liens verifiable, turning real estate title into programmable, composable financial infrastructure.";

async function main(): Promise<void> {
  const postText = process.argv[2] || SAMPLE_POST;
  const url = resolveInvestorsMcpUrl();

  console.log("=== investors-mcp smoke test (no token) ===");
  console.log(`Endpoint: ${url}`);
  console.log(`Query:    ${postText}\n`);

  const started = Date.now();
  const matches = await getTopSoofiArticleSimilarities(postText, { topK: 6 });
  const elapsedMs = Date.now() - started;

  console.log(`Got ${matches.length} top match(es) in ${elapsedMs}ms:\n`);
  if (matches.length === 0) {
    console.log("(no matches returned)");
    return;
  }

  for (const [index, match] of matches.entries()) {
    console.log(
      `${index + 1}. [rawScore=${match.rawScore.toFixed(4)} | score=${match.score}] ${match.title}`,
    );
    console.log(`   ${match.sourceUri}`);
    if (match.excerpt) {
      console.log(`   excerpt: ${match.excerpt.slice(0, 160)}`);
    }
    console.log("");
  }
}

main().catch((error) => {
  console.error("Smoke test failed:", error);
  process.exit(1);
});
