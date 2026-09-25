import assert from "node:assert/strict";
import { test } from "node:test";
import { attendanceFromEvents, eventCategory, eventStatus, mergeEvents, mergeTeams } from "../lib/merge.js";
import { Geocoder, spread } from "../lib/geocode.js";

const scoutEvents = [
  {
    season: 2025, code: "USCAQ1", name: "SoCal Qualifier", type: "Qualifier",
    address: "123 Main St", location: { venue: "High School", city: "Irvine", state: "CA", country: "USA" },
    start: "2025-11-08", end: "2025-11-08", started: true, ongoing: false, finished: true,
    remote: false, hybrid: false, liveStreamURL: null, teams: [{ teamNumber: 13 }, { teamNumber: 42 }],
  },
  {
    season: 2025, code: "FTCCMP1", name: "World Championship", type: "FIRSTChampionship",
    address: null, location: { venue: "GRB", city: "Houston", state: "TX", country: "USA" },
    start: "2026-04-29", end: "2026-05-02", started: false, ongoing: false, finished: false, teams: [{ teamNumber: 13 }],
  },
];

const officialTeams = [
  { teamNumber: 13, nameShort: "Thirteen", nameFull: "Thirteen Robotics Club", schoolName: "Some HS",
    city: "Irvine", stateProv: "CA", country: "USA", rookieYear: 2015, robotName: "Lucky", homeRegion: "USCASO" },
];
const scoutTeams = [
  { number: 13, name: "13 (scout)", location: { city: "Irvine", state: "CA", country: "USA" }, rookieYear: 2015,
    quickStats: { tot: { value: 123.456, rank: 2 }, auto: { value: 40, rank: 5 }, dc: { value: 60, rank: 3 }, eg: { value: 23.4, rank: 9 }, count: 3 } },
  { number: 42, name: "Answer", location: { city: "Irvine", state: "CA", country: "USA" }, rookieYear: 2025, quickStats: null },
];

test("event categories normalise both APIs' type labels", () => {
  assert.equal(eventCategory("LeagueMeet"), "League Meet");
  assert.equal(eventCategory("League Meet"), "League Meet");
  assert.equal(eventCategory("FIRSTChampionship"), "World Championship");
  assert.equal(eventCategory("Championship"), "Championship");
  assert.equal(eventCategory("SuperQualifier"), "Premier");
  assert.equal(eventCategory("OffSeason"), "Off-Season");
  assert.equal(eventCategory("Kickoff"), "Other");
});

test("event status prefers FTCScout progress, falls back to dates", () => {
  assert.equal(eventStatus({ finished: true }), "completed");
  assert.equal(eventStatus({ ongoing: true }), "ongoing");
  assert.equal(eventStatus({ start: "2025-01-01", end: "2025-01-02" }, "2025-06-01"), "completed");
  assert.equal(eventStatus({ start: "2025-06-01", end: "2025-06-02" }, "2025-06-01"), "ongoing");
  assert.equal(eventStatus({ start: "2025-07-01" }, "2025-06-01"), "upcoming");
});

test("teams prefer FTC Events registration data and take stats from FTCScout", () => {
  const teams = mergeTeams({ scoutTeams, officialTeams, attendance: attendanceFromEvents(scoutEvents) });
  assert.equal(teams.length, 2);
  const [t13, t42] = teams;
  assert.equal(t13.name, "Thirteen");
  assert.equal(t13.robotName, "Lucky");
  assert.deepEqual(t13.stats.tot, { v: 123.46, r: 2 });
  assert.deepEqual(t13.events, ["FTCCMP1", "USCAQ1"]);
  assert.equal(t42.name, "Answer");
  assert.equal(t42.city, "Irvine");
  assert.equal(t42.stats, undefined);
});

test("events merge by code, keeping official venue data and FTCScout rosters", () => {
  const events = mergeEvents({
    scoutEvents,
    officialEvents: [{ code: "USCAQ1", name: "SoCal Qualifier #1", typeName: "Qualifier", venue: "Official HS",
      address: "123 Main Street", city: "Irvine", stateprov: "CA", country: "USA", dateStart: "2025-11-08T00:00:00", dateEnd: "2025-11-08T00:00:00",
      liveStreamUrl: "https://twitch.tv/x", remote: false }],
    today: "2026-01-01",
  });
  const q = events.find((e) => e.code === "USCAQ1");
  assert.equal(q.name, "SoCal Qualifier #1");
  assert.equal(q.venue, "Official HS");
  assert.equal(q.start, "2025-11-08");
  assert.equal(q.status, "completed");
  assert.deepEqual(q.teams, [13, 42]);
  const w = events.find((e) => e.code === "FTCCMP1");
  assert.equal(w.category, "World Championship");
  assert.equal(w.status, "upcoming");
});

test("geocoder caches results and falls back from city to country", async () => {
  const calls = [];
  const geo = new Geocoder({
    fetcher: async (p) => {
      calls.push(p);
      return p.city === "Nowhere" ? null : [1, 2];
    },
  });
  assert.deepEqual(await geo.place({ city: "Irvine", state: "CA", country: "USA" }), [1, 2]);
  assert.deepEqual(await geo.place({ city: "Irvine", state: "CA", country: "USA" }), [1, 2]);
  assert.equal(calls.length, 1);
  assert.deepEqual(await geo.place({ city: "Nowhere", country: "USA" }), [1, 2]);
  assert.deepEqual(calls.at(-1), { country: "USA" });
});

test("spread keeps the first team in place and nudges the rest", () => {
  assert.deepEqual(spread([10, 20], 0), [10, 20]);
  const moved = spread([10, 20], 3);
  assert.notDeepEqual(moved, [10, 20]);
  assert.ok(Math.abs(moved[0] - 10) < 0.05 && Math.abs(moved[1] - 20) < 0.05);
});
