import { createAsanaClient, type AsanaClient } from "@soofi-xyz/chat-adapter-asana";

export type RuntimeEnv = Record<string, string | undefined>;

export type AsanaConfig = {
  accessToken: string;
  projectGid: string;
  workspaceGid: string;
  defaultAssigneeGid: string;
  thresholdAssigneeGid: string;
  sectionGid?: string;
  rawSimilarityFieldGid?: string;
  normalizedSimilarityFieldGid?: string;
};

export function isAsanaConfigured(env: RuntimeEnv = process.env): boolean {
  return Boolean(
    (env.ASANA_PAT ?? "").trim() &&
      (env.ASANA_PROJECT_GID ?? "").trim() &&
      (env.ASANA_WORKSPACE_GID ?? "").trim(),
  );
}

export function resolveAsanaConfig(env: RuntimeEnv = process.env): AsanaConfig {
  const accessToken = (env.ASANA_PAT ?? "").trim();
  if (!accessToken) {
    throw new Error("ASANA_PAT is not set — the Asana adapter requires a personal access token.");
  }
  const projectGid = (env.ASANA_PROJECT_GID ?? "").trim();
  if (!projectGid) {
    throw new Error("ASANA_PROJECT_GID is not set — required to place the created parent task.");
  }
  const workspaceGid = (env.ASANA_WORKSPACE_GID ?? "").trim();
  if (!workspaceGid) {
    throw new Error("ASANA_WORKSPACE_GID is not set — required by tasks.create.");
  }
  const defaultAssigneeGid = (env.ASANA_DEFAULT_ASSIGNEE_GID ?? "").trim();
  const thresholdAssigneeGid =
    (env.ASANA_THRESHOLD_ASSIGNEE_GID ?? "").trim() || defaultAssigneeGid;
  const sectionGid = (env.ASANA_SECTION_GID ?? "").trim();
  const rawSimilarityFieldGid = (env.ASANA_RAW_SIMILARITY_FIELD_GID ?? "").trim();
  const normalizedSimilarityFieldGid =
    (env.ASANA_NORMALIZED_SIMILARITY_FIELD_GID ?? "").trim();

  return {
    accessToken,
    projectGid,
    workspaceGid,
    defaultAssigneeGid,
    thresholdAssigneeGid,
    ...(sectionGid ? { sectionGid } : {}),
    ...(rawSimilarityFieldGid ? { rawSimilarityFieldGid } : {}),
    ...(normalizedSimilarityFieldGid ? { normalizedSimilarityFieldGid } : {}),
  };
}

export function createAsanaRestClient(
  config: Pick<AsanaConfig, "accessToken"> & { fetch?: typeof fetch; baseUrl?: string },
): AsanaClient {
  return createAsanaClient({
    accessToken: config.accessToken,
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });
}

export type { AsanaClient };
