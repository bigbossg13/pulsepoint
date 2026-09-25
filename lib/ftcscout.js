// Client for the FTCScout GraphQL API (https://ftcscout.org/api).
// Supplies team info, season stats (OPR-based quick stats), event status and
// which teams attended which events.
import { fetchJson } from "./http.js";

export const FTCSCOUT_URL = process.env.FTCSCOUT_URL || "https://api.ftcscout.org/graphql";

export async function gql(query, variables = {}) {
  const json = await fetchJson(FTCSCOUT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "pulsepoint-map" },
    body: JSON.stringify({ query, variables }),
  });
  if (json.errors?.length) {
    throw new Error(`FTCScout GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data;
}

const EVENT_FIELDS = `
  season code name type regionCode leagueCode divisionCode
  address location { venue city state country }
  start end timezone website liveStreamURL
  remote hybrid started ongoing finished
  teams { teamNumber }
`;

export async function fetchEvents(season) {
  const data = await gql(
    `query ($season: Int!) { eventsSearch(season: $season) { ${EVENT_FIELDS} } }`,
    { season },
  );
  return data.eventsSearch ?? [];
}

const TEAM_FIELDS = (season) => `
  number name schoolName city state country rookieYear website
  quickStats(season: ${season}) {
    tot { value rank } auto { value rank } dc { value rank } eg { value rank } count
  }
`;

// Fetches teams in batches using aliased teamByNumber lookups, which keeps
// each request small and avoids pulling every historical team.
export async function fetchTeams(season, numbers, { batchSize = 100, onProgress } = {}) {
  const teams = [];
  for (let i = 0; i < numbers.length; i += batchSize) {
    const batch = numbers.slice(i, i + batchSize);
    const fields = TEAM_FIELDS(Number(season));
    const query = `{ ${batch.map((n) => `t${n}: teamByNumber(number: ${Number(n)}) { ${fields} }`).join("\n")} }`;
    const data = await gql(query);
    for (const team of Object.values(data)) if (team) teams.push(team);
    onProgress?.(Math.min(i + batchSize, numbers.length), numbers.length);
  }
  return teams;
}
