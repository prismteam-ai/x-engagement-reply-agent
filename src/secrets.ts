import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { createLogger, type Logger } from "./observability/logger.js";

/**
 * Production credential loader. In Lambda the agent reads its credentials from a
 * single JSON secret in Secrets Manager (ARN in AGENT_SECRETS_ARN) rather than
 * from a committed .env file. Each key in the secret JSON is merged into
 * process.env (without overwriting anything already set), so the rest of the code
 * keeps reading the same env vars it does locally.
 *
 * No-op when AGENT_SECRETS_ARN is unset (local/dev uses .env). Secret VALUES are
 * never logged — only the set of keys loaded.
 *
 * Expected secret shape (JSON):
 *   { "OPENAI_API_KEY": "...", "X_BEARER_TOKEN": "...",
 *     "ASANA_PERSONAL_ACCESS_TOKEN": "...", "LANGSMITH_API_KEY": "..." }
 */
export async function loadSecretsIntoEnv(logger?: Logger): Promise<void> {
  const log = logger ?? createLogger("secrets");
  const secretId = process.env.AGENT_SECRETS_ARN;
  if (!secretId) {
    log.debug("AGENT_SECRETS_ARN unset — using process env / .env directly");
    return;
  }

  const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) {
    log.warn("secret has no SecretString — nothing to load");
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.SecretString) as Record<string, unknown>;
  } catch {
    throw new Error("AGENT_SECRETS_ARN secret is not valid JSON (expected an object of env vars).");
  }

  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue;
    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  // Log keys only — never values.
  log.info("secrets loaded from Secrets Manager", { keys: loaded });
}
