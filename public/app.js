/* global L */
// PulsePoint: interactive map of FTC teams and events.
// Data is prebuilt by scripts/build-data.js from FTCScout + the FTC Events API.

const STATUSES = [
  ["upcoming", "Upcoming"],
  ["ongoing", "Live"],
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
    title: "Season OPR (world rank)",
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
let tiles;
function setTiles() {
  tiles?.remove();
  const style = dark.matches ? "dark_all" : "light_all";
  tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 18,
    subdomains: "abcd",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
}
setTiles();
dark.addEventListener?.("change", () => {
  setTiles();
  renderAll();
});

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
      html: `<div class="event-marker ${status}" style="width:22px;height:22px"></div><span style="position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-weight:700;font-size:11px">${n}</span>`,
      className: "",
      iconSize: [22, 22],
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
  return (await res.json()).seasons ?? [];
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
    const m = L.circleMarker(team.loc, { renderer, radius: 6, weight: 1.5, color: "#fff", fillOpacity: 0.95 });
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
      color: isSel ? css("--warn") : dark.matches ? "#0f141b" : "#fff",
      weight: isSel ? 3 : 1.5,
    });
    m.setRadius(isSel ? 9 : 6);
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
    m.setIcon(L.divIcon({ className: "", html: `<div class="event-marker ${ev.status}${sel}"></div>`, iconSize: [14, 14] }));
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
  const rows = [];
  if (state.filters.showTeams) {
    rows.push(`<h4>${esc(mode.title)}</h4>`);
    for (let i = mode.buckets.length - 1; i >= 0; i--) {
      if (!mode.buckets[i]) continue;
      rows.push(`<div class="item"><span class="dot" style="background:${colorFor(i)}"></span>${esc(mode.buckets[i])}</div>`);
    }
    if (mode.none) rows.push(`<div class="item"><span class="dot" style="background:${colorFor(-1)}"></span>${esc(mode.none)}</div>`);
  }
  if (state.filters.showEvents) {
    rows.push("<h4>Events</h4>");
    for (const [s, label] of STATUSES) {
      rows.push(`<div class="item"><span class="event-marker ${s}" style="width:10px;height:10px;animation:none"></span>${label}</div>`);
    }
  }
  const open = $("legend").querySelector("details")?.open ?? !matchMedia("(max-width: 720px)").matches;
  $("legend").innerHTML = `<details ${open ? "open" : ""}><summary>Legend</summary>${rows.join("")}</details>`;
  $("legend").hidden = rows.length === 0;
}

function renderSummary(teamCount, eventCount) {
  const f = state.filters;
  const where = f.state ? `${f.state}, ${f.country}` : f.country || "worldwide";
  const top = state.data.teams
    .filter((t) => teamVisible(t) && t.stats?.tot)
    .sort((a, b) => a.stats.tot.r - b.stats.tot.r)
    .slice(0, 5);
  const unmapped = state.data.teams.filter((t) => !t.loc).length;
  $("summary").innerHTML = `
    <p><strong>${teamCount.toLocaleString()}</strong> teams and <strong>${eventCount.toLocaleString()}</strong> events shown ${esc(where)} for ${seasonLabel(state.season)}.${
      unmapped ? ` <span title="Location could not be geocoded yet">${unmapped} teams unmapped.</span>` : ""
    }</p>
    ${
      top.length
        ? `<h3 style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin:10px 0 4px">Top teams by OPR</h3>
           <ul class="list">${top
             .map(
               (t) =>
                 `<li data-team="${t.number}"><span><strong>${t.number}</strong> ${esc(t.name ?? "")}</span><span class="meta">${fmt(t.stats.tot.v)} · #${t.stats.tot.r}</span></li>`,
             )
             .join("")}</ul>`
        : ""
    }`;
}

