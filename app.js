/* ==========================================================================
   Sombra Madrid — shade-aware walking routes
   Browser-only research prototype.

   This build fixes the three things that were broken:
     1. Address fields now suggest places as you type (Photon, Nominatim
        fallback) instead of only reacting to the Enter key.
     2. Map + route loading is resilient: Leaflet has a CDN fallback, the
        Overpass street query fails over between mirrors, and if Madrid's
        official height service is unreachable the app falls back to
        OpenStreetMap building heights instead of aborting the whole run.
     3. The selected route is drawn segment by segment — yellow where the
        sun hits the street, brown where a building is casting shade.
   ========================================================================== */

(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Configuration
   * ------------------------------------------------------------------ */

  const IE = {
    lat: 40.43801,
    lng: -3.68235,
    name: "IE Business School · María de Molina 31"
  };

  const PILOT_RADIUS = 5000;          // metres from IE
  const WALK_SPEED_M_PER_MIN = 80;    // ~4.8 km/h

  // Global Overpass instances only. Regional mirrors (overpass.osm.ch, for
  // example, which only holds Switzerland) answer a Madrid query with a fast
  // "200 OK / zero elements", which is indistinguishable from success unless
  // you check the payload — see the emptiness guard in overpassQuery().
  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ];
  const OVERPASS_TIMEOUT_MS = 60000;
  // Bumped when the caching rules change, so entries written by an older
  // build (including empty ones) are ignored rather than trusted.
  const STREET_CACHE_PREFIX = "sombra-streets-v2:";
  const BUILDING_CACHE_PREFIX = "sombra-buildings-v1:";

  // Measured against the live service from central Madrid: one full 2,000
  // record page takes about 7.5 seconds, so a generous per-page budget plus
  // concurrent paging keeps the whole step near 10-15 seconds.
  const ARCGIS_PAGE_SIZE = 2000;
  const ARCGIS_MAX_PAGES = 6;
  const ARCGIS_TIMEOUT_MS = 45000;

  // The OpenStreetMap core API. Measured against the public Overpass mirrors
  // from Madrid: this returns a 1.2 km box in ~1.8 s while every Overpass
  // instance answered the same query with 504 or a timeout. It also hands back
  // streets and building footprints in one response instead of two queries.
  // Bounded to 0.25 deg2 and 50,000 nodes per request, hence the tiling.
  const OSM_API = "https://api.openstreetmap.org/api/0.6/map.json";
  const OSM_TILE_DEG = { lat: 0.0105, lng: 0.0130 }; // ~1.1 km a side
  const OSM_TIMEOUT_MS = 40000;

  const MADRID_HEIGHTS =
    "https://sigma.madrid.es/hosted/rest/services/cartografia/EDIFICIOS_ALTURAS/MapServer/0/query";
  const PHOTON = "https://photon.komoot.io/api/";
  const NOMINATIM = "https://nominatim.openstreetmap.org";
  const OPEN_METEO = "https://api.open-meteo.com/v1/forecast";

  const WALKABLE_RE =
    "footway|pedestrian|path|living_street|residential|service|steps|primary|secondary|tertiary|unclassified|cycleway|track|road";
  const WALKABLE = new Set(WALKABLE_RE.split("|"));

  // Sun-exposure colour scale used for the per-segment route rendering.
  const COLOR = {
    sun: "#f5c542",      // fully exposed
    mixed: "#d3a76d",    // partly shaded
    shade: "#a98467",    // shaded by a building
    fastest: "#ee7157",  // reference line for the alternative route
    casing: "#ffffff"
  };

  const IS_FILE_PROTOCOL = location.protocol === "file:";

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const yieldToUI = () => sleep(0);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function haversine(a, b) {
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const p1 = toRad(a.lat);
    const p2 = toRad(b.lat);
    const dp = toRad(b.lat - a.lat);
    const dl = toRad(b.lng - a.lng);
    const h =
      Math.sin(dp / 2) ** 2 +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Flat local projection in metres, anchored at IE. Good enough over 5 km.
  const COS_REF = Math.cos((IE.lat * Math.PI) / 180);
  const localXY = (p) => ({
    x: (p.lng - IE.lng) * 111320 * COS_REF,
    y: (p.lat - IE.lat) * 110540
  });
  const unproject = (p) => ({
    lat: IE.lat + p.y / 110540,
    lng: IE.lng + p.x / (111320 * COS_REF)
  });

  const fmtDistance = (m) =>
    m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
  const fmtTime = (mins) =>
    `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(
      Math.round(mins) % 60
    ).padStart(2, "0")}`;

  function showError(message) {
    const box = $("form-error");
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }
  function clearError() {
    const box = $("form-error");
    if (box) box.hidden = true;
  }
  function setLoading(progress, title, detail) {
    // Any of the three may be null, meaning "leave that part alone".
    const bar = $("loading-progress");
    if (bar && progress !== null && progress !== undefined) {
      bar.style.width = `${progress}%`;
    }
    const t = $("loading-title");
    if (t && title) t.textContent = title;
    if (detail) {
      const d = $("loading-detail");
      if (d) d.textContent = detail;
    }
  }

  /** fetch() with a hard timeout that always clears its timer. */
  async function fetchWithTimeout(url, options = {}, ms = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ *
   * Boot guard — do nothing destructive if Leaflet never arrived
   * ------------------------------------------------------------------ */

  if (typeof window.L === "undefined") {
    const target = $("map");
    if (target) {
      target.innerHTML =
        '<div class="map-boot-error">' +
        "<strong>The map library could not be loaded.</strong>" +
        "<span>Leaflet is fetched from a CDN, so this page needs an internet connection the first time it runs. " +
        "Check your connection (or any content blocker) and reload.</span>" +
        "</div>";
    }
    showError("Leaflet failed to load, so the map and routing are unavailable.");
    return;
  }

  /* ------------------------------------------------------------------ *
   * Application state
   * ------------------------------------------------------------------ */

  const state = {
    points: {
      origin: { ...IE },
      destination: { lat: 40.42523, lng: -3.69071, name: "Plaza de Colón, Madrid" }
    },
    activePick: null,
    markers: {},
    routeLayers: [],
    shadowLayer: null,
    buildingLayer: null,
    results: null,
    selected: "shade",
    priority: 3,
    watchId: null,
    liveMarker: null,
    accuracyCircle: null,
    followLive: true,
    weather: null,
    buildingCache: new Map(),
    streetCache: new Map(),
    lastRun: null,
    overpassMirror: null,
    busy: false
  };

  /* ------------------------------------------------------------------ *
   * Map bootstrap
   * ------------------------------------------------------------------ */

  const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView(
    [IE.lat, IE.lng],
    14
  );
  L.control.zoom({ position: "bottomright" }).addTo(map);

  const tiles = L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      crossOrigin: true,
      attribution: "© OpenStreetMap contributors"
    }
  ).addTo(map);

  // If the main OSM tile server is unreachable, swap to a mirror once.
  let tileErrors = 0;
  let tilesSwapped = false;
  tiles.on("tileerror", () => {
    tileErrors += 1;
    if (tileErrors > 6 && !tilesSwapped) {
      tilesSwapped = true;
      tiles.setUrl("https://tile.openstreetmap.de/{z}/{x}/{y}.png");
    }
  });

  const radiusCircle = L.circle([IE.lat, IE.lng], {
    radius: PILOT_RADIUS,
    color: "#6d8e82",
    weight: 1.5,
    dashArray: "6 7",
    fillColor: "#dce8dc",
    fillOpacity: 0.08,
    interactive: false
  }).addTo(map);
  radiusCircle.bindTooltip("5 km pilot area", {
    permanent: true,
    direction: "top",
    className: "radius-label"
  });

  const ieMarker = L.circleMarker([IE.lat, IE.lng], {
    radius: 8,
    weight: 4,
    color: "white",
    fillColor: "#153c32",
    fillOpacity: 1
  }).addTo(map);
  ieMarker.bindTooltip(IE.name, { direction: "top" });

  // Leaflet occasionally boots before the grid has its final size.
  setTimeout(() => map.invalidateSize(), 250);
  window.addEventListener("resize", () => map.invalidateSize());

  /* ------------------------------------------------------------------ *
   * Endpoint pins
   * ------------------------------------------------------------------ */

  function endpointIcon(kind) {
    return L.divIcon({
      className: "",
      html: `<div class="endpoint-marker ${kind}"><span>${
        kind === "origin" ? "A" : "B"
      }</span></div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 32]
    });
  }

  function clearDrawnResults() {
    state.routeLayers.forEach((layer) => map.removeLayer(layer));
    state.routeLayers = [];
    if (state.shadowLayer) {
      map.removeLayer(state.shadowLayer);
      state.shadowLayer = null;
    }
    if (state.buildingLayer) {
      map.removeLayer(state.buildingLayer);
      state.buildingLayer = null;
    }
  }

  function invalidateResults() {
    if (!state.results) return;
    state.results = null;
    state.lastRun = null;
    $("result-sheet").hidden = true;
    clearDrawnResults();
  }

  function setPoint(kind, point, updateInput = true) {
    if (haversine(IE, point) > PILOT_RADIUS) {
      showError("That point is outside the 5 km IE Business School pilot area.");
      return false;
    }
    invalidateResults();
    state.points[kind] = point;

    if (state.markers[kind]) map.removeLayer(state.markers[kind]);
    const marker = L.marker([point.lat, point.lng], {
      icon: endpointIcon(kind),
      draggable: true,
      zIndexOffset: 1000
    }).addTo(map);

    marker.on("dragend", async (e) => {
      const p = e.target.getLatLng();
      if (haversine(IE, p) > PILOT_RADIUS) {
        setPoint(kind, state.points[kind]);
        showError("Keep both pins inside the 5 km pilot circle.");
        return;
      }
      const named = await reverseGeocode(p);
      setPoint(kind, { lat: p.lat, lng: p.lng, name: named });
      refreshWeather();
    });

    state.markers[kind] = marker;

    if (updateInput) {
      $(`${kind}-input`).value =
        point.name || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Solar geometry
   * ------------------------------------------------------------------ */

  function solarPosition(date, lat, lng) {
    const rad = Math.PI / 180;
    const dayMs = 86400000;
    const J1970 = 2440588;
    const J2000 = 2451545;
    const d = date.valueOf() / dayMs - 0.5 + J1970 - J2000;

    const M = rad * (357.5291 + 0.98560028 * d);
    const C =
      rad *
      (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L0 = M + C + rad * 102.9372 + Math.PI;

    const dec = Math.asin(Math.sin(L0) * Math.sin(rad * 23.4397));
    const ra = Math.atan2(
      Math.sin(L0) * Math.cos(rad * 23.4397),
      Math.cos(L0)
    );
    const sid = rad * (280.16 + 360.9856235 * d) - lng * rad;
    const H = sid - ra;
    const phi = lat * rad;

    const altitude = Math.asin(
      Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)
    );
    const azSouth = Math.atan2(
      Math.sin(H),
      Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)
    );

    return { altitude: altitude / rad, bearing: (azSouth / rad + 180 + 360) % 360 };
  }

  function departureDate() {
    const raw = $("date-input").value;
    const mins = Number($("time-input").value);
    const [y, m, d] = (raw || "").split("-").map(Number);
    if (!y || !m || !d) {
      const now = new Date();
      now.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
      return now;
    }
    return new Date(y, m - 1, d, Math.floor(mins / 60), mins % 60, 0);
  }

  function routeBBox(a, b, bufferM) {
    const midLat = (a.lat + b.lat) / 2;
    const latPad = bufferM / 110540;
    const lngPad = bufferM / (111320 * Math.cos((midLat * Math.PI) / 180));
    return {
      south: Math.min(a.lat, b.lat) - latPad,
      west: Math.min(a.lng, b.lng) - lngPad,
      north: Math.max(a.lat, b.lat) + latPad,
      east: Math.max(a.lng, b.lng) + lngPad
    };
  }

  const bboxKey = (bbox) =>
    [bbox.south, bbox.west, bbox.north, bbox.east]
      .map((n) => n.toFixed(4))
      .join(":");

  /**
   * Split a bounding box into tiles no larger than roughly 1.2 km a side.
   *
   * Public Overpass servers answer a whole-corridor query for central Madrid
   * with HTTP 504 in about 8 seconds — measured, not guessed — while the same
   * area requested as a handful of smaller boxes succeeds in ~4 seconds each.
   * Tiling also means one bad tile costs one tile, not the whole run.
   */
  function tileBBox(bbox, maxLat = 0.011, maxLng = 0.014) {
    const rows = Math.max(1, Math.ceil((bbox.north - bbox.south) / maxLat));
    const cols = Math.max(1, Math.ceil((bbox.east - bbox.west) / maxLng));
    const dLat = (bbox.north - bbox.south) / rows;
    const dLng = (bbox.east - bbox.west) / cols;
    const tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        tiles.push({
          south: bbox.south + r * dLat,
          north: bbox.south + (r + 1) * dLat,
          west: bbox.west + c * dLng,
          east: bbox.west + (c + 1) * dLng
        });
      }
    }
    return tiles;
  }

  /** Run `fn` over items with at most `limit` in flight at once. */
  async function mapWithConcurrency(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, worker)
    );
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Geocoding: autocomplete, search and reverse lookup
   * ------------------------------------------------------------------ */

  /**
   * Place suggestions for the typeahead.
   * Photon is used first because it is built for as-you-type querying;
   * Nominatim is the fallback but is rate limited to roughly 1 req/sec,
   * which is why it is never the primary here.
   */
  async function suggestPlaces(query, signal) {
    const viewLat = IE.lat;
    const viewLng = IE.lng;

    // --- Photon -----------------------------------------------------
    try {
      const url = `${PHOTON}?q=${encodeURIComponent(
        query
      )}&lat=${viewLat}&lon=${viewLng}&limit=8&lang=en`;
      const res = await fetch(url, { signal });
      if (res.ok) {
        const json = await res.json();
        const items = (json.features || [])
          .map((f) => {
            const p = f.properties || {};
            const coords = (f.geometry || {}).coordinates || [];
            const lng = Number(coords[0]);
            const lat = Number(coords[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
            const primary =
              [p.name, p.housenumber].filter(Boolean).join(" ") ||
              p.street ||
              p.city ||
              "Unnamed place";
            const secondary = [
              p.street && p.street !== p.name ? p.street : null,
              p.district,
              p.city,
              p.country
            ]
              .filter(Boolean)
              .join(" · ");
            return { lat, lng, primary, secondary };
          })
          .filter(Boolean);
        const ranked = rankSuggestions(items);
        if (ranked.length) return ranked;
      }
    } catch (err) {
      if (err.name === "AbortError") throw err;
    }

    // --- Nominatim fallback ----------------------------------------
    try {
      const viewbox = [
        IE.lng - 0.075,
        IE.lat + 0.06,
        IE.lng + 0.075,
        IE.lat - 0.06
      ].join(",");
      const url =
        `${NOMINATIM}/search?format=jsonv2&limit=8&countrycodes=es` +
        `&viewbox=${viewbox}&bounded=1&addressdetails=1` +
        `&q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        signal,
        headers: { "Accept-Language": "en" }
      });
      if (!res.ok) return [];
      const data = await res.json();
      const items = data
        .map((x) => {
          const lat = Number(x.lat);
          const lng = Number(x.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          const parts = String(x.display_name || "").split(",");
          return {
            lat,
            lng,
            primary: parts.slice(0, 2).join(",").trim() || "Unnamed place",
            secondary: parts.slice(2, 4).join(",").trim()
          };
        })
        .filter(Boolean);
      return rankSuggestions(items);
    } catch (err) {
      if (err.name === "AbortError") throw err;
      return [];
    }
  }

  /** Annotate with distance from IE, drop anything far from Madrid, sort. */
  function rankSuggestions(items) {
    const seen = new Set();
    return items
      .map((item) => ({
        ...item,
        distance: haversine(IE, item),
        inArea: haversine(IE, item) <= PILOT_RADIUS
      }))
      .filter((item) => {
        if (item.distance > 40000) return false; // not Madrid
        const key = `${item.lat.toFixed(5)},${item.lng.toFixed(5)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Number(b.inArea) - Number(a.inArea) || a.distance - b.distance)
      .slice(0, 6);
  }

  async function reverseGeocode(point) {
    try {
      const res = await fetchWithTimeout(
        `${NOMINATIM}/reverse?format=jsonv2&zoom=18&lat=${point.lat}&lon=${point.lng}`,
        { headers: { "Accept-Language": "en" } },
        9000
      );
      if (!res.ok) throw new Error("reverse failed");
      const x = await res.json();
      const a = x.address || {};
      const street =
        a.road || a.pedestrian || a.footway || a.square || a.neighbourhood;
      const label = [street, a.house_number].filter(Boolean).join(" ");
      if (label) return label;
      if (x.display_name) return x.display_name.split(",").slice(0, 2).join(",");
      return "Dropped pin";
    } catch {
      return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    }
  }

  /* ---------------- Typeahead wiring ---------------- */

  function createAutocomplete(kind) {
    const input = $(`${kind}-input`);
    const list = $(`${kind}-results`);
    let items = [];
    let highlighted = -1;
    let timer = null;
    let controller = null;
    let suppress = false; // set right after a programmatic value change

    function close() {
      list.hidden = true;
      list.innerHTML = "";
      items = [];
      highlighted = -1;
      input.setAttribute("aria-expanded", "false");
    }

    function render() {
      if (!items.length) {
        list.innerHTML =
          '<div class="search-empty">No matching place near Madrid.</div>';
        list.hidden = false;
        input.setAttribute("aria-expanded", "true");
        return;
      }
      list.innerHTML = items
        .map((item, i) => {
          const tag = item.inArea
            ? `<em>${fmtDistance(item.distance)} from IE</em>`
            : '<em class="out">outside 5 km area</em>';
          return (
            `<button type="button" role="option" class="search-result${
              i === highlighted ? " active" : ""
            }" data-i="${i}">` +
            `<strong>${escapeHtml(item.primary)}</strong>` +
            `<span>${escapeHtml(item.secondary || "")}</span>` +
            tag +
            "</button>"
          );
        })
        .join("");
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      list.querySelectorAll(".search-result").forEach((btn) => {
        btn.addEventListener("mousedown", (e) => {
          // mousedown so the click lands before the input's blur closes the list
          e.preventDefault();
          choose(Number(btn.dataset.i));
        });
      });
    }

    function choose(i) {
      const item = items[i];
      if (!item) return;
      const point = {
        lat: item.lat,
        lng: item.lng,
        name: item.primary
      };
      close();
      suppress = true;
      if (setPoint(kind, point)) {
        clearError();
        map.panTo([point.lat, point.lng]);
        refreshWeather();
      }
      setTimeout(() => {
        suppress = false;
      }, 50);
    }

    async function run(query) {
      if (controller) controller.abort();
      controller = new AbortController();
      list.innerHTML = '<div class="search-empty">Searching…</div>';
      list.hidden = false;
      try {
        items = await suggestPlaces(query, controller.signal);
        highlighted = -1;
        render();
      } catch (err) {
        if (err.name === "AbortError") return;
        list.innerHTML =
          '<div class="search-empty">Address search is unavailable right now — use the map pin instead.</div>';
      }
    }

    input.addEventListener("input", () => {
      if (suppress) return;
      const query = input.value.trim();
      clearTimeout(timer);
      if (query.length < 3) {
        close();
        return;
      }
      timer = setTimeout(() => run(query), 280);
    });

    input.addEventListener("keydown", (e) => {
      if (list.hidden || !items.length) {
        if (e.key === "Enter") {
          e.preventDefault();
          const query = input.value.trim();
          if (query.length >= 3) run(query);
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlighted = (highlighted + 1) % items.length;
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlighted = (highlighted - 1 + items.length) % items.length;
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(highlighted >= 0 ? highlighted : 0);
      } else if (e.key === "Escape") {
        close();
      }
    });

    input.addEventListener("blur", () => setTimeout(close, 120));
    input.addEventListener("focus", () => {
      if (items.length) render();
    });

    return { close };
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  /* ------------------------------------------------------------------ *
   * Weather
   * ------------------------------------------------------------------ */

  function weatherIcon(code, cloud) {
    if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "🌧";
    if ([95, 96, 99].includes(code)) return "⛈";
    if (cloud > 75) return "☁";
    if (cloud > 35) return "⛅";
    return "☀";
  }

  async function fetchWeather() {
    const a = state.points.origin;
    const b = state.points.destination;
    const lat = Number(((a.lat + b.lat) / 2).toFixed(2));
    const lng = Number(((a.lng + b.lng) / 2).toFixed(2));
    const date = $("date-input").value;
    const mins = Number($("time-input").value);
    // Open-Meteo reports hourly values, so match on the hour.
    const target = `${date}T${String(Math.floor(mins / 60)).padStart(2, "0")}:00`;

    try {
      const url =
        `${OPEN_METEO}?latitude=${lat}&longitude=${lng}` +
        "&hourly=temperature_2m,apparent_temperature,cloud_cover,direct_radiation,weather_code" +
        "&timezone=Europe%2FMadrid&forecast_days=16";
      const res = await fetchWithTimeout(url, {}, 12000);
      if (!res.ok) throw new Error("weather service");
      const data = await res.json();
      const times = (data.hourly && data.hourly.time) || [];
      let i = times.indexOf(target);
      if (i < 0) {
        const stamp = new Date(target).getTime();
        i = times.reduce(
          (best, t, n) =>
            Math.abs(new Date(t).getTime() - stamp) <
            Math.abs(new Date(times[best]).getTime() - stamp)
              ? n
              : best,
          0
        );
      }
      const w = {
        temp: data.hourly.temperature_2m[i],
        feels: data.hourly.apparent_temperature[i],
        cloud: data.hourly.cloud_cover[i],
        radiation: data.hourly.direct_radiation[i],
        code: data.hourly.weather_code[i],
        time: times[i]
      };
      if (!Number.isFinite(w.temp)) throw new Error("no value");
      state.weather = w;
      renderWeather(w);
      return w;
    } catch {
      state.weather = null;
      $("weather-temp").textContent = "Unavailable";
      $("weather-description").textContent =
        IS_FILE_PROTOCOL
          ? "Blocked on file:// — serve the folder over HTTP"
          : "Weather service could not be reached";
      return null;
    }
  }

  function renderWeather(w) {
    $("weather-icon").textContent = weatherIcon(w.code, w.cloud);
    $("weather-temp").textContent = `${Math.round(w.temp)}°C`;
    $("weather-description").textContent = `Forecast near route · ${fmtTime(
      Number($("time-input").value)
    )}`;
    $("weather-feels").textContent = `${Math.round(w.feels)}°`;
    $("weather-cloud").textContent = `${Math.round(w.cloud)}%`;
    $("weather-radiation").textContent = `${Math.round(w.radiation)} W`;
  }

  let weatherTimer;
  function refreshWeather() {
    clearTimeout(weatherTimer);
    weatherTimer = setTimeout(fetchWeather, 350);
  }

  /* ------------------------------------------------------------------ *
   * Data loading — streets and buildings
   * ------------------------------------------------------------------ */

  /**
   * Run an Overpass query, failing over between mirrors.
   * `minElements` guards against a mirror that reports success but hands back
   * an empty or near-empty result — a regional instance queried outside its
   * region, or a loaded server that quietly truncates. Accepting one of those
   * as an answer is worse than a visible error, because it also poisons the
   * cache, so an implausibly small payload is treated as a failed mirror.
   */
  /**
   * Public Overpass instances grant a client two query slots. Street tiles and
   * building tiles can be in flight at the same time, so every request in the
   * app passes through this gate rather than each fetcher assuming it has the
   * server to itself.
   */
  const overpassGate = (() => {
    const MAX_IN_FLIGHT = 2;
    let active = 0;
    const waiting = [];
    return async (fn) => {
      if (active >= MAX_IN_FLIGHT) {
        await new Promise((resolve) => waiting.push(resolve));
      }
      active += 1;
      try {
        return await fn();
      } finally {
        active -= 1;
        const next = waiting.shift();
        if (next) next();
      }
    };
  })();

  async function overpassQuery(
    query,
    label,
    minElements = 1,
    preferred = null,
    exclusive = false
  ) {
    let lastError = null;
    // A mirror validated for this region is tried first; the rest remain as
    // failover for individual tiles. `exclusive` pins the call to a single
    // mirror, which the probe below needs: otherwise it fails over internally
    // and reports the endpoint it asked for rather than the one that answered.
    const endpoints = exclusive
      ? [preferred]
      : preferred
        ? [preferred, ...OVERPASS_ENDPOINTS.filter((e) => e !== preferred)]
        : OVERPASS_ENDPOINTS;
    for (const endpoint of endpoints) {
      const host = endpoint.split("/")[2];
      try {
        const res = await overpassGate(() =>
          fetchWithTimeout(
            endpoint,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
              },
              body: `data=${encodeURIComponent(query)}`
            },
            OVERPASS_TIMEOUT_MS
          )
        );
        // 504 means the server gave up on the query, 429 that we are over the
        // slot limit; both are worth naming so the error is diagnosable.
        if (!res.ok) throw new Error(`${host} returned ${res.status}`);

        const json = await res.json();
        if (!json || !Array.isArray(json.elements)) {
          throw new Error(`${host} returned a malformed response`);
        }
        // Overpass reports server-side trouble in `remark` alongside a 200.
        if (json.remark) throw new Error(`${host}: ${json.remark}`);
        if (json.elements.length < minElements) {
          throw new Error(
            `${host} returned only ${json.elements.length} ${label} for this area`
          );
        }
        return json.elements;
      } catch (err) {
        lastError = err;
        console.warn(`Overpass mirror ${host} unusable:`, err.message);
        // Try the next mirror.
      }
    }
    throw new Error(
      `Could not load ${label} from any OpenStreetMap mirror (${
        lastError ? lastError.message : "all endpoints failed"
      }). The public Overpass servers are often busy — wait a moment and try again.`
    );
  }

  /**
   * Choose a mirror that actually serves this part of the world, once per run.
   *
   * With tiling, an empty tile is legitimate — a park, a plaza — so emptiness
   * can no longer be treated as a failure per request. Instead one tiny probe
   * over the centre of the area establishes that a mirror holds data here at
   * all, which is what caught the Switzerland-only instance. `out ids` keeps
   * the probe to a few kilobytes.
   */
  async function pickOverpassMirror(bbox) {
    if (state.overpassMirror) return state.overpassMirror;
    const lat = (bbox.south + bbox.north) / 2;
    const lng = (bbox.west + bbox.east) / 2;
    const d = 0.003;
    const probe =
      "[out:json][timeout:25];" +
      `way["highway"](${(lat - d).toFixed(5)},${(lng - d).toFixed(5)},` +
      `${(lat + d).toFixed(5)},${(lng + d).toFixed(5)});out ids qt;`;

    let lastError = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        await overpassQuery(probe, "map data", 1, endpoint, true);
        state.overpassMirror = endpoint;
        return endpoint;
      } catch (err) {
        lastError = err;
      }
    }
    console.warn("No usable Overpass mirror:", lastError && lastError.message);
    throw new Error(
      "No OpenStreetMap server could serve this area right now. The public Overpass instances are often busy — wait a minute and try again."
    );
  }

  /**
   * Fetch a bounding box from Overpass as tiles, merging the elements.
   *
   * Two tiles are in flight at a time because public Overpass instances grant
   * a client only two slots; asking for more just queues them. A tile that
   * fails every mirror is retried once after a short pause, and the run only
   * gives up if more than a quarter of the tiles are still missing — a single
   * bad tile shouldn't lose the whole corridor.
   */
  async function fetchOverpassTiled(bbox, buildQuery, label, onProgress) {
    if (onProgress) onProgress("Finding a responsive OpenStreetMap server…");
    const mirror = await pickOverpassMirror(bbox);

    const tiles = tileBBox(bbox);
    let completed = 0;
    let failed = 0;

    const results = await mapWithConcurrency(tiles, 2, async (tile) => {
      const attempt = () => overpassQuery(buildQuery(tile), label, 0, mirror);
      try {
        return await attempt();
      } catch (first) {
        await sleep(2000);
        try {
          return await attempt();
        } catch (second) {
          failed += 1;
          console.warn(`${label} tile failed twice:`, second.message);
          return null;
        }
      } finally {
        completed += 1;
        if (onProgress) {
          onProgress(
            `Loaded ${completed} of ${tiles.length} map tiles${
              failed ? ` (${failed} failed)` : ""
            }`
          );
        }
      }
    });

    if (failed > Math.max(1, Math.floor(tiles.length / 4))) {
      throw new Error(
        `${failed} of ${tiles.length} ${label} tiles failed. The public OpenStreetMap servers are busy — wait a moment and try again.`
      );
    }

    // Tiles overlap at their edges, so the same way can arrive more than once.
    const byId = new Map();
    for (const list of results) {
      if (!list) continue;
      for (const el of list) {
        if (!byId.has(el.id)) byId.set(el.id, el);
      }
    }
    return [...byId.values()];
  }

  /**
   * Fetch one tile from the OpenStreetMap core API and split it into walkable
   * ways and building footprints.
   *
   * The core API returns nodes and ways separately (ways carry node ids, not
   * coordinates), so geometry is resolved locally into the same
   * `{lat, lon}` shape the Overpass path produces — everything downstream is
   * unchanged regardless of which source answered.
   */
  async function fetchOsmApiTile(tile) {
    const bbox = [tile.west, tile.south, tile.east, tile.north]
      .map((n) => n.toFixed(6))
      .join(",");
    const res = await fetchWithTimeout(
      `${OSM_API}?bbox=${bbox}`,
      { headers: { Accept: "application/json" } },
      OSM_TIMEOUT_MS
    );
    if (!res.ok) throw new Error(`OpenStreetMap API returned ${res.status}`);
    const json = await res.json();
    const elements = json.elements || [];

    const nodes = new Map();
    for (const el of elements) {
      if (el.type === "node") nodes.set(el.id, { lat: el.lat, lon: el.lon });
    }

    const ways = [];
    const buildings = [];
    for (const el of elements) {
      if (el.type !== "way" || !el.tags || !Array.isArray(el.nodes)) continue;

      if (WALKABLE.has(el.tags.highway)) {
        const geometry = [];
        for (const id of el.nodes) {
          const n = nodes.get(id);
          if (n) geometry.push(n);
        }
        if (geometry.length > 1) {
          ways.push({ type: "way", id: el.id, tags: el.tags, geometry });
        }
      }

      if (el.tags.building) {
        const ring = [];
        for (const id of el.nodes) {
          const n = nodes.get(id);
          if (n) ring.push([n.lon, n.lat]);
        }
        if (ring.length > 2) {
          buildings.push({ rings: [ring], height: osmHeight(el.tags) });
        }
      }
    }
    return { ways, buildings };
  }

  function osmHeight(tags) {
    const explicit = parseFloat(tags.height);
    if (Number.isFinite(explicit) && explicit > 2 && explicit < 300) return explicit;
    const levels = parseFloat(tags["building:levels"]);
    if (Number.isFinite(levels) && levels > 0 && levels < 90) return levels * 3.2 + 1.5;
    return 14;
  }

  /**
   * Tile a bounding box across the OSM core API, two requests at a time.
   * Returns walkable ways and building footprints together.
   */
  async function fetchOsmApiTiled(bbox, onProgress) {
    const tiles = tileBBox(bbox, OSM_TILE_DEG.lat, OSM_TILE_DEG.lng);
    let completed = 0;
    let failed = 0;

    const results = await mapWithConcurrency(tiles, 2, async (tile) => {
      try {
        return await fetchOsmApiTile(tile);
      } catch (first) {
        await sleep(1500);
        try {
          return await fetchOsmApiTile(tile);
        } catch (second) {
          failed += 1;
          console.warn("OSM API tile failed twice:", second.message);
          return null;
        }
      } finally {
        completed += 1;
        if (onProgress) {
          onProgress(
            `Loaded ${completed} of ${tiles.length} map tiles${
              failed ? ` (${failed} failed)` : ""
            }`
          );
        }
      }
    });

    if (failed > Math.max(1, Math.floor(tiles.length / 4))) {
      throw new Error(`${failed} of ${tiles.length} OpenStreetMap tiles failed`);
    }

    // Tiles share edges, so the same way can arrive more than once.
    const wayById = new Map();
    const buildings = [];
    for (const part of results) {
      if (!part) continue;
      for (const w of part.ways) if (!wayById.has(w.id)) wayById.set(w.id, w);
      buildings.push(...part.buildings);
    }
    return { ways: [...wayById.values()], buildings };
  }

  // Smallest street count worth caching or routing on. Anything less means the
  // fetch went wrong rather than that Madrid ran out of pavement.
  const MIN_USABLE_WAYS = 25;

  async function fetchWalkingNetwork(bbox, onProgress) {
    const key = bboxKey(bbox);
    if (state.streetCache.has(key)) return state.streetCache.get(key);
    try {
      const cached = localStorage.getItem(`${STREET_CACHE_PREFIX}${key}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length >= MIN_USABLE_WAYS) {
          state.streetCache.set(key, parsed);
          return parsed;
        }
      }
    } catch {
      /* localStorage is unavailable on some file:// setups */
    }

    const elements = await fetchOverpassTiled(
      bbox,
      (tile) =>
        "[out:json][timeout:45];" +
        `way["highway"~"^(${WALKABLE_RE})$"]` +
        `(${tile.south},${tile.west},${tile.north},${tile.east});` +
        "out tags geom qt;",
      "walking streets",
      onProgress
    );
    if (elements.length < MIN_USABLE_WAYS) {
      throw new Error(
        `Only ${elements.length} street features came back for this area — the OpenStreetMap servers are struggling. Try again in a moment.`
      );
    }
    const ways = elements.filter(
      (w) =>
        w.type === "way" &&
        Array.isArray(w.geometry) &&
        w.geometry.length > 1 &&
        w.tags &&
        WALKABLE.has(w.tags.highway) &&
        w.tags.foot !== "no" &&
        w.tags.access !== "private" &&
        w.tags.access !== "no"
    );

    state.streetCache.set(key, ways);
    // Only cache a result big enough to route on, so one bad response can't
    // wedge this bounding box permanently.
    if (ways.length >= MIN_USABLE_WAYS) {
      try {
        localStorage.setItem(`${STREET_CACHE_PREFIX}${key}`, JSON.stringify(ways));
      } catch {
        /* quota or opaque origin — caching is optional */
      }
    }
    return ways;
  }

  /**
   * Building footprints with heights.
   * Preferred source is Madrid City Council's measured height layer. If that
   * service is slow, down, or blocked by CORS we fall back to OpenStreetMap
   * building polygons, deriving height from `height` or `building:levels`.
   * The fallback is what stops one flaky service from killing the whole run.
   */
  const MIN_USABLE_BUILDINGS = 15;

  async function fetchBuildings(bbox, onProgress, overpassFallback = false) {
    const key = bboxKey(bbox);
    if (state.buildingCache.has(key)) return state.buildingCache.get(key);

    // Footprints are reduced to rings plus a height before caching, which is
    // far smaller than the raw GeoJSON and is all the shadow pass needs.
    try {
      const cached = localStorage.getItem(`${BUILDING_CACHE_PREFIX}${key}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.buildings) &&
            parsed.buildings.length >= MIN_USABLE_BUILDINGS) {
          state.buildingCache.set(key, parsed);
          return parsed;
        }
      }
    } catch {
      /* cache is optional */
    }

    let result = null;
    try {
      result = await fetchMadridHeights(bbox, onProgress);
    } catch (err) {
      console.warn("Madrid height service unavailable:", err.message);
    }

    if (!result || result.buildings.length < MIN_USABLE_BUILDINGS) {
      if (overpassFallback) {
        if (onProgress) onProgress("Falling back to OpenStreetMap building data…");
        result = await fetchOsmBuildings(bbox, onProgress);
      } else if (!result) {
        // The caller has its own footprints to fall back on.
        result = { buildings: [], source: "none" };
      }
    }

    state.buildingCache.set(key, result);
    if (result.buildings.length < MIN_USABLE_BUILDINGS) return result;
    try {
      const payload = JSON.stringify(result);
      if (payload.length < 3_000_000) {
        localStorage.setItem(`${BUILDING_CACHE_PREFIX}${key}`, payload);
      }
    } catch {
      /* quota exceeded — the in-memory cache still helps this session */
    }
    return result;
  }

  async function fetchMadridHeights(bbox, onProgress) {
    const geometry = {
      xmin: bbox.west,
      ymin: bbox.south,
      xmax: bbox.east,
      ymax: bbox.north,
      spatialReference: { wkid: 4326 }
    };
    const pageParams = (offset) =>
      new URLSearchParams({
        where: "1=1",
        geometry: JSON.stringify(geometry),
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "OBJECTID,ALTURA",
        returnGeometry: "true",
        outSR: "4326",
        f: "geojson",
        // Footprints are only used to cast shadows, so decimetre precision and
        // a ~3 m simplification tolerance are plenty. This cuts the payload
        // several-fold, which matters: the service is slow enough that the
        // transfer, not the query, is the bottleneck.
        geometryPrecision: "6",
        maxAllowableOffset: "0.00003",
        resultOffset: String(offset),
        resultRecordCount: String(ARCGIS_PAGE_SIZE),
        orderByFields: "OBJECTID"
      });

    const readPage = async (offset) => {
      const res = await fetchWithTimeout(
        `${MADRID_HEIGHTS}?${pageParams(offset)}`,
        {},
        ARCGIS_TIMEOUT_MS
      );
      if (!res.ok) throw new Error(`height service ${res.status}`);
      const json = await res.json();
      if (json.error) {
        throw new Error(json.error.message || "height service error");
      }
      return json.features || [];
    };

    const first = await readPage(0);
    let features = first;

    // Page only when the first page came back full, and fetch the remaining
    // pages concurrently rather than one after another.
    if (first.length >= ARCGIS_PAGE_SIZE) {
      if (onProgress) onProgress("Paging through the Madrid height service…");
      const offsets = [];
      for (let i = 1; i < ARCGIS_MAX_PAGES; i++) offsets.push(i * ARCGIS_PAGE_SIZE);
      const rest = await Promise.all(
        offsets.map((offset) => readPage(offset).catch(() => []))
      );
      features = features.concat(...rest);
    }

    const buildings = features
      .filter(
        (f) =>
          f.geometry &&
          (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
      )
      .map((f) => {
        const raw = Number((f.properties || {}).ALTURA);
        const height = Number.isFinite(raw) && raw > 2 && raw < 300 ? raw : 15;
        return { rings: ringsForGeoJson(f.geometry), height };
      })
      .filter((b) => b.rings.length);

    return { buildings, source: "madrid" };
  }

  async function fetchOsmBuildings(bbox, onProgress) {
    const elements = await fetchOverpassTiled(
      bbox,
      (tile) =>
        "[out:json][timeout:45];" +
        `way["building"](${tile.south},${tile.west},${tile.north},${tile.east});` +
        "out tags geom qt;",
      "building footprints",
      onProgress
    );

    const buildings = elements
      .filter(
        (w) => w.type === "way" && Array.isArray(w.geometry) && w.geometry.length > 2
      )
      .map((w) => {
        const tags = w.tags || {};
        const explicit = parseFloat(tags.height);
        const levels = parseFloat(tags["building:levels"]);
        let height = 14;
        if (Number.isFinite(explicit) && explicit > 2 && explicit < 300) {
          height = explicit;
        } else if (Number.isFinite(levels) && levels > 0 && levels < 90) {
          height = levels * 3.2 + 1.5;
        }
        const ring = w.geometry
          .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
          .map((p) => [p.lon, p.lat]);
        return { rings: ring.length > 2 ? [ring] : [], height };
      })
      .filter((b) => b.rings.length);

    return { buildings, source: "osm" };
  }

  function ringsForGeoJson(geometry) {
    const c = geometry.coordinates || [];
    const rings =
      geometry.type === "Polygon" ? [c[0]] : c.map((poly) => (poly || [])[0]);
    return rings.filter((ring) => Array.isArray(ring) && ring.length > 2);
  }

  /* ------------------------------------------------------------------ *
   * Graph construction
   * ------------------------------------------------------------------ */

  function buildGraph(ways) {
    const graph = new Map();
    const edges = [];

    const ensure = (p) => {
      const lat = Number(p.lat);
      const lng = Number(p.lng !== undefined ? p.lng : p.lon);
      const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
      let node = graph.get(key);
      if (!node) {
        node = { lat, lng, key, edges: [] };
        graph.set(key, node);
      }
      return node;
    };

    for (const way of ways) {
      const hw = (way.tags || {}).highway;
      const penalty =
        hw === "steps" ? 1.8 : hw === "primary" || hw === "secondary" ? 1.12 : 1;
      const geom = way.geometry;
      for (let i = 0; i < geom.length - 1; i++) {
        const a = ensure(geom[i]);
        const b = ensure(geom[i + 1]);
        if (a === b) continue;
        const meters = haversine(a, b);
        if (!(meters > 0) || meters > 400) continue;
        // One shared record per undirected edge, referenced from both ends:
        // shade only has to be computed once.
        const rec = { meters, penalty, shade: 0, a, b };
        edges.push(rec);
        a.edges.push({ to: b.key, rec });
        b.edges.push({ to: a.key, rec });
      }
    }
    return { graph, edges };
  }

  /** Grid-indexed nearest-node lookup: much faster than scanning every node. */
  function buildNodeIndex(graph, cell = 120) {
    const cells = new Map();
    for (const node of graph.values()) {
      const q = localXY(node);
      node._x = q.x;
      node._y = q.y;
      const k = `${Math.floor(q.x / cell)},${Math.floor(q.y / cell)}`;
      let bucket = cells.get(k);
      if (!bucket) cells.set(k, (bucket = []));
      bucket.push(node);
    }
    return { cells, cell };
  }

  function nearestNode(index, point) {
    const q = localXY(point);
    const cx = Math.floor(q.x / index.cell);
    const cy = Math.floor(q.y / index.cell);
    let best = null;
    let bestDist = Infinity;
    for (let ring = 0; ring <= 6; ring++) {
      for (let x = cx - ring; x <= cx + ring; x++) {
        for (let y = cy - ring; y <= cy + ring; y++) {
          // Only walk the outer ring of each expansion.
          if (ring > 0 && Math.abs(x - cx) !== ring && Math.abs(y - cy) !== ring) {
            continue;
          }
          const bucket = index.cells.get(`${x},${y}`);
          if (!bucket) continue;
          for (const node of bucket) {
            const dx = node._x - q.x;
            const dy = node._y - q.y;
            const d = Math.hypot(dx, dy);
            if (d < bestDist) {
              bestDist = d;
              best = node;
            }
          }
        }
      }
      if (best && bestDist <= index.cell * ring) break;
    }
    return { node: best, distance: bestDist };
  }

  /* ------------------------------------------------------------------ *
   * Shadow projection and per-edge shade scoring
   * ------------------------------------------------------------------ */

  function convexHull(points) {
    if (points.length <= 3) return points;
    const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) =>
      (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (
        lower.length >= 2 &&
        cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
      ) {
        lower.pop();
      }
      lower.push(p);
    }
    const upper = [];
    for (const p of [...pts].reverse()) {
      while (
        upper.length >= 2 &&
        cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
      ) {
        upper.pop();
      }
      upper.push(p);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  function makeShadows(buildings, solar) {
    if (solar.altitude <= 2) return [];
    const away = ((solar.bearing + 180) * Math.PI) / 180;
    const tanAlt = Math.tan((solar.altitude * Math.PI) / 180);
    const shadows = [];

    for (const building of buildings) {
      const length = Math.min(250, building.height / tanAlt);
      if (!(length > 1)) continue;
      const dx = Math.sin(away) * length;
      const dy = Math.cos(away) * length;

      for (const ring of building.rings) {
        const base = [];
        for (const coord of ring) {
          const lng = Number(coord[0]);
          const lat = Number(coord[1]);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          base.push(localXY({ lat, lng }));
        }
        if (base.length < 3) continue;

        const shifted = base.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        const poly = convexHull(base.concat(shifted));
        if (poly.length < 3) continue;

        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        let ok = true;
        for (const p of poly) {
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            ok = false;
            break;
          }
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        if (!ok) continue;
        shadows.push({ poly, minX, maxX, minY, maxY, height: building.height });
      }
    }
    return shadows;
  }

  function buildShadowIndex(shadows, cell = 60) {
    const cells = new Map();
    shadows.forEach((s, i) => {
      const x0 = Math.floor(s.minX / cell);
      const x1 = Math.floor(s.maxX / cell);
      const y0 = Math.floor(s.minY / cell);
      const y1 = Math.floor(s.maxY / cell);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const k = `${x},${y}`;
          let bucket = cells.get(k);
          if (!bucket) cells.set(k, (bucket = []));
          bucket.push(i);
        }
      }
    });
    return { shadows, cells, cell };
  }

  function pointInPolygon(px, py, poly) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (
        a.y > py !== b.y > py &&
        px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y || 1e-9) + a.x
      ) {
        hit = !hit;
      }
    }
    return hit;
  }

  function isShadedXY(x, y, index) {
    const bucket = index.cells.get(
      `${Math.floor(x / index.cell)},${Math.floor(y / index.cell)}`
    );
    if (!bucket) return false;
    for (let i = 0; i < bucket.length; i++) {
      const s = index.shadows[bucket[i]];
      if (x < s.minX || x > s.maxX || y < s.minY || y > s.maxY) continue;
      if (pointInPolygon(x, y, s.poly)) return true;
    }
    return false;
  }

  /** Score every undirected edge once, yielding to the UI periodically. */
  async function scoreEdges(edges, index, onProgress) {
    const total = edges.length;
    for (let i = 0; i < total; i++) {
      const e = edges[i];
      const ax = e.a._x !== undefined ? e.a._x : localXY(e.a).x;
      const ay = e.a._y !== undefined ? e.a._y : localXY(e.a).y;
      const bx = e.b._x !== undefined ? e.b._x : localXY(e.b).x;
      const by = e.b._y !== undefined ? e.b._y : localXY(e.b).y;

      const samples = e.meters > 60 ? 5 : 3;
      let shaded = 0;
      for (let s = 0; s < samples; s++) {
        const t = (s + 0.5) / samples;
        if (isShadedXY(ax + (bx - ax) * t, ay + (by - ay) * t, index)) shaded++;
      }
      e.shade = shaded / samples;

      if ((i & 2047) === 2047) {
        if (onProgress) onProgress(i / total);
        await yieldToUI();
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Routing
   * ------------------------------------------------------------------ */

  class MinHeap {
    constructor() {
      this.a = [];
    }
    get size() {
      return this.a.length;
    }
    push(k, p) {
      const a = this.a;
      a.push({ k, p });
      let i = a.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (a[parent].p <= a[i].p) break;
        const t = a[parent];
        a[parent] = a[i];
        a[i] = t;
        i = parent;
      }
    }
    pop() {
      const a = this.a;
      if (!a.length) return null;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let s = i;
          if (l < a.length && a[l].p < a[s].p) s = l;
          if (r < a.length && a[r].p < a[s].p) s = r;
          if (s === i) break;
          const t = a[s];
          a[s] = a[i];
          a[i] = t;
          i = s;
        }
      }
      return top;
    }
  }

  function dijkstra(graph, startKey, endKey, mode, priority) {
    if (startKey === endKey) return null;

    const dist = new Map([[startKey, 0]]);
    const prev = new Map();
    const settled = new Set();
    const heap = new MinHeap();
    heap.push(startKey, 0);

    // How hard to avoid sun. Higher priority = longer detours accepted.
    const shadeWeight = 0.35 + priority * 0.55;

    while (heap.size) {
      const top = heap.pop();
      if (settled.has(top.k)) continue;
      settled.add(top.k);
      if (top.k === endKey) break;

      const node = graph.get(top.k);
      if (!node) continue;
      const du = dist.get(top.k);

      for (const link of node.edges) {
        const e = link.rec;
        const exposure = 1 - (e.shade || 0);
        const cost =
          e.meters * e.penalty * (mode === "shade" ? 1 + exposure * shadeWeight : 1);
        const alt = du + cost;
        const known = dist.get(link.to);
        if (known === undefined || alt < known) {
          dist.set(link.to, alt);
          prev.set(link.to, { key: top.k, rec: e });
          heap.push(link.to, alt);
        }
      }
    }

    if (!prev.has(endKey)) return null;

    const keys = [endKey];
    while (keys[0] !== startKey) {
      const step = prev.get(keys[0]);
      if (!step) return null;
      keys.unshift(step.key);
      if (keys.length > 200000) return null;
    }

    let meters = 0;
    let shadedMeters = 0;
    const segments = [];
    for (let i = 0; i < keys.length - 1; i++) {
      const from = graph.get(keys[i]);
      const to = graph.get(keys[i + 1]);
      const link = from.edges.find((l) => l.to === keys[i + 1]);
      if (!link) continue;
      const shade = link.rec.shade || 0;
      meters += link.rec.meters;
      shadedMeters += link.rec.meters * shade;
      segments.push({ from, to, shade, meters: link.rec.meters });
    }

    return {
      keys,
      points: keys.map((k) => graph.get(k)),
      segments,
      meters,
      shadePercent: meters > 0 ? Math.round((shadedMeters / meters) * 100) : 0,
      minutes: Math.max(1, Math.round(meters / WALK_SPEED_M_PER_MIN))
    };
  }

  /* ------------------------------------------------------------------ *
   * Drawing
   * ------------------------------------------------------------------ */

  function shadeColor(shade) {
    if (shade >= 0.62) return COLOR.shade;
    if (shade >= 0.3) return COLOR.mixed;
    return COLOR.sun;
  }

  function drawBuildingShadows(shadows) {
    if (state.shadowLayer) map.removeLayer(state.shadowLayer);
    const polygons = shadows.slice(0, 4000).map((s) =>
      L.polygon(
        s.poly.map((p) => {
          const ll = unproject(p);
          return [ll.lat, ll.lng];
        }),
        {
          stroke: false,
          fillColor: "#153c32",
          fillOpacity: 0.16,
          interactive: false
        }
      )
    );
    state.shadowLayer = L.layerGroup(polygons).addTo(map);
  }

  function drawRoutes(results, selected) {
    clearDrawnResults();
    state.selected = selected;

    const active = selected === "shade" ? results.shade : results.fastest;
    const other = selected === "shade" ? results.fastest : results.shade;

    // Reference line for the route that is not selected.
    if (other && other !== active) {
      const ref = L.polyline(
        other.points.map((p) => [p.lat, p.lng]),
        {
          color: COLOR.fastest,
          weight: 3,
          opacity: 0.55,
          dashArray: "6 8",
          lineCap: "round",
          interactive: false
        }
      ).addTo(map);
      state.routeLayers.push(ref);
    }

    // White casing so the coloured segments read clearly over the map.
    const casing = L.polyline(
      active.points.map((p) => [p.lat, p.lng]),
      {
        color: COLOR.casing,
        weight: 13,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
        interactive: false
      }
    ).addTo(map);
    state.routeLayers.push(casing);

    // The actual sun/shade colouring, one polyline per street segment.
    // Consecutive segments of the same colour are merged so the line looks
    // continuous rather than dotted.
    let run = [];
    let runColor = null;
    const flush = () => {
      if (run.length < 2 || !runColor) return;
      const line = L.polyline(run, {
        color: runColor,
        weight: 7,
        opacity: 1,
        lineCap: "round",
        lineJoin: "round",
        interactive: false
      }).addTo(map);
      state.routeLayers.push(line);
    };

    for (const segment of active.segments) {
      const color = shadeColor(segment.shade);
      if (color !== runColor) {
        flush();
        run = [[segment.from.lat, segment.from.lng]];
        runColor = color;
      }
      run.push([segment.to.lat, segment.to.lng]);
    }
    flush();

    if (state.markers.origin) state.markers.origin.setZIndexOffset(1000);
    if (state.markers.destination) state.markers.destination.setZIndexOffset(1000);

    const bounds = L.latLngBounds(active.points.map((p) => [p.lat, p.lng]));
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.18), { paddingBottomRight: [0, 160] });
    }
  }

  function routeCard(key, route, fastest) {
    const extra = route.minutes - fastest.minutes;
    const label = key === "shade" ? "Shadiest" : "Fastest";
    const sub =
      key === "shade"
        ? `${route.shadePercent}% in shade · ${
            extra > 0 ? `+${extra} min` : "same time"
          }`
        : `${route.shadePercent}% in shade · direct`;
    return (
      `<button type="button" class="route-option${
        key === state.selected ? " active" : ""
      }" data-route="${key}">` +
      `<span class="route-swatch ${key}">${key === "shade" ? "☾" : "↗"}</span>` +
      `<span class="route-copy"><strong>${label}</strong><span>${sub}</span></span>` +
      `<span class="route-big"><strong>${route.minutes} min</strong><small>${fmtDistance(
        route.meters
      )}</small></span>` +
      "</button>"
    );
  }

  function showResults(results, meta) {
    state.results = results;
    const opts = $("route-options");
    opts.innerHTML =
      routeCard("fast", results.fastest, results.fastest) +
      routeCard("shade", results.shade, results.fastest);

    opts.querySelectorAll(".route-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        opts
          .querySelectorAll(".route-option")
          .forEach((x) => x.classList.remove("active"));
        btn.classList.add("active");
        drawRoutes(results, btn.dataset.route);
      });
    });

    $("building-count").textContent = `${meta.buildingCount.toLocaleString()} building sections analysed`;
    $("solar-summary").textContent = `Sun ${meta.solar.altitude.toFixed(
      1
    )}° high · ${Math.round(meta.solar.bearing)}° bearing`;
    $("result-weather").textContent = state.weather
      ? `${Math.round(state.weather.temp)}°C · ${Math.round(
          state.weather.cloud
        )}% cloud`
      : "Weather unavailable";

    const quality = $("calculation-quality");
    if (meta.source === "madrid") {
      quality.textContent = "Measured Madrid heights";
      quality.classList.remove("estimated");
    } else {
      quality.textContent = "OSM estimated heights";
      quality.classList.add("estimated");
    }

    $("result-sheet").hidden = false;
  }

  /* ------------------------------------------------------------------ *
   * Main calculation
   * ------------------------------------------------------------------ */

  const runSignature = () =>
    [
      state.points.origin.lat.toFixed(5),
      state.points.origin.lng.toFixed(5),
      state.points.destination.lat.toFixed(5),
      state.points.destination.lng.toFixed(5),
      $("date-input").value,
      $("time-input").value
    ].join("|");

  async function calculate() {
    if (state.busy) return;
    clearError();

    const a = state.points.origin;
    const b = state.points.destination;

    if (haversine(IE, a) > PILOT_RADIUS || haversine(IE, b) > PILOT_RADIUS) {
      return showError("Both locations must stay inside the 5 km pilot circle.");
    }
    if (haversine(a, b) < 80) {
      return showError("Choose locations at least 80 metres apart.");
    }
    if (haversine(a, b) > 8500) {
      return showError("For this browser pilot, keep the direct journey below 8.5 km.");
    }

    const solar = solarPosition(departureDate(), IE.lat, IE.lng);
    if (solar.altitude <= 2) {
      return showError(
        "The sun is below the horizon at that time, so building shade is not meaningful. Pick a daylight departure."
      );
    }

    state.busy = true;
    const weatherPromise = fetchWeather();
    $("loading").hidden = false;
    $("calculate").disabled = true;
    $("result-sheet").hidden = true;

    try {
      // One box covers both jobs: a shadow can reach the corridor from a block
      // away, so the map area is the walking corridor plus the longest shadow
      // the sun can cast at this altitude.
      const shadowReach = clamp(
        40 / Math.tan((solar.altitude * Math.PI) / 180),
        60,
        260
      );
      const mapBBox = routeBBox(a, b, 260 + shadowReach);

      // Madrid's measured heights are authoritative but slow, so that request
      // goes out first and runs while the street data is being fetched and the
      // graph built. Streets come from the OSM core API, which also returns
      // building footprints — those are the fallback if Madrid does not answer.
      setLoading(
        10,
        "Loading streets and building heights…",
        "Fetching OpenStreetMap map tiles and Madrid building heights together"
      );
      const heightsSettled = fetchBuildings(mapBBox, (msg) =>
        setLoading(null, null, msg)
      ).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error })
      );

      let ways;
      let osmBuildings = [];
      try {
        const mapData = await fetchOsmApiTiled(mapBBox, (msg) =>
          setLoading(null, null, msg)
        );
        ways = mapData.ways;
        osmBuildings = mapData.buildings;
      } catch (osmErr) {
        console.warn("OSM core API unavailable, trying Overpass:", osmErr.message);
        setLoading(null, null, "OpenStreetMap API unavailable — trying Overpass mirrors…");
        ways = await fetchWalkingNetwork(mapBBox, (msg) =>
          setLoading(null, null, msg)
        );
      }
      if (ways.length < 5) {
        throw new Error("Not enough walkable street data was returned for this area.");
      }

      setLoading(
        30,
        "Building the pedestrian graph…",
        `${ways.length.toLocaleString()} street features loaded`
      );
      await yieldToUI();
      const { graph, edges } = buildGraph(ways);
      const nodeIndex = buildNodeIndex(graph);
      const start = nearestNode(nodeIndex, a);
      const end = nearestNode(nodeIndex, b);
      if (!start.node || !end.node || start.distance > 350 || end.distance > 350) {
        throw new Error("A walkable street could not be found near one of the pins.");
      }

      setLoading(45, "Waiting for building footprints…", "Madrid City Council height service");
      const settled = await heightsSettled;
      let buildings;
      let source;
      if (settled.ok && settled.value.buildings.length >= MIN_USABLE_BUILDINGS) {
        ({ buildings, source } = settled.value);
      } else if (osmBuildings.length >= MIN_USABLE_BUILDINGS) {
        // The footprints that arrived alongside the streets, with heights
        // derived from building:levels. Labelled as estimated in the results.
        buildings = osmBuildings;
        source = "osm";
      } else {
        // Neither Madrid nor the OSM core API produced footprints; ask
        // Overpass directly as a last resort.
        setLoading(null, null, "Fetching building footprints from Overpass…");
        ({ buildings, source } = await fetchOsmBuildings(mapBBox, (msg) =>
          setLoading(null, null, msg)
        ));
      }
      if (!buildings.length) {
        throw new Error("No building footprints were returned for this area, so shade cannot be estimated.");
      }

      setLoading(
        62,
        "Projecting building shadows…",
        `Sun ${solar.altitude.toFixed(1)}° above the horizon at ${fmtTime(
          Number($("time-input").value)
        )}`
      );
      await yieldToUI();
      const shadows = makeShadows(buildings, solar);
      const index = buildShadowIndex(shadows);
      drawBuildingShadows(shadows);

      setLoading(
        72,
        "Scoring every street segment…",
        `${graph.size.toLocaleString()} network points · ${shadows.length.toLocaleString()} projected shadows`
      );
      await scoreEdges(edges, index, (ratio) =>
        setLoading(72 + Math.round(ratio * 18), "Scoring every street segment…")
      );

      setLoading(92, "Finding the fastest and shadiest routes…", "Dijkstra over the scored graph");
      await yieldToUI();
      const fastest = dijkstra(graph, start.node.key, end.node.key, "fast", state.priority);
      const shade = dijkstra(graph, start.node.key, end.node.key, "shade", state.priority);
      if (!fastest || !shade) {
        throw new Error(
          "The public street data did not contain a connected walking route between those points. Try moving a pin closer to a main street."
        );
      }

      setLoading(98, "Drawing the route…", "Almost ready");
      await weatherPromise;

      const results = { fastest, shade };
      const meta = {
        solar,
        buildingCount: buildings.length,
        source,
        startKey: start.node.key,
        endKey: end.node.key
      };
      state.lastRun = { graph, edges, meta, signature: runSignature() };

      state.selected = "shade";
      drawRoutes(results, "shade");
      showResults(results, meta);
    } catch (err) {
      console.error(err);
      let message = err.message || "The live calculation failed. Try again in a moment.";
      if (IS_FILE_PROTOCOL) {
        message +=
          " This page is open as a file:// document, which browsers block from calling live data services — serve the folder over HTTP instead.";
      }
      showError(message);
    } finally {
      state.busy = false;
      $("loading").hidden = true;
      $("calculate").disabled = false;
    }
  }

  /** Re-run routing only (no network) when the shade priority changes. */
  function reroute() {
    const run = state.lastRun;
    if (!run || run.signature !== runSignature() || !state.results) return false;
    const { graph, meta } = run;
    const fastest = dijkstra(graph, meta.startKey, meta.endKey, "fast", state.priority);
    const shade = dijkstra(graph, meta.startKey, meta.endKey, "shade", state.priority);
    if (!fastest || !shade) return false;
    const results = { fastest, shade };
    drawRoutes(results, state.selected);
    showResults(results, meta);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Live location
   * ------------------------------------------------------------------ */

  function stopTracking() {
    if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    $("tracking-button").classList.remove("active");
    $("tracking-status").textContent = "Off · updates as you move";
    $("follow-location").classList.remove("active");
  }

  function startTracking() {
    if (!navigator.geolocation) {
      showError("Live location is not supported by this browser.");
      return;
    }
    $("tracking-button").classList.add("active");
    $("tracking-status").textContent = "Waiting for precise location…";
    $("follow-location").classList.add("active");
    state.followLive = true;

    const onPosition = (position) => {
      const p = { lat: position.coords.latitude, lng: position.coords.longitude };
      const accuracy = position.coords.accuracy;

      if (state.liveMarker) {
        state.liveMarker.setLatLng(p);
      } else {
        const icon = L.divIcon({
          className: "",
          html: '<div class="live-dot"></div>',
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        });
        state.liveMarker = L.marker(p, { icon, zIndexOffset: 2000 }).addTo(map);
      }

      if (state.accuracyCircle) {
        state.accuracyCircle.setLatLng(p).setRadius(accuracy);
      } else {
        state.accuracyCircle = L.circle(p, {
          radius: accuracy,
          color: "#4285f4",
          weight: 1,
          fillColor: "#4285f4",
          fillOpacity: 0.08,
          interactive: false
        }).addTo(map);
      }

      if (haversine(IE, p) > PILOT_RADIUS) {
        $("tracking-status").textContent = `Live · ±${Math.round(
          accuracy
        )} m · outside pilot`;
        return;
      }

      state.points.origin = { ...p, name: "Your live location" };
      if (state.markers.origin) state.markers.origin.setLatLng(p);
      $("origin-input").value = "Your live location";
      $("tracking-status").textContent = `Live · accurate to ±${Math.round(
        accuracy
      )} m`;
      if (state.followLive) map.panTo(p, { animate: true });
      refreshWeather();
    };

    const onError = (err) => {
      stopTracking();
      showError(
        err.code === 1
          ? "Location permission was not granted. Enable it in your browser to use live tracking."
          : "Your live location could not be determined. Try again outdoors or with Wi-Fi enabled."
      );
    };

    state.watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 15000
    });
  }

  /* ------------------------------------------------------------------ *
   * Event wiring
   * ------------------------------------------------------------------ */

  $("route-form").addEventListener("submit", (e) => {
    e.preventDefault();
    calculate();
  });

  document.querySelectorAll(".map-pick").forEach((btn) => {
    btn.addEventListener("click", () => {
      const already = state.activePick === btn.dataset.pick;
      document.querySelectorAll(".map-pick").forEach((x) => x.classList.remove("active"));
      const hint = $("map-hint");
      if (already) {
        state.activePick = null;
        hint.classList.remove("show");
        return;
      }
      state.activePick = btn.dataset.pick;
      btn.classList.add("active");
      hint.textContent = `Click the map to set the ${state.activePick}`;
      hint.classList.add("show");
    });
  });

  map.on("click", async (e) => {
    if (!state.activePick) return;
    const kind = state.activePick;
    $("map-hint").textContent = "Finding the street address…";
    const name = await reverseGeocode(e.latlng);
    setPoint(kind, { lat: e.latlng.lat, lng: e.latlng.lng, name });
    document.querySelectorAll(".map-pick").forEach((x) => x.classList.remove("active"));
    state.activePick = null;
    $("map-hint").classList.remove("show");
    refreshWeather();
  });

  $("swap").addEventListener("click", () => {
    const a = { ...state.points.origin };
    const b = { ...state.points.destination };
    setPoint("origin", b);
    setPoint("destination", a);
    refreshWeather();
  });

  $("time-input").addEventListener("input", (e) => {
    $("time-label").textContent = fmtTime(Number(e.target.value));
    const s = solarPosition(departureDate(), IE.lat, IE.lng);
    $("sun-state").textContent =
      s.altitude > 2 ? `☀ ${s.altitude.toFixed(0)}° high` : "☾ Night";
    invalidateResults();
    refreshWeather();
  });

  $("priority-input").addEventListener("input", (e) => {
    state.priority = Number(e.target.value);
    $("priority-label").textContent = [
      "",
      "Mostly shorter",
      "Slight shade",
      "Balanced",
      "More shade",
      "Maximum shade"
    ][state.priority];
    reroute(); // instant: reuses the already-scored graph
  });

  $("tracking-button").addEventListener("click", () =>
    state.watchId === null ? startTracking() : stopTracking()
  );

  $("follow-location").addEventListener("click", () => {
    state.followLive = !state.followLive;
    $("follow-location").classList.toggle(
      "active",
      state.followLive && state.watchId !== null
    );
    if (state.followLive && state.liveMarker) {
      map.panTo(state.liveMarker.getLatLng());
    }
  });

  $("reset-view").addEventListener("click", () => map.fitBounds(radiusCircle.getBounds()));
  $("close-results").addEventListener("click", () => {
    $("result-sheet").hidden = true;
  });

  const dialog = $("about-dialog");
  $("about-button").addEventListener("click", () => dialog.showModal());
  $("close-about").addEventListener("click", () => dialog.close());

  /* ------------------------------------------------------------------ *
   * Initial render
   * ------------------------------------------------------------------ */

  const today = new Date();
  $("date-input").value = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
  $("date-input").addEventListener("change", () => {
    invalidateResults();
    $("time-input").dispatchEvent(new Event("input"));
  });

  if (IS_FILE_PROTOCOL) {
    const banner = $("protocol-warning");
    if (banner) banner.hidden = false;
  }

  // Drop street caches written by older builds; they were allowed to store
  // empty results, which would keep a bounding box broken forever.
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("sombra-streets:"))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* no localStorage — nothing to clean */
  }

  setPoint("origin", state.points.origin);
  setPoint("destination", state.points.destination);
  createAutocomplete("origin");
  createAutocomplete("destination");

  $("time-input").dispatchEvent(new Event("input"));
  clearError();
})();
