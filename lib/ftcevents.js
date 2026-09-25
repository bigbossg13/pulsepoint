// Client for the official FIRST FTC Events API
// (https://ftc-events.firstinspires.org/services/API). Requires a free API
// key: set FTC_EVENTS_USERNAME and FTC_EVENTS_TOKEN.
import { fetchJson } from "./http.js";

export const FTC_EVENTS_URL = process.env.FTC_EVENTS_URL || "https://ftc-api.firstinspires.org/v2.0";

export function hasCredentials(env = process.env) {
  return Boolean(env.FTC_EVENTS_USERNAME && env.FTC_EVENTS_TOKEN);
}

function authHeaders(env = process.env) {
  const token = Buffer.from(`${env.FTC_EVENTS_USERNAME}:${env.FTC_EVENTS_TOKEN}`).toString("base64");
  return { authorization: `Basic ${token}`, accept: "application/json" };
}

export async function fetchEvents(season) {
  const json = await fetchJson(`${FTC_EVENTS_URL}/${season}/events`, { headers: authHeaders() });
  return json.events ?? [];
}

// All teams registered for the season (paged).
export async function fetchTeams(season, { onProgress } = {}) {
  const teams = [];
  let page = 1;
  let pageTotal = 1;
  do {
    const json = await fetchJson(`${FTC_EVENTS_URL}/${season}/teams?page=${page}`, { headers: authHeaders() });
    teams.push(...(json.teams ?? []));
    pageTotal = json.pageTotal ?? 1;
    onProgress?.(page, pageTotal);
    page++;
  } while (page <= pageTotal);
  return teams;
}
