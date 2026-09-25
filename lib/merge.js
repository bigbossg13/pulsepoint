// Combines FTCScout and FTC Events API data into the compact dataset the map
// consumes. The official FTC Events API is treated as authoritative for
// registration/venue details; FTCScout contributes performance stats, event
// progress and attendance.

const TYPE_CATEGORIES = [
  [/first ?championship|world/i, "World Championship"],
  [/premier|super ?qual/i, "Premier"],
  [/league ?tournament/i, "League Tournament"],
  [/league ?meet/i, "League Meet"],
  [/championship/i, "Championship"],
  [/qualifier/i, "Qualifier"],
  [/scrimmage/i, "Scrimmage"],
  [/off ?season/i, "Off-Season"],
];

export function eventCategory(type) {
  const label = String(type ?? "").replace(/([a-z])([A-Z])/g, "$1 $2");
  for (const [re, category] of TYPE_CATEGORIES) if (re.test(label)) return category;
  return "Other";
}

const blank = (v) => v === undefined || v === null || v === "";
const pick = (...values) => values.find((v) => !blank(v)) ?? null;
const day = (d) => (d ? String(d).slice(0, 10) : null);

export function eventStatus({ started, ongoing, finished, start, end }, today = new Date().toISOString().slice(0, 10)) {
  if (finished) return "completed";
  if (ongoing) return "ongoing";
  if (started === false && start && start > today) return "upcoming";
  if (end && end < today) return "completed";
  if (start && start <= today) return "ongoing";
  return "upcoming";
}

function stat(s) {
  return s ? { v: round(s.value), r: s.rank } : null;
}
const round = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : null);

export function mergeTeams({ scoutTeams = [], officialTeams = [], attendance = new Map() }) {
  const byNumber = new Map();
  const get = (n) => {
    if (!byNumber.has(n)) byNumber.set(n, { number: n });
    return byNumber.get(n);
  };

  for (const t of officialTeams) {
    const team = get(t.teamNumber);
    Object.assign(team, {
      name: pick(t.nameShort, t.nameFull),
      school: pick(t.schoolName, t.nameFull !== t.nameShort ? t.nameFull : null),
      city: t.city || null,
      state: t.stateProv || null,
      country: t.country || null,
      rookieYear: t.rookieYear ?? null,
      website: t.website || null,
      robotName: t.robotName || null,
      region: t.homeRegion || null,
    });
  }

  for (const t of scoutTeams) {
    const team = get(t.number);
    team.name = pick(team.name, t.name);
    team.school = pick(team.school, t.schoolName);
    team.city = pick(team.city, t.city);
    team.state = pick(team.state, t.state);
    team.country = pick(team.country, t.country);
    team.rookieYear = pick(team.rookieYear, t.rookieYear);
    team.website = pick(team.website, t.website);
    const q = t.quickStats;
    if (q) {
      team.stats = { tot: stat(q.tot), auto: stat(q.auto), dc: stat(q.dc), eg: stat(q.eg), count: q.count ?? null };
    }
  }

  for (const [n, codes] of attendance) get(n).events = [...codes].sort();

  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export function mergeEvents({ scoutEvents = [], officialEvents = [], today }) {
  const byCode = new Map();
  const get = (code) => {
    const key = String(code).toUpperCase();
    if (!byCode.has(key)) byCode.set(key, { code });
    return byCode.get(key);
  };

  for (const e of officialEvents) {
    const ev = get(e.code);
    Object.assign(ev, {
      code: e.code,
      name: e.name,
      type: e.typeName || e.type || null,
      venue: e.venue || null,
      address: e.address || null,
      city: e.city || null,
      state: e.stateprov || null,
      country: e.country || null,
      start: day(e.dateStart),
      end: day(e.dateEnd),
      timezone: e.timezone || null,
      region: e.regionCode || null,
      league: e.leagueCode || null,
      division: e.divisionCode || null,
      website: e.website || null,
      liveStream: e.liveStreamUrl || null,
      remote: Boolean(e.remote),
      hybrid: Boolean(e.hybrid),
    });
  }

  for (const e of scoutEvents) {
    const ev = get(e.code);
    ev.code = pick(ev.code, e.code);
    ev.name = pick(ev.name, e.name);
    ev.type = pick(ev.type, e.type);
    ev.venue = pick(ev.venue, e.location?.venue);
    ev.address = pick(ev.address, e.address);
    ev.city = pick(ev.city, e.location?.city);
    ev.state = pick(ev.state, e.location?.state);
    ev.country = pick(ev.country, e.location?.country);
    ev.start = pick(ev.start, day(e.start));
    ev.end = pick(ev.end, day(e.end));
    ev.timezone = pick(ev.timezone, e.timezone);
    ev.region = pick(ev.region, e.regionCode);
    ev.league = pick(ev.league, e.leagueCode);
    ev.division = pick(ev.division, e.divisionCode);
    ev.website = pick(ev.website, e.website);
    ev.liveStream = pick(ev.liveStream, e.liveStreamURL);
    ev.remote = Boolean(ev.remote || e.remote);
    ev.hybrid = Boolean(ev.hybrid || e.hybrid);
    ev.teams = (e.teams ?? []).map((t) => t.teamNumber).sort((a, b) => a - b);
    ev.progress = { started: e.started, ongoing: e.ongoing, finished: e.finished };
  }

  return [...byCode.values()]
    .map(({ progress, ...ev }) => ({
      ...ev,
      category: eventCategory(ev.type),
      status: eventStatus({ ...progress, start: ev.start, end: ev.end }, today),
      teams: ev.teams ?? [],
    }))
    .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "") || a.code.localeCompare(b.code));
}

// teamNumber -> Set(eventCode), from FTCScout event rosters.
export function attendanceFromEvents(scoutEvents) {
  const map = new Map();
  for (const e of scoutEvents) {
    for (const { teamNumber } of e.teams ?? []) {
      if (!map.has(teamNumber)) map.set(teamNumber, new Set());
      map.get(teamNumber).add(e.code);
    }
  }
  return map;
}
