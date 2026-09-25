// Client for the FTCScout GraphQL API (https://ftcscout.org/api).
// Supplies team info, season stats (OPR-based quick stats), event status and
// which teams attended which events.
//
// Queries are built against the live schema (via introspection) so fields
// that FTCScout renames or removes are skipped instead of failing the build.
import { fetchJson } from "./http.js";

export const FTCSCOUT_URL = process.env.FTCSCOUT_URL || "https://api.ftcscout.org/graphql";

export async function gql(query, variables = {}) {
  const json = await fetchJson(FTCSCOUT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "pulsepoint-map" },
    body: JSON.stringify({ query, variables }),
  });
  if (json.errors?.length) {
    const messages = [...new Set(json.errors.map((e) => e.message))];
    throw new Error(`FTCScout GraphQL error: ${messages.join("; ")}`);
  }
  return json.data;
}

const INTROSPECTION = `{ __schema { types { name fields { name type { name ofType { name ofType { name ofType { name } } } } } } } }`;

const namedType = (t) => (t ? t.name ?? namedType(t.ofType) : null);

// typeName -> Map(fieldName -> named type of that field)
export async function loadSchema() {
  const data = await gql(INTROSPECTION);
  const schema = new Map();
  for (const type of data.__schema.types) {
    if (type.fields) schema.set(type.name, new Map(type.fields.map((f) => [f.name, namedType(f.type)])));
  }
  return schema;
}

// Builds a selection set containing only the wanted fields that exist.
// `spec` entries are field names, or [name, subSpec, args?] for object fields.
export function selection(schema, typeName, spec) {
  const fields = schema.get(typeName);
  if (!fields) return "";
  const parts = [];
  for (const entry of spec) {
    const [name, sub, args = ""] = Array.isArray(entry) ? entry : [entry];
    if (!fields.has(name)) continue;
    if (!sub) {
      parts.push(name);
      continue;
    }
    const inner = selection(schema, fields.get(name), sub);
    if (inner) parts.push(`${name}${args} { ${inner} }`);
  }
  return parts.join(" ");
}

const LOCATION = ["venue", "city", "state", "country"];

const EVENT_SPEC = [
  "season", "code", "name", "type", "regionCode", "leagueCode", "divisionCode",
  "address", ["location", LOCATION], "city", "state", "country",
  "start", "end", "timezone", "website", "liveStreamURL",
  "remote", "hybrid", "started", "ongoing", "finished",
  ["teams", ["teamNumber"]],
];

const STAT = ["value", "rank"];
const TEAM_SPEC = (season) => [
  "number", "name", "schoolName", "rookieYear", "website",
  ["location", LOCATION], "city", "state", "country",
  ["quickStats", [["tot", STAT], ["auto", STAT], ["dc", STAT], ["eg", STAT], "count"], `(season: ${Number(season)})`],
];

let schemaPromise;
const getSchema = () => (schemaPromise ??= loadSchema());

export async function fetchEvents(season) {
  const schema = await getSchema();
  const fields = selection(schema, "Event", EVENT_SPEC);
  const data = await gql(`query ($season: Int!) { eventsSearch(season: $season) { ${fields} } }`, { season });
  return data.eventsSearch ?? [];
}

// Fetches teams in batches using aliased teamByNumber lookups, which keeps
// each request small and avoids pulling every historical team.
export async function fetchTeams(season, numbers, { batchSize = 100, onProgress } = {}) {
  const schema = await getSchema();
  const fields = selection(schema, "Team", TEAM_SPEC(season));
  const teams = [];
  for (let i = 0; i < numbers.length; i += batchSize) {
    const batch = numbers.slice(i, i + batchSize);
    const query = `{ ${batch.map((n) => `t${n}: teamByNumber(number: ${Number(n)}) { ${fields} }`).join("\n")} }`;
    const data = await gql(query);
    for (const team of Object.values(data)) if (team) teams.push(team);
    onProgress?.(Math.min(i + batchSize, numbers.length), numbers.length);
  }
  return teams;
}
