// Geocodes team/event locations with OpenStreetMap Nominatim. Neither
// FTCScout nor the FTC Events API publish coordinates, so we derive them from
// city/state/country (teams) or the venue address (events).
//
// Results are cached on disk (data/geocache.json) so each place is looked up
// only once, and requests are spaced out to respect Nominatim's usage policy
// (max 1 request/second, identifying User-Agent).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fetchJson, sleep } from "./http.js";

const NOMINATIM_URL = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org/search";
const USER_AGENT = process.env.GEOCODER_USER_AGENT || "pulsepoint-ftc-map (https://github.com/bigbossg13/pulsepoint)";
const MIN_INTERVAL_MS = Number(process.env.GEOCODE_INTERVAL_MS ?? 1100);

export const normalize = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export function placeKey({ city, state, country }) {
  return ["place", city, state, country].map(normalize).join("|");
}

export function addressKey(address) {
  return `addr|${normalize(address)}`;
}

export class Geocoder {
  constructor({ cachePath, limit = Infinity, fetcher } = {}) {
    this.cachePath = cachePath;
    this.cache = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
    this.limit = limit;
    this.lookups = 0;
    this.lastRequest = 0;
    this.fetcher = fetcher ?? ((params) => this.#nominatim(params));
  }

  async #nominatim(params) {
    const wait = this.lastRequest + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequest = Date.now();
    const url = `${NOMINATIM_URL}?${new URLSearchParams({ ...params, format: "jsonv2", limit: "1" })}`;
    const results = await fetchJson(url, { headers: { "user-agent": USER_AGENT } });
    const hit = results[0];
    return hit ? [Number(Number(hit.lat).toFixed(5)), Number(Number(hit.lon).toFixed(5))] : null;
  }

  async #lookup(key, params) {
    if (key in this.cache) return this.cache[key];
    if (this.lookups >= this.limit) return undefined; // budget exhausted; try again next run
    this.lookups++;
    let coords = null;
    try {
      coords = await this.fetcher(params);
    } catch (err) {
      console.warn(`geocode: ${key} failed: ${err.message}`);
      return undefined; // don't cache transient failures
    }
    this.cache[key] = coords;
    if (this.lookups % 25 === 0) this.save();
    return coords;
  }

  // City-level location; falls back to state, then country.
  async place({ city, state, country }) {
    if (city) {
      const hit = await this.#lookup(placeKey({ city, state, country }), clean({ city, state, country }));
      if (hit) return hit;
    }
    if (state) {
      const hit = await this.#lookup(placeKey({ state, country }), clean({ state, country }));
      if (hit) return hit;
    }
    if (country) return (await this.#lookup(placeKey({ country }), { country })) ?? null;
    return null;
  }

  // Street address first (more precise for venues), then the city.
  async address(address, place) {
    if (address) {
      const hit = await this.#lookup(addressKey(address), { q: address });
      if (hit) return hit;
    }
    return this.place(place);
  }

  save() {
    if (!this.cachePath) return;
    const sorted = Object.fromEntries(Object.entries(this.cache).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(this.cachePath, JSON.stringify(sorted, null, 0).replace(/,"/g, ',\n"') + "\n");
  }
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v));
}

// Teams in the same town share a geocode. Spread them in a small, stable
// spiral (~1-3 km) so each marker stays clickable when zoomed all the way in.
export function spread(coords, index) {
  if (!coords || index === 0) return coords;
  const angle = index * 2.399963; // golden angle
  const r = 0.006 * Math.sqrt(index);
  const [lat, lon] = coords;
  const dLon = (r * Math.sin(angle)) / Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
  return [+(lat + r * Math.cos(angle)).toFixed(5), +(lon + dLon).toFixed(5)];
}
