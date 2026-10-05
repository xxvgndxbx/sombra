# Sombra Madrid — practical shade-routing pilot

Real walking routes inside a 5 km radius of IE Business School, María de Molina 31,
weighted by where Madrid's buildings actually cast shade.

## Run it

Double-click **`run.command`**. It picks a free port, serves the folder and opens
your browser. Leave the Terminal window it opens running; Control-C stops it.

If macOS refuses to run it the first time, right-click the file, choose Open, and
confirm once. If it is not executable, run `chmod +x run.command` in that folder.

To do it by hand instead:

```bash
ruby -run -e httpd . -b 127.0.0.1 -p 8080
# or, if the Xcode command line tools are installed
python3 -m http.server 8080
```

Then open <http://127.0.0.1:8080>.

The page has to be served over HTTP. Opening `index.html` directly as a `file://`
document will not work: browsers block a local page from calling the live data
services, so address search, streets, building heights and weather all fail. The
app detects this and shows a warning bar rather than failing silently.

## What is real

- The map and pedestrian street graph come from OpenStreetMap via Overpass.
- Building footprints and metre heights come from Madrid City Council's
  `EDIFICIOS_ALTURAS` ArcGIS layer, with OpenStreetMap building heights as a fallback.
- Solar altitude and bearing are calculated locally for the selected date, time and
  Madrid coordinates.
- Building shadows are projected from each footprint using its measured height.
- Each street segment is sampled against the shadow polygons.
- Dijkstra routing produces both the shortest walking route and a shade-weighted route.
- Address fields suggest real places as you type.
- A/B pins can be dragged or dropped on the map and are reverse-geocoded to an address.
- High-accuracy `watchPosition()` tracking moves a blue location marker and accuracy circle.
- Departure-time temperature, apparent temperature, cloud cover and direct radiation
  come from Open-Meteo.

## Reading the map

The selected route is coloured segment by segment:

| Colour | Meaning |
| --- | --- |
| Yellow `#f5c542` | Sun is on the street — under a third of the segment is shaded |
| Tan `#d3a76d` | Partly shaded — roughly a third to two thirds |
| Brown `#a98467` | Building shade over most of the segment |
| Red dashed `#ee7157` | The other route, shown for reference |

Translucent dark polygons are the projected building shadows for the chosen
departure time.

## How the pieces fit together

`app.js` runs in four stages, with a progress bar for each:

1. **Map data.** The corridor is split into tiles of roughly 1.1 km a side and
   fetched from the **OpenStreetMap core API**, two tiles at a time. One request
   returns both walkable ways and building footprints. This replaced Overpass as
   the primary source after measuring both from Madrid: the core API answered a
   1.2 km box in 1.0-1.8 s, while every public Overpass mirror returned HTTP 504
   or timed out on the same query — including on boxes as small as 660 m. Ways
   arrive as node references, so geometry is resolved locally into the same
   shape the Overpass path produces. Overpass remains as a fallback, also tiled,
   with a small probe that picks a mirror proven to hold data for this region
   before any real query is sent.
2. **Heights.** Madrid City Council's measured `ALTURA` layer is requested in
   parallel with the map tiles, paged concurrently at 2,000 records per page.
   The query asks for `geometryPrecision=6` and a ~3 m simplification tolerance,
   which halves the payload (1.26 MB to 0.51 MB per page, measured) with no cost
   in time or feature count, because footprints exist only to cast shadows.
   If that service is unavailable, the footprints that already arrived with the
   streets are used instead, with height derived from `height` or
   `building:levels x 3.2 m`, and the results panel labels the run as estimated
   rather than measured.
3. **Shadows and scoring.** Each footprint is extruded away from the sun and
   hulled into a shadow polygon, indexed into a 60 m grid. Every undirected
   street edge is sampled three to five times against that index. Scoring yields
   to the event loop every 2,048 edges so the progress bar keeps moving and the
   tab stays responsive.
4. **Routing.** A binary-heap Dijkstra runs twice over the same scored graph:
   once on plain distance, once with sun exposure added to the cost. The shade
   weight is `0.35 + priority x 0.55`, so the priority slider re-routes instantly
   from the cached graph without touching the network.

A live run from IE Business School to Plaza de Colon completes in about 40
seconds: ~3 s for street tiles, the rest waiting on the height service, over
10,000 building sections analysed.

## Pilot limitations

This is research software, not turn-by-turn navigation. It does not model tree canopies,
awnings, façade overhangs, road closures, traffic signals or construction. Weather is
shown accurately for the departure time, but cloud cover does not yet change the
geometric shadow score. Madrid's height layer can contain several height sections for
one building, so the interface reports "building sections analysed". Public Overpass
servers may be slow or temporarily reject requests.

Live positioning requires location permission. `watchPosition()` works on localhost and
on secure HTTPS deployments. Weather queries use the route midpoint rounded to two
decimal places rather than transmitting a precise GPS fix.

For production, import the Madrid height layer and an OpenStreetMap Madrid extract into
PostGIS, precompute shadow rasters at 10–15 minute intervals, and expose routing through
Valhalla, pgRouting or a custom contraction-hierarchy service. Do not route commercial
traffic through public Overpass or Nominatim instances.

## Data services

- Streets and footprints: `https://api.openstreetmap.org/api/0.6/map.json` (primary)
- Overpass fallback: `overpass-api.de`, `overpass.kumi.systems`, `overpass.private.coffee`
- Madrid building heights: `https://sigma.madrid.es/hosted/rest/services/cartografia/EDIFICIOS_ALTURAS/MapServer/0`
- OpenStreetMap tiles: `https://tile.openstreetmap.org`
- Place autocomplete: `https://photon.komoot.io` (Nominatim fallback)
- Address and reverse lookup: `https://nominatim.openstreetmap.org`
- Weather: `https://api.open-meteo.com/v1/forecast`

A note on the core API: it exists to serve editors, not bulk consumers. Tiles
are cached in `localStorage` per bounding box so a repeated corridor costs
nothing, which keeps a pilot's usage modest. Anything beyond a pilot should work
from a local extract, as described above, rather than querying it per request.
