/* global L */
// PulsePoint: interactive map of FTC teams and events.
// Data is prebuilt by scripts/build-data.js from FTCScout + the FTC Events API.

const STATUSES = [
  ["upcoming", "Upcoming"],
  ["ongoing", "Live now"],
  ["completed", "Completed"],
];
const CATEGORIES = [
  "Qualifier",
  "League Meet",
  "League Tournament",
  "Championship",
  "Premier",
  "World Championship",
  "Scrimmage",
  "Off-Season",
  "Other",
];
const DEFAULT_CATEGORIES = new Set(CATEGORIES.filter((c) => c !== "Other"));

// Discrete buckets keep the legend readable; index 0 = lowest.
const COLOR_MODES = {
  opr: {
    title: "Season OPR, world rank",
    buckets: ["Bottom 50%", "Top 50%", "Top 25%", "Top 10%", "Top 5%", "Top 1%"],
    none: "No matches yet",
    bucket(team, ctx) {
      const rank = team.stats?.tot?.r;
      if (!rank || !ctx.ranked) return -1;
      const p = rank / ctx.ranked;
      if (p <= 0.01) return 5;
      if (p <= 0.05) return 4;
      if (p <= 0.1) return 3;
      if (p <= 0.25) return 2;
      if (p <= 0.5) return 1;
      return 0;
    },
  },
  rookie: {
    title: "Team experience",
    buckets: ["10+ seasons", "6–9 seasons", "3–5 seasons", "2 seasons", "", "Rookie"],
    none: "Unknown",
    bucket(team, ctx) {
      if (!team.rookieYear) return -1;
      const age = ctx.season - team.rookieYear;
      if (age <= 0) return 5;
      if (age === 1) return 3;
      if (age <= 4) return 2;
      if (age <= 8) return 1;
      return 0;
    },
  },
  none: {
    title: "Teams",
    buckets: ["", "", "Team", "", "", ""],
    none: null,
    bucket: () => 2,
  },
};

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 1) => (typeof n === "number" ? n.toFixed(d) : "–");
const place = (o) => [o.city, o.state, o.country].filter(Boolean).join(", ");
const dateRange = (e) => {
  if (!e.start) return "Date TBA";
  const opts = { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" };
  const a = new Date(`${e.start}T00:00:00Z`).toLocaleDateString(undefined, opts);
  if (!e.end || e.end === e.start) return a;
  return `${a} – ${new Date(`${e.end}T00:00:00Z`).toLocaleDateString(undefined, opts)}`;
};
const seasonLabel = (s) => `${s}–${String(s + 1).slice(-2)}`;

const state = {
  season: null,
  data: null,
  teamsByNumber: new Map(),
  eventsByCode: new Map(),
  markers: { teams: new Map(), events: new Map() },
  filters: {
    country: "",
    state: "",
    showTeams: true,
    showEvents: true,
    onlyStats: false,
    colorBy: "opr",
    statuses: new Set(STATUSES.map(([s]) => s)),
    categories: new Set(DEFAULT_CATEGORIES),
  },
  selected: null, // { kind: "team" | "event", id }
  ctx: { ranked: 0, season: 0 },
};

// ---------------------------------------------------------------------------
// Map setup

const map = L.map("map", { preferCanvas: true, worldCopyJump: true, zoomControl: true, minZoom: 2 }).setView(
  [30, -30],
  2,
);
const renderer = L.canvas({ padding: 0.5 });
const dark = matchMedia("(prefers-color-scheme: dark)");
// Standard OpenStreetMap tiles need no API key. They're toned down (and
// inverted in dark mode) with a CSS filter on .basemap so markers stand out.
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  className: "basemap",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
dark.addEventListener?.("change", () => renderAll());

const colorFor = (bucket) => (bucket < 0 ? css("--t-none") : css(`--t${bucket}`));

const teamLayer = L.markerClusterGroup({
  chunkedLoading: true,
  showCoverageOnHover: false,
  spiderfyOnMaxZoom: true,
  maxClusterRadius: (z) => (z < 4 ? 50 : z < 8 ? 40 : 25),
  disableClusteringAtZoom: 11,
  iconCreateFunction(cluster) {
    const kids = cluster.getAllChildMarkers();
    const buckets = kids.map((m) => m.options.bucket).filter((b) => b >= 0);
    const avg = buckets.length ? Math.round(buckets.reduce((a, b) => a + b, 0) / buckets.length) : -1;
    const n = cluster.getChildCount();
    const size = n < 10 ? 28 : n < 100 ? 34 : n < 1000 ? 42 : 50;
    return L.divIcon({
      html: `<div class="team-cluster" style="width:${size}px;height:${size}px;background:${colorFor(avg)}">${n}</div>`,
      className: "",
      iconSize: [size, size],
    });
  },
});
const eventLayer = L.markerClusterGroup({
  showCoverageOnHover: false,
  maxClusterRadius: 30,
  disableClusteringAtZoom: 8,
  iconCreateFunction(cluster) {
    const n = cluster.getChildCount();
    const kids = cluster.getAllChildMarkers().map((m) => m.options.status);
    const status = kids.includes("ongoing") ? "ongoing" : kids.includes("upcoming") ? "upcoming" : "completed";
    return L.divIcon({
      html: `<div class="event-cluster"><div class="event-marker ${status}"></div><b>${n}</b></div>`,
      className: "",
      iconSize: [26, 26],
    });
  },
});
const linkLayer = L.layerGroup();
map.addLayer(teamLayer);
map.addLayer(eventLayer);
map.addLayer(linkLayer);

// ---------------------------------------------------------------------------
// Data loading

async function loadSeasons() {
  const res = await fetch("data/seasons.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("No data has been built yet. Run `npm run build-data`.");
  return res.json();
}

async function loadSeason(season) {
  $("loading").hidden = false;
  $("loading").textContent = `Loading ${seasonLabel(season)} season…`;
  const res = await fetch(`data/${season}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not load data for ${season}.`);
  const data = await res.json();
  state.season = season;
  state.data = data;
  state.teamsByNumber = new Map(data.teams.map((t) => [t.number, t]));
  state.eventsByCode = new Map(data.events.map((e) => [e.code, e]));
  state.ctx = { ranked: data.teams.filter((t) => t.stats?.tot?.r).length, season };
  populateLocations();
  buildMarkers();
  renderAll();
  const when = new Date(data.generatedAt).toLocaleString();
  const sources = [data.sources?.ftcscout && "FTCScout", data.sources?.ftcEvents && "FTC Events"].filter(Boolean);
  $("generated").textContent = ` Updated ${when} from ${sources.join(" + ") || "cached data"}.`;
  $("loading").hidden = true;
}

// ---------------------------------------------------------------------------
// Markers

function buildMarkers() {
  state.markers.teams.clear();
  state.markers.events.clear();
  for (const team of state.data.teams) {
    if (!team.loc) continue;
    const m = L.circleMarker(team.loc, { renderer, radius: 7, weight: 2, color: "#fff", fillOpacity: 1 });
    m.bindTooltip(() => teamTooltip(team), { direction: "top", offset: [0, -4] });
    m.on("click", () => select("team", team.number));
    state.markers.teams.set(team.number, m);
  }
  for (const ev of state.data.events) {
    if (!ev.loc) continue;
    const m = L.marker(ev.loc, { status: ev.status, keyboard: true, title: ev.name });
    m.bindTooltip(() => eventTooltip(ev), { direction: "top", offset: [0, -8] });
    m.on("click", () => select("event", ev.code));
    state.markers.events.set(ev.code, m);
  }
}

function teamTooltip(t) {
  const opr = t.stats?.tot ? ` · OPR ${fmt(t.stats.tot.v)} (#${t.stats.tot.r})` : "";
  return `<strong>${t.number}</strong> ${esc(t.name ?? "")}<br><span style="opacity:.75">${esc(place(t))}${opr}</span>`;
}
function eventTooltip(e) {
  return `<strong>${esc(e.name)}</strong><br><span style="opacity:.75">${esc(e.category)} · ${esc(dateRange(e))}</span>`;
}

const matchesPlace = (o, f) => (!f.country || o.country === f.country) && (!f.state || o.state === f.state);

function teamVisible(t, f = state.filters) {
  return f.showTeams && t.loc && matchesPlace(t, f) && (!f.onlyStats || (t.stats?.count ?? 0) > 0);
}
function eventVisible(e, f = state.filters) {
  return (
    f.showEvents && e.loc && matchesPlace(e, f) && f.statuses.has(e.status) && f.categories.has(e.category)
  );
}

function renderAll() {
  if (!state.data) return;
  const mode = COLOR_MODES[state.filters.colorBy];
  const selectedTeam = state.selected?.kind === "team" ? state.selected.id : null;

  const teamMarkers = [];
  for (const team of state.data.teams) {
    const m = state.markers.teams.get(team.number);
    if (!m || !teamVisible(team)) continue;
    const bucket = mode.bucket(team, state.ctx);
    m.options.bucket = bucket;
    const isSel = team.number === selectedTeam;
    m.setStyle({
      fillColor: colorFor(bucket),
      color: isSel ? css("--accent") : "#fff",
      weight: isSel ? 4 : 2,
    });
    m.setRadius(isSel ? 11 : 7);
    teamMarkers.push(m);
  }
  teamLayer.clearLayers();
  teamLayer.addLayers(teamMarkers);

  const selectedEvent = state.selected?.kind === "event" ? state.selected.id : null;
  const eventMarkers = [];
  for (const ev of state.data.events) {
    const m = state.markers.events.get(ev.code);
    if (!m || !eventVisible(ev)) continue;
    const sel = ev.code === selectedEvent ? " selected" : "";
    m.setIcon(L.divIcon({ className: "", html: `<div class="event-marker ${ev.status}${sel}"></div>`, iconSize: [16, 16] }));
    m.setZIndexOffset(sel ? 1000 : 0);
    eventMarkers.push(m);
  }
  eventLayer.clearLayers();
  eventLayer.addLayers(eventMarkers);

  renderLegend(mode);
  renderSummary(teamMarkers.length, eventMarkers.length);
  renderLinks();
}

function renderLegend(mode) {
  const f = state.filters;
  const el = $("legend");
  if (!f.showTeams && !f.showEvents) {
    el.hidden = true;
    return;
  }
  const buckets = mode.buckets.map((label, i) => ({ label, i })).filter((b) => b.label);
  const cols = `grid-template-columns:repeat(${buckets.length},minmax(0,1fr))`;
  const teams = f.showTeams
    ? `<div class="bar" style="${cols}">${buckets.map((b) => `<span style="background:${colorFor(b.i)}"></span>`).join("")}</div>
       <div class="labels" style="${cols}">${buckets.map((b) => `<span>${esc(b.label)}</span>`).join("")}</div>`
    : "";
  const keys = [
    f.showTeams && mode.none ? `<span><i class="dot" style="background:${colorFor(-1)}"></i>${esc(mode.none)}</span>` : "",
    ...(f.showEvents ? STATUSES.map(([s, label]) => `<span><i class="diamond ${s}"></i>${label}</span>`) : []),
  ].join("");
  const title = f.showTeams ? mode.title : "Events";
  const hint = f.showTeams && state.filters.colorBy !== "none" ? `<span class="hint">Clusters show their average</span>` : "";
  const open = el.querySelector("details")?.open ?? !matchMedia("(max-width: 720px)").matches;
  el.innerHTML = `<details ${open ? "open" : ""}><summary>${esc(title)}${hint}</summary>${teams}${
    keys ? `<div class="keys"${f.showTeams ? "" : ' style="border:0;padding:0"'}>${keys}</div>` : ""
  }</details>`;
  el.hidden = false;
}

function renderSummary(teamCount, eventCount) {
  const f = state.filters;
  const where = f.state ? `${f.state}, ${f.country}` : f.country || "Worldwide";
  $("stats-pill").innerHTML = `
    <span><strong>${teamCount.toLocaleString()}</strong> teams</span><span class="sep"></span>
    <span><strong>${eventCount.toLocaleString()}</strong> events</span><span class="sep"></span>
    <span class="where">${esc(where)} · ${seasonLabel(state.season)}</span>`;

  const top = state.data.teams
    .filter((t) => teamVisible(t) && t.stats?.tot)
    .sort((a, b) => a.stats.tot.r - b.stats.tot.r)
    .slice(0, 5);
  $("summary").innerHTML = top.length
    ? `<h3>Top teams ${f.country ? "here" : "worldwide"} by OPR</h3>
       <ul class="list">${top
         .map(
           (t) =>
             `<li data-team="${t.number}"><span class="main"><span>${esc(t.name ?? `Team ${t.number}`)}</span><span class="meta">${t.number} · ${esc(place(t))}</span></span><span class="num">${fmt(t.stats.tot.v)}</span></li>`,
         )
         .join("")}</ul>`
    : "";
}

// Lines from the selected team to its events, or from an event to its teams.
function renderLinks() {
  linkLayer.clearLayers();
  const sel = state.selected;
  if (!sel) return;
  const color = css("--accent");
  if (sel.kind === "team") {
    const team = state.teamsByNumber.get(sel.id);
    if (!team?.loc) return;
    for (const code of team.events ?? []) {
      const ev = state.eventsByCode.get(code);
      if (ev?.loc) L.polyline([team.loc, ev.loc], { color, weight: 2, opacity: 0.8, dashArray: "4 6", interactive: false }).addTo(linkLayer);
    }
  } else {
    const ev = state.eventsByCode.get(sel.id);
    if (!ev?.loc) return;
    for (const n of ev.teams ?? []) {
      const t = state.teamsByNumber.get(n);
      if (t?.loc) L.polyline([ev.loc, t.loc], { color, weight: 1.5, opacity: 0.6, dashArray: "3 6", interactive: false }).addTo(linkLayer);
    }
  }
}

// ---------------------------------------------------------------------------
// Selection + details panel

function select(kind, id, { fly = false } = {}) {
  state.selected = kind ? { kind, id } : null;
  writeHash();
  renderAll();
  renderDetails();
  if (!fly || !kind) return;
  const item = kind === "team" ? state.teamsByNumber.get(id) : state.eventsByCode.get(id);
  if (!item?.loc) return;
  // Keep the target in the part of the map the details card doesn't cover.
  const [padTL, padBR] = detailsPadding();
  const pts = [item.loc];
  // Frame an event together with the teams attending it.
  if (kind === "event") pts.push(...(item.teams ?? []).map((n) => state.teamsByNumber.get(n)?.loc).filter(Boolean));
  const maxZoom = Math.max(map.getZoom(), 11);
  map.flyToBounds(L.latLngBounds(pts), {
    paddingTopLeft: padTL,
    paddingBottomRight: padBR,
    maxZoom: pts.length > 1 ? 11 : maxZoom,
  });
}

// The details card covers the map's right side (desktop) or bottom (phones).
function detailsPadding() {
  const card = $("details");
  const mapBox = $("map").getBoundingClientRect();
  if (card.hidden) return [L.point(40, 40), L.point(40, 40)];
  const box = card.getBoundingClientRect();
  if (matchMedia("(max-width: 720px)").matches) {
    return [L.point(24, 130), L.point(24, Math.max(40, mapBox.bottom - box.top + 24))];
  }
  return [L.point(40, 90), L.point(Math.max(40, mapBox.right - box.left + 24), 40)];
}

function renderDetails() {
  const el = $("details");
  const sel = state.selected;
  if (!sel) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = sel.kind === "team" ? teamDetails(state.teamsByNumber.get(sel.id)) : eventDetails(state.eventsByCode.get(sel.id));
  el.querySelector(".close")?.addEventListener("click", () => select(null));
  el.scrollTop = 0;
  if (matchMedia("(max-width: 720px)").matches) setSidebarOpen(false);
}

const CLOSE_BTN = `<button type="button" class="icon-btn close" aria-label="Close"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;

function notFound(what) {
  return `<div class="head"><div><h2>${what} not found</h2><span class="sub">It isn't in the ${seasonLabel(state.season)} data.</span></div>${CLOSE_BTN}</div>`;
}

function eventRow(e) {
  const meta = `${esc(e.start ? dateRange(e) : "Date TBA")} · ${esc(statusLabel(e.status))}`;
  return `<li data-event="${esc(e.code)}"><i class="diamond ${e.status}"></i><span class="main"><span>${esc(e.name)}</span><span class="meta ${e.status}">${meta}</span></span></li>`;
}

function rankBadge(t) {
  const r = t.stats?.tot?.r;
  if (!r) return `<div class="rank-badge none"><i class="dot" style="background:${colorFor(-1)}"></i>No matches played yet this season</div>`;
  const bucket = COLOR_MODES.opr.bucket(t, state.ctx);
  const label = bucket >= 1 ? `<strong>${esc(COLOR_MODES.opr.buckets[bucket])} worldwide</strong> · ` : "";
  return `<div class="rank-badge"><i class="dot" style="background:${colorFor(bucket)}"></i><span>${label}rank #${r.toLocaleString()} of ${state.ctx.ranked.toLocaleString()} by OPR</span></div>`;
}

function teamDetails(t) {
  if (!t) return notFound("Team");
  const s = t.stats;
  const statBox = (label, st) =>
    `<div class="stat"><span class="l">${label}</span><span class="v">${fmt(st?.v)}</span><span class="r">${st?.r ? `#${st.r.toLocaleString()}` : "–"}</span></div>`;
  const events = (t.events ?? [])
    .map((c) => state.eventsByCode.get(c))
    .filter(Boolean)
    .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  const season = state.season;
  const sub = [place(t) || "Location unknown", t.rookieYear && `Rookie year ${t.rookieYear}`].filter(Boolean).join(" · ");
  const extra = [
    t.school && `<dt>Organization</dt><dd>${esc(t.school)}</dd>`,
    t.robotName && `<dt>Robot</dt><dd>${esc(t.robotName)}</dd>`,
  ].filter(Boolean);
  return `
    <div class="head">
      <div>
        <span class="eyebrow">Team ${t.number}</span>
        <h2>${esc(t.name ?? `Team ${t.number}`)}</h2>
        <span class="sub">${esc(sub)}</span>
      </div>
      ${CLOSE_BTN}
    </div>
    ${rankBadge(t)}
    ${s?.tot ? `<div class="stat-grid">${statBox("Total OPR", s.tot)}${statBox("Auto", s.auto)}${statBox("Teleop", s.dc)}${statBox("Endgame", s.eg)}</div>` : ""}
    ${extra.length ? `<dl class="kv">${extra.join("")}</dl>` : ""}
    <h3>This season's events</h3>
    ${events.length ? `<ul class="list">${events.map(eventRow).join("")}</ul>` : `<p class="sub" style="margin:0">No events found yet.</p>`}
    <div class="actions">
      <a class="btn primary" href="https://ftcscout.org/teams/${t.number}?season=${season}" target="_blank" rel="noopener">Open in FTCScout ↗</a>
      <a class="btn outline" href="https://ftc-events.firstinspires.org/${season}/team/${t.number}" target="_blank" rel="noopener">FTC Events ↗</a>
      ${safeUrl(t.website) ? `<a class="btn link" href="${esc(safeUrl(t.website))}" target="_blank" rel="noopener">Team website ↗</a>` : ""}
    </div>`;
}

function eventDetails(e) {
  if (!e) return notFound("Event");
  const teams = (e.teams ?? [])
    .map((n) => state.teamsByNumber.get(n) ?? { number: n })
    .sort((a, b) => (a.stats?.tot?.r ?? Infinity) - (b.stats?.tot?.r ?? Infinity) || a.number - b.number);
  const oprs = teams.map((t) => t.stats?.tot?.v).filter((v) => typeof v === "number");
  const avg = oprs.length ? oprs.reduce((a, b) => a + b, 0) / oprs.length : null;
  const season = state.season;
  const location = [e.address, place(e)].filter(Boolean).join(", ") || (e.remote ? "Remote" : "TBA");
  return `
    <div class="head">
      <div>
        <span class="eyebrow">${esc(e.category)} · ${esc(e.code)}</span>
        <h2>${esc(e.name)}</h2>
        <span class="sub">${esc(dateRange(e))}</span>
      </div>
      ${CLOSE_BTN}
    </div>
    <div class="rank-badge none"><i class="diamond ${e.status}"></i><span><strong>${esc(statusLabel(e.status))}</strong>${
      avg !== null ? ` · field average OPR ${fmt(avg)} (${oprs.length} teams with stats)` : ""
    }</span></div>
    <dl class="kv">
      ${e.venue ? `<dt>Venue</dt><dd>${esc(e.venue)}</dd>` : ""}
      <dt>Location</dt><dd>${esc(location)}</dd>
      ${e.type && e.type !== e.category ? `<dt>Type</dt><dd>${esc(e.type)}</dd>` : ""}
      ${e.league ? `<dt>League</dt><dd>${esc(e.league)}</dd>` : ""}
    </dl>
    <h3>Teams (${teams.length})</h3>
    ${
      teams.length
        ? `<ul class="list scroll">${teams
            .map(
              (t) =>
                `<li data-team="${t.number}"><i class="dot" style="background:${colorFor(COLOR_MODES.opr.bucket(t, state.ctx))}"></i><span class="main"><span>${esc(t.name ?? `Team ${t.number}`)}</span><span class="meta">${t.number}${t.stats?.tot ? ` · rank #${t.stats.tot.r.toLocaleString()}` : ""}</span></span><span class="num">${t.stats?.tot ? fmt(t.stats.tot.v) : ""}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="sub" style="margin:0">Team list not published yet.</p>`
    }
    <div class="actions">
      <a class="btn primary" href="https://ftcscout.org/events/${season}/${encodeURIComponent(e.code)}" target="_blank" rel="noopener">Open in FTCScout ↗</a>
      <a class="btn outline" href="https://ftc-events.firstinspires.org/${season}/${encodeURIComponent(e.code)}" target="_blank" rel="noopener">FTC Events ↗</a>
      ${safeUrl(e.liveStream) ? `<a class="btn link" href="${esc(safeUrl(e.liveStream))}" target="_blank" rel="noopener">Watch the livestream ↗</a>` : ""}
      ${safeUrl(e.website) ? `<a class="btn link" href="${esc(safeUrl(e.website))}" target="_blank" rel="noopener">Event website ↗</a>` : ""}
    </div>`;
}

const statusLabel = (s) => Object.fromEntries(STATUSES)[s] ?? s;

function safeUrl(url) {
  if (!url) return null;
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// Clicking team/event rows in the sidebar or the details card selects them.
for (const id of ["sidebar", "details"]) {
  $(id).addEventListener("click", (ev) => {
    const row = ev.target.closest("[data-team], [data-event]");
    if (!row) return;
    if (row.dataset.team) select("team", Number(row.dataset.team), { fly: true });
    else select("event", row.dataset.event, { fly: true });
  });
}

// ---------------------------------------------------------------------------
// Filters

function populateLocations() {
  const counts = new Map();
  for (const item of [...state.data.teams, ...state.data.events]) {
    if (item.country) counts.set(item.country, (counts.get(item.country) ?? 0) + 1);
  }
  const countries = [...counts.keys()].sort((a, b) => a.localeCompare(b));
  const sel = $("country");
  sel.innerHTML =
    `<option value="">All countries</option>` +
    countries.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  if (!counts.has(state.filters.country)) state.filters.country = "";
  sel.value = state.filters.country;
  populateStates();
}

function populateStates() {
  const f = state.filters;
  const sel = $("state");
  const states = new Set();
  if (f.country) {
    for (const item of [...state.data.teams, ...state.data.events]) {
      if (item.country === f.country && item.state) states.add(item.state);
    }
  }
  sel.innerHTML =
    `<option value="">All</option>` +
    [...states].sort().map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sel.disabled = states.size === 0;
  if (!states.has(f.state)) f.state = "";
  sel.value = f.state;
}

function fitToFilter() {
  const f = state.filters;
  if (!f.country) return;
  const pts = [
    ...state.data.teams.filter((t) => teamVisible(t)).map((t) => t.loc),
    ...state.data.events.filter((e) => eventVisible(e)).map((e) => e.loc),
  ];
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 9 });
}

function setupFilters() {
  const f = state.filters;
  $("country").addEventListener("change", (e) => {
    f.country = e.target.value;
    f.state = "";
    populateStates();
    renderAll();
    fitToFilter();
    writeHash();
  });
  $("state").addEventListener("change", (e) => {
    f.state = e.target.value;
    renderAll();
    fitToFilter();
    writeHash();
  });
  $("show-teams").addEventListener("change", (e) => {
    f.showTeams = e.target.checked;
    renderAll();
  });
  $("show-events").addEventListener("change", (e) => {
    f.showEvents = e.target.checked;
    renderAll();
  });
  $("only-stats").addEventListener("change", (e) => {
    f.onlyStats = e.target.checked;
    renderAll();
  });
  $("color-by").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-color]");
    if (!btn) return;
    f.colorBy = btn.dataset.color;
    for (const b of $("color-by").querySelectorAll("[data-color]")) b.setAttribute("aria-pressed", String(b === btn));
    renderAll();
  });

  $("status-filters").innerHTML = STATUSES.map(
    ([s, label]) =>
      `<button type="button" class="chip" data-status="${s}" aria-pressed="true"><i class="diamond ${s}"></i>${label}</button>`,
  ).join("");
  $("status-filters").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-status]");
    if (!chip) return;
    const s = chip.dataset.status;
    if (f.statuses.has(s)) f.statuses.delete(s);
    else f.statuses.add(s);
    chip.setAttribute("aria-pressed", String(f.statuses.has(s)));
    renderAll();
  });

  $("category-filters").innerHTML = CATEGORIES.map(
    (c) => `<button type="button" class="tag" data-category="${esc(c)}" aria-pressed="${f.categories.has(c)}">${esc(c)}</button>`,
  ).join("");
  $("category-filters").addEventListener("click", (e) => {
    const tag = e.target.closest("[data-category]");
    if (!tag) return;
    const c = tag.dataset.category;
    if (f.categories.has(c)) f.categories.delete(c);
    else f.categories.add(c);
    tag.setAttribute("aria-pressed", String(f.categories.has(c)));
    renderAll();
  });

  $("season").addEventListener("change", async (e) => {
    state.selected = null;
    renderDetails();
    await loadSeason(Number(e.target.value)).catch(showError);
    writeHash();
  });

  // On phones the controls live in a sheet opened from the filter button.
  $("sidebar-open").addEventListener("click", () => setSidebarOpen(true));
  $("sidebar-close").addEventListener("click", () => setSidebarOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("sidebar").classList.contains("open")) setSidebarOpen(false);
    // "/" jumps to search, as the hint in the search box says.
    if (e.key === "/" && !e.target.closest("input, select, textarea")) {
      const input = matchMedia("(max-width: 720px)").matches ? $("search-m") : $("search");
      e.preventDefault();
      input.focus();
    }
  });
}

function setSidebarOpen(open) {
  $("sidebar").classList.toggle("open", open);
  $("sidebar-open").setAttribute("aria-expanded", String(open));
  if (open) $("sidebar-close").focus();
}

// ---------------------------------------------------------------------------
// Search

function setupSearch(input, list) {
  let results = [];
  let active = -1;

  const run = () => {
    const q = input.value.trim().toLowerCase();
    results = q ? search(q) : [];
    active = results.length ? 0 : -1;
    draw();
  };
  const draw = () => {
    list.hidden = results.length === 0;
    list.innerHTML = results
      .map(
        (r, i) =>
          `<li role="option" aria-selected="${i === active}" data-i="${i}"><span>${esc(r.label)}</span><span class="kind">${esc(r.kind)}</span></li>`,
      )
      .join("");
  };
  const choose = (r) => {
    if (!r) return;
    input.value = "";
    results = [];
    draw();
    select(r.type, r.id, { fly: true });
  };

  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!results.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      draw();
    } else if (e.key === "Enter") {
      choose(results[active]);
    } else if (e.key === "Escape") {
      results = [];
      draw();
    }
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (li) {
      e.preventDefault();
      choose(results[Number(li.dataset.i)]);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 100));
}

function search(q) {
  const out = [];
  const isNum = /^\d+$/.test(q);
  for (const t of state.data.teams) {
    const num = String(t.number);
    const score = num === q ? 0 : isNum && num.startsWith(q) ? 1 : t.name?.toLowerCase().includes(q) ? 2 : -1;
    if (score >= 0) out.push({ score, type: "team", id: t.number, label: `${t.number} ${t.name ?? ""}`, kind: place(t) || "Team" });
  }
  for (const e of state.data.events) {
    const hit = e.name?.toLowerCase().includes(q) || e.code.toLowerCase() === q;
    if (hit) out.push({ score: 3, type: "event", id: e.code, label: e.name, kind: `Event · ${e.start ?? "TBA"}` });
  }
  return out.sort((a, b) => a.score - b.score || String(a.label).localeCompare(String(b.label))).slice(0, 10);
}

// ---------------------------------------------------------------------------
// URL state: #season=2025&team=1234 / &event=USCAFFS / &country=USA

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return {
    season: p.get("season") ? Number(p.get("season")) : null,
    team: p.get("team") ? Number(p.get("team")) : null,
    event: p.get("event"),
    country: p.get("country") ?? "",
    state: p.get("state") ?? "",
  };
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.season) p.set("season", state.season);
  if (state.filters.country) p.set("country", state.filters.country);
  if (state.filters.state) p.set("state", state.filters.state);
  if (state.selected) p.set(state.selected.kind, state.selected.id);
  history.replaceState(null, "", `#${p}`);
}

function showError(err) {
  console.error(err);
  $("loading").hidden = false;
  $("loading").textContent = err.message;
}

// ---------------------------------------------------------------------------

async function main() {
  setupFilters();
  setupSearch($("search"), $("search-results"));
  setupSearch($("search-m"), $("search-results-m"));
  const initial = readHash();
  const manifest = await loadSeasons();
  const seasons = manifest.seasons ?? [];
  if (!seasons.length) throw new Error("No seasons available. Run `npm run build-data`.");
  $("season").innerHTML = seasons.map((s) => `<option value="${s}">${seasonLabel(s)}</option>`).join("");
  // Default to the newest season that has match stats, so a season that has
  // only just kicked off doesn't open as a map of empty markers.
  const withStats = seasons.find((s) => manifest.withStats?.[s] > 0);
  const season = seasons.includes(initial.season) ? initial.season : (withStats ?? seasons[0]);
  $("season").value = season;
  state.filters.country = initial.country;
  state.filters.state = initial.state;
  await loadSeason(season);
  $("state").value = state.filters.state;
  fitToFilter();
  if (initial.team) select("team", initial.team, { fly: true });
  else if (initial.event) select("event", initial.event, { fly: true });
  else writeHash();
}

main().catch(showError);
