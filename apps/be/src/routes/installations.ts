import { getStore } from "../store";
import { badRequest, json } from "../utils";

export async function handleInstallationsSync(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Body must be JSON");
  }
  const repos = (body as { repos?: unknown })?.repos;
  if (!Array.isArray(repos) || repos.length === 0) {
    return badRequest("Body must include repos: [{owner, name, fullName}]");
  }
  const validated: Array<{ owner: string; name: string; fullName: string }> = [];
  for (const entry of repos) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return badRequest("Each repository must be an object");
    }
    const r = entry as Record<string, unknown>;
    const owner = typeof r.owner === "string" ? r.owner.trim() : "";
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const fullName = r.fullName === undefined
      ? `${owner}/${name}`
      : typeof r.fullName === "string" ? r.fullName.trim() : "";
    if (!owner || !name || !fullName) {
      return badRequest("Each repository must include non-empty owner, name and fullName strings");
    }
    validated.push({ owner, name, fullName });
  }
  const store = getStore();
  for (const repo of validated) {
    await store.ensureRepository(repo);
  }
  return json({ synced: validated.length });
}
