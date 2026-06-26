#!/usr/bin/env node
import "dotenv/config";

/**
 * Helper: print the Asana GIDs needed for config/settings.yaml.
 * Reads ASANA_PERSONAL_ACCESS_TOKEN from the environment (.env) and lists the
 * user, workspaces, projects, and the sections of each project, then emits a
 * ready-to-paste `asana:` config block.
 *
 * Usage: pnpm run asana:ids
 */
const API = "https://app.asana.com/api/1.0";

interface Named {
  gid: string;
  name?: string;
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Asana ${res.status} for ${path}: ${await res.text()}`);
  }
  const json = (await res.json()) as { data: T };
  return json.data;
}

async function main(): Promise<void> {
  const token = process.env.ASANA_PERSONAL_ACCESS_TOKEN;
  if (!token) {
    console.error("Set ASANA_PERSONAL_ACCESS_TOKEN in your .env first.");
    process.exitCode = 1;
    return;
  }

  const me = await get<Named & { workspaces?: Named[] }>("/users/me", token);
  console.log(`\nYou: ${me.name} (user gid = ${me.gid})  ← use as defaultAssignee / thresholdAssignee`);

  const workspaces = me.workspaces ?? [];
  console.log("\nWorkspaces:");
  for (const w of workspaces) console.log(`  - ${w.name}  gid = ${w.gid}`);

  const projects = await get<Named[]>("/projects", token);
  console.log("\nProjects:");
  for (const p of projects) console.log(`  - ${p.name}  gid = ${p.gid}`);

  console.log("\nSections per project:");
  for (const p of projects) {
    try {
      const sections = await get<Named[]>(`/projects/${p.gid}/sections`, token);
      console.log(`  ${p.name} (${p.gid}):`);
      for (const s of sections) console.log(`    - ${s.name}  gid = ${s.gid}`);
    } catch {
      console.log(`  ${p.name} (${p.gid}): (could not list sections)`);
    }
  }

  const firstWs = workspaces[0];
  const firstProj = projects[0];
  console.log("\n--- paste into config/settings.yaml (replace with your chosen ids) ---");
  console.log("asana:");
  console.log(`  workspace: "${firstWs?.gid ?? "<WORKSPACE_GID>"}"`);
  console.log(`  project: "${firstProj?.gid ?? "<PROJECT_GID>"}"`);
  console.log(`  section: ""`);
  console.log(`  defaultAssignee: "${me.gid}"`);
  console.log(`  thresholdAssignee: "${me.gid}"`);
  console.log(`  thresholdAssigneeRawScore: 0.8`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
