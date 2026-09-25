# PulsePoint: FTC World Map

An interactive map of every *FIRST* Tech Challenge team and event, similar to
[match13.com/map](https://www.match13.com/map). It combines two data sources:

| Source | Used for |
| --- | --- |
| [FTC Events API](https://ftc-events.firstinspires.org/services/API) (official) | Registered teams for the season, event venues and addresses, event types, dates and livestream links |
| [FTCScout API](https://ftcscout.org/api) | Season OPR stats and world ranks (total, auto, teleop, endgame), event progress (live/finished) and which teams attend which events |

Neither API publishes coordinates, so teams are geocoded at the city level
and events at their venue address, using OpenStreetMap
[Nominatim](https://nominatim.org/). Results are cached in `data/geocache.json`.

## Features

- Team markers colored by season OPR world-rank percentile or by team experience. Clusters take the average color of their teams.
- Event markers (diamonds) for upcoming, live (pulsing) and completed events, with filters by event type.
- Country and state/province filters that zoom the map to the selection.
- Search by team number, team name, event name or event code.
- Team panel: stats with world ranks, the team's events, and links to FTCScout / FTC Events. Dashed lines connect the team to its events on the map.
- Event panel: venue, dates, livestream, the attending teams ranked by OPR, and the average OPR of the field. Lines connect the event to its teams.
- A season selector and shareable URLs (`#season=2025&team=12345`, `#event=USCAFFS`, `#country=USA&state=CA`).
- Light and dark themes, and a mobile layout.

## Running locally

```sh
npm install                       # also copies Leaflet into public/vendor
export FTC_EVENTS_USERNAME=...    # free key: https://ftc-events.firstinspires.org/services/API/register
export FTC_EVENTS_TOKEN=...
npm run build-data                # current season → public/data/<season>.json
npm run build-data -- --season 2025
npm start                         # http://localhost:8080
```

Without FTC Events credentials, the build still works from FTCScout alone. The
team list is then limited to teams that appear on an event roster.

The first build geocodes a few thousand places at 1 request/second, which
takes a while. Pass `--geocode-limit 500` to cap the number of new lookups per
run; teams that aren't geocoded yet are listed as "unmapped" and filled in on
later runs.

Other options (environment variables): `GEOCODE_LIMIT`, `NOMINATIM_URL`,
`GEOCODER_USER_AGENT`, `FTCSCOUT_URL`, `FTC_EVENTS_URL`.

## Deploying (GitHub Pages)

`.github/workflows/deploy.yml` rebuilds the data for the current and previous
seasons every 6 hours (or when you click **Run workflow**) and publishes
`public/` to GitHub Pages. Pushes that only change the site reuse the data
already live, so they deploy in a couple of minutes; pushes that change
`lib/`, `scripts/` or the package files rebuild the data. To set it up:

1. Under **Settings → Pages**, set the source to **GitHub Actions**.
2. Under **Settings → Secrets and variables → Actions**, add `FTC_EVENTS_USERNAME` and `FTC_EVENTS_TOKEN`.
3. Run the workflow from the **Actions** tab.

The geocode cache is kept between runs with the Actions cache, so only new
locations are looked up.

## Project layout

```
lib/ftcscout.js      FTCScout GraphQL client
lib/ftcevents.js     FTC Events API client (basic auth)
lib/merge.js         merges both sources into one dataset
lib/geocode.js       cached Nominatim geocoder
scripts/build-data.js  builds public/data/<season>.json
public/              the static site (Leaflet + markercluster)
server.js            local static server
```

Tests: `npm test`.