// Lines from the selected team to its events, or from an event to its teams.
function renderLinks() {
  linkLayer.clearLayers();
  const sel = state.selected;
  if (!sel) return;
  const color = css("--warn");
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
  if (kind === "team") {
    map.flyTo(item.loc, Math.max(map.getZoom(), 11));
    return;
  }
  // Frame the event together with the teams attending it.
  const pts = [item.loc, ...(item.teams ?? []).map((n) => state.teamsByNumber.get(n)?.loc).filter(Boolean)];
  if (pts.length > 1) map.flyToBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 11 });
  else map.flyTo(item.loc, Math.max(map.getZoom(), 11));
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
  if (matchMedia("(max-width: 720px)").matches) setSidebarOpen(true);
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function teamDetails(t) {
  if (!t) return `<p>Team not found in this season.</p><button class="icon-btn close" title="Close">✕</button>`;
  const s = t.stats;
  const statBox = (label, st) =>
    `<div class="stat"><div class="v">${fmt(st?.v)}</div><div class="l">${label}</div><div class="r">${st?.r ? `#${st.r}` : "–"}</div></div>`;
  const events = (t.events ?? [])
    .map((c) => state.eventsByCode.get(c))
    .filter(Boolean)
    .sort((a, b) => (a.start ?? "").localeCompare(b.start ?? ""));
  const season = state.season;
  return `
    <button class="icon-btn close" title="Close">✕</button>
    <h2>${t.number} · ${esc(t.name ?? "Unknown team")}</h2>
    <p class="sub">${esc(place(t) || "Location unknown")}</p>
    <dl class="kv">
      ${t.school ? `<dt>Organization</dt><dd>${esc(t.school)}</dd>` : ""}
      ${t.rookieYear ? `<dt>Rookie year</dt><dd>${t.rookieYear}</dd>` : ""}
      ${t.robotName ? `<dt>Robot</dt><dd>${esc(t.robotName)}</dd>` : ""}
      ${t.region ? `<dt>Home region</dt><dd>${esc(t.region)}</dd>` : ""}
    </dl>
    <h3>${seasonLabel(season)} performance ${s?.count ? `· ${s.count} event${s.count === 1 ? "" : "s"}` : ""}</h3>
    ${
      s?.tot
        ? `<div class="stat-grid">${statBox("Total OPR", s.tot)}${statBox("Auto", s.auto)}${statBox("Teleop", s.dc)}${statBox("Endgame", s.eg)}</div>`
        : `<p class="sub">No matches played yet this season.</p>`
    }
    <h3>Events (${events.length})</h3>
    ${
      events.length
        ? `<ul class="list">${events
            .map(
              (e) =>
                `<li data-event="${esc(e.code)}"><span>${esc(e.name)}</span><span class="meta"><span class="badge ${e.status}">${esc(statusLabel(e.status))}</span> ${esc(e.start?.slice(5) ?? "")}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="sub">No events found yet.</p>`
    }
    <div class="links">
      <a href="https://ftcscout.org/teams/${t.number}?season=${season}" target="_blank" rel="noopener">FTCScout ↗</a>
      <a href="https://ftc-events.firstinspires.org/${season}/team/${t.number}" target="_blank" rel="noopener">FTC Events ↗</a>
      ${safeUrl(t.website) ? `<a href="${esc(safeUrl(t.website))}" target="_blank" rel="noopener">Website ↗</a>` : ""}
    </div>`;
}

function eventDetails(e) {
  if (!e) return `<p>Event not found in this season.</p><button class="icon-btn close" title="Close">✕</button>`;
  const teams = (e.teams ?? [])
    .map((n) => state.teamsByNumber.get(n) ?? { number: n })
    .sort((a, b) => (a.stats?.tot?.r ?? Infinity) - (b.stats?.tot?.r ?? Infinity) || a.number - b.number);
  const oprs = teams.map((t) => t.stats?.tot?.v).filter((v) => typeof v === "number");
  const avg = oprs.length ? oprs.reduce((a, b) => a + b, 0) / oprs.length : null;
  const season = state.season;
  return `
    <button class="icon-btn close" title="Close">✕</button>
    <h2>${esc(e.name)}</h2>
    <p class="sub"><span class="badge ${e.status}">${esc(statusLabel(e.status))}</span> ${esc(e.category)} · ${esc(dateRange(e))}</p>
    <dl class="kv">
      <dt>Code</dt><dd>${esc(e.code)}</dd>
      ${e.venue ? `<dt>Venue</dt><dd>${esc(e.venue)}</dd>` : ""}
      <dt>Location</dt><dd>${esc([e.address, place(e)].filter(Boolean).join(", ") || (e.remote ? "Remote" : "TBA"))}</dd>
      ${e.type && e.type !== e.category ? `<dt>Type</dt><dd>${esc(e.type)}</dd>` : ""}
      ${e.league ? `<dt>League</dt><dd>${esc(e.league)}</dd>` : ""}
      ${e.region ? `<dt>Region</dt><dd>${esc(e.region)}</dd>` : ""}
      ${avg !== null ? `<dt>Avg team OPR</dt><dd>${fmt(avg)} <span class="sub">(${oprs.length} teams with stats)</span></dd>` : ""}
    </dl>
    <h3>Teams (${teams.length})</h3>
    ${
      teams.length
        ? `<ul class="list">${teams
            .map(
              (t) =>
                `<li data-team="${t.number}"><span><strong>${t.number}</strong> ${esc(t.name ?? "")}</span><span class="meta">${t.stats?.tot ? `${fmt(t.stats.tot.v)} · #${t.stats.tot.r}` : ""}</span></li>`,
            )
            .join("")}</ul>`
        : `<p class="sub">Team list not published yet.</p>`
    }
    <div class="links">
      <a href="https://ftcscout.org/events/${season}/${encodeURIComponent(e.code)}" target="_blank" rel="noopener">FTCScout ↗</a>
      <a href="https://ftc-events.firstinspires.org/${season}/${encodeURIComponent(e.code)}" target="_blank" rel="noopener">FTC Events ↗</a>
      ${safeUrl(e.liveStream) ? `<a href="${esc(safeUrl(e.liveStream))}" target="_blank" rel="noopener">Livestream ↗</a>` : ""}
      ${safeUrl(e.website) ? `<a href="${esc(safeUrl(e.website))}" target="_blank" rel="noopener">Website ↗</a>` : ""}
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

// Clicking team/event rows anywhere in the sidebar selects them.
$("sidebar").addEventListener("click", (ev) => {
  const row = ev.target.closest("[data-team], [data-event]");
  if (!row) return;
  if (row.dataset.team) select("team", Number(row.dataset.team), { fly: true });
  else select("event", row.dataset.event, { fly: true });
});

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
  $("color-by").addEventListener("change", (e) => {
    f.colorBy = e.target.value;
    renderAll();
  });

  $("status-filters").innerHTML = STATUSES.map(
    ([s, label]) =>
      `<button type="button" class="chip" data-status="${s}" aria-pressed="true"><span class="event-marker ${s}" style="width:9px;height:9px;animation:none"></span>${label}</button>`,
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
    (c) =>
      `<label class="check"><input type="checkbox" data-category="${esc(c)}" ${f.categories.has(c) ? "checked" : ""}> ${esc(c)}</label>`,
  ).join("");
  $("category-filters").addEventListener("change", (e) => {
    const c = e.target.dataset.category;
    if (e.target.checked) f.categories.add(c);
    else f.categories.delete(c);
    renderAll();
  });

  $("season").addEventListener("change", async (e) => {
    state.selected = null;
    renderDetails();
    await loadSeason(Number(e.target.value)).catch(showError);
    writeHash();
  });

  $("sidebar-toggle").addEventListener("click", () => setSidebarOpen($("sidebar").classList.contains("collapsed")));
}

function setSidebarOpen(open) {
  $("sidebar").classList.toggle("collapsed", !open);
  $("sidebar-toggle").setAttribute("aria-expanded", String(open));
  setTimeout(() => map.invalidateSize(), 50);
}

// ---------------------------------------------------------------------------
// Search

function setupSearch() {
  const input = $("search");
  const list = $("search-results");
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
  setupSearch();
  const initial = readHash();
  const seasons = await loadSeasons();
  if (!seasons.length) throw new Error("No seasons available. Run `npm run build-data`.");
  $("season").innerHTML = seasons.map((s) => `<option value="${s}">${seasonLabel(s)}</option>`).join("");
  const season = seasons.includes(initial.season) ? initial.season : seasons[0];
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
