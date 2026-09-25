// Copies browser dependencies out of node_modules so the site in public/
// can be served (or deployed) as plain static files.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "vendor");

const files = [
  ["leaflet/dist/leaflet.js", "leaflet.js"],
  ["leaflet/dist/leaflet.css", "leaflet.css"],
  ["leaflet/dist/images", "images"],
  ["leaflet.markercluster/dist/leaflet.markercluster.js", "leaflet.markercluster.js"],
  ["leaflet.markercluster/dist/MarkerCluster.css", "MarkerCluster.css"],
];

mkdirSync(out, { recursive: true });
for (const [from, to] of files) {
  const src = join(root, "node_modules", from);
  if (!existsSync(src)) {
    console.warn(`vendor: missing ${from}, skipping`);
    continue;
  }
  cpSync(src, join(out, to), { recursive: true });
}
console.log(`vendor: copied browser libraries to ${out}`);
