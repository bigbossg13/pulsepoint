#!/usr/bin/env node
// Builds public/data/<season>.json by pulling from FTCScout and the FTC Events
// API, merging the two, and geocoding every team and event.
//
//   npm run build-data                    # current season
//   npm run build-data -- --season 2025   # a specific season
//   npm run build-data -- --geocode-limit 500
//
// FTC Events credentials (optional but recommended):
//   FTC_EVENTS_USERNAME=... FTC_EVENTS_TOKEN=...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as scout from "../lib/ftcscout.js";
import * as official from "../lib/ftcevents.js";
import { Geocoder, placeKey, spread } from "../lib/geocode.js";
import { attendanceFromEvents, mergeEvents, mergeTeams } from "../lib/merge.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// FTC seasons are named by their starting year and kick off in September.
export function currentSeason(now = new Date()) {
  return now.getUTCMonth() >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

const { values: args } = parseArgs({
  options: {
    season: { type: "string" },
    "geocode-limit": { type: "string" },
    out: { type: "string", default: join(root, "public", "data") },
  },
});

const season = Number(args.season ?? currentSeason());
const geocodeLimit = Number(args["geocode-limit"] ?? process.env.GEOCODE_LIMIT ?? Infinity);
const log = (...m) => console.log(`[${season}]`, ...m);

async function attempt(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[${season}] ${label} failed: ${err.message}`);
    return null;
  }
}

let officialEvents = null;
let officialTeams = null;
if (official.hasCredentials()) {
  log("FTC Events API: fetching events…");
  officialEvents = await attempt("FTC Events events", () => official.fetchEvents(season));
  log("FTC Events API: fetching teams…");
  officialTeams = await attempt("FTC Events teams", () =>
    official.fetchTeams(season, { onProgress: (p, t) => log(`  teams page ${p}/${t}`) }),
  );
} else {
  console.warn("FTC_EVENTS_USERNAME / FTC_EVENTS_TOKEN not set; skipping the FTC Events API.");
}

log("FTCScout: fetching events…");
const scoutEvents = await attempt("FTCScout events", () => scout.fetchEvents(season));
const attendance = attendanceFromEvents(scoutEvents ?? []);

const numbers = [...new Set([...(officialTeams ?? []).map((t) => t.teamNumber), ...attendance.keys()])].sort(
  (a, b) => a - b,
);
log(`FTCScout: fetching ${numbers.length} teams…`);
const scoutTeams = numbers.length
  ? await attempt("FTCScout teams", () =>
      scout.fetchTeams(season, numbers, {
        onProgress: (d, t) => (d % 1000 === 0 || d === t) && log(`  ${d}/${t} teams`),
      }),
    )
  : [];

if (!officialEvents && !officialTeams && !scoutEvents) {
  console.error("Neither FTCScout nor the FTC Events API returned data; aborting.");
  process.exit(1);
}

const merged = mergeTeams({ scoutTeams: scoutTeams ?? [], officialTeams: officialTeams ?? [], attendance });
// The FTC Events team list includes many teams that never compete in a given
// season. Once event rosters exist, keep only teams that attended an event or
// have stats; before that (early season) the registration list is all we have.
const teams = attendance.size ? merged.filter((t) => t.events?.length || t.stats?.tot) : merged;
if (teams.length < merged.length) log(`Dropped ${merged.length - teams.length} registered teams with no events this season.`);
const events = mergeEvents({ scoutEvents: scoutEvents ?? [], officialEvents: officialEvents ?? [] });

const geocoder = new Geocoder({ cachePath: join(root, "data", "geocache.json"), limit: geocodeLimit });
log(`Geocoding ${teams.length} teams and ${events.length} events (cache: ${Object.keys(geocoder.cache).length})…`);

const perPlace = new Map();
for (const team of teams) {
  const key = placeKey(team);
  const index = perPlace.get(key) ?? 0;
  perPlace.set(key, index + 1);
  const coords = await geocoder.place(team);
  team.loc = spread(coords, index) ?? null;
}
for (const ev of events) {
  if (ev.remote) {
    ev.loc = null;
    continue;
  }
  const address = [ev.address, ev.city, ev.state, ev.country].filter(Boolean).join(", ");
  ev.loc = (await geocoder.address(ev.address ? address : null, ev)) ?? null;
}
geocoder.save();
log(`Geocoder made ${geocoder.lookups} new lookups.`);

const dataset = {
  season,
  generatedAt: new Date().toISOString(),
  sources: { ftcscout: Boolean(scoutEvents), ftcEvents: Boolean(officialEvents || officialTeams) },
  teams,
  events,
};

mkdirSync(args.out, { recursive: true });
const manifestPath = join(args.out, "seasons.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : { seasons: [] };

// A season that hasn't started yet has nothing to show; leave it out of the
// season picker rather than defaulting visitors to an empty map.
if (!teams.length && !events.length) {
  log("No teams or events yet; not publishing this season.");
  manifest.seasons = manifest.seasons.filter((s) => s !== season);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  process.exit(0);
}

writeFileSync(join(args.out, `${season}.json`), JSON.stringify(dataset));
manifest.seasons = [...new Set([...manifest.seasons, season])].sort((a, b) => b - a);
manifest.updated = { ...manifest.updated, [season]: dataset.generatedAt };
manifest.withStats = { ...manifest.withStats, [season]: teams.filter((t) => t.stats?.tot).length };
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const mapped = teams.filter((t) => t.loc).length;
log(`Wrote ${teams.length} teams (${mapped} mapped) and ${events.length} events.`);
