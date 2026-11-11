/**
 * Lecture d'un ticket Jira Cloud via l'API REST.
 * On utilise l'API v2 : le champ `description` y est du texte brut (wiki markup),
 * alors que la v3 renvoie du JSON « ADF » plus lourd à aplatir.
 */

export interface JiraTicket {
  key: string;
  summary: string;
  description: string;
  issueType: string;
  priority: string;
  labels: string[];
  comments: { author: string; body: string }[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
}

export async function fetchJiraTicket(key: string): Promise<JiraTicket> {
  const baseUrl = requireEnv("JIRA_BASE_URL").replace(/\/$/, "");
  const auth = Buffer.from(
    `${requireEnv("JIRA_EMAIL")}:${requireEnv("JIRA_API_TOKEN")}`,
  ).toString("base64");

  const url =
    `${baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}` +
    `?fields=summary,description,issuetype,priority,labels,comment`;

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Jira a répondu ${res.status} pour ${key} : ${await res.text()}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  const f = data.fields ?? {};

  return {
    key: data.key,
    summary: f.summary ?? "",
    description: f.description ?? "(pas de description)",
    issueType: f.issuetype?.name ?? "inconnu",
    priority: f.priority?.name ?? "inconnue",
    labels: f.labels ?? [],
    comments: (f.comment?.comments ?? []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c: any) => ({ author: c.author?.displayName ?? "?", body: c.body ?? "" }),
    ),
  };
}
