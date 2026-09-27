/**
 * MapMiner Crawler (JavaScript / Node version)
 * ---------------------------------------------
 * Same job as crawler.py, just in Node so it matches your usual stack.
 *
 * - Multiple Overpass mirrors, auto-fallback if one is down/rate-limited
 * - Retry with backoff
 * - Nominatim geocoding, falls back to Photon if Nominatim 403s/blocks us
 * - JSON-file cache (no native/sqlite deps -> works cleanly in Termux)
 * - Tiny Express API, same endpoints as the Python version:
 *     /api/geocode?q=...
 *     /api/leads?lat=...&lon=...&category=...
 *     /api/search?location=...&category=...
 *
 * Your HTML does NOT need to change — it just calls these same routes.
 *
 * Run it:
 *   npm install express
 *   node crawler.js
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------- Config ----------

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const PHOTON_URL = "https://photon.komoot.io/api"; // fallback geocoder

const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

const HEADERS = {
  "User-Agent": "MapMiner/1.0 (personal project, non-commercial testing)",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "http://127.0.0.1:5000",
};

const CACHE_FILE = path.join(__dirname, "mapminer_cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000; // doubles each retry

const PORT = 5000;

// ---------- Cache (single JSON file, zero setup) ----------

function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), "utf8");
}

function cacheKey(...parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

function cacheGet(key) {
  const cache = loadCache();
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) return null; // expired
  return entry.value;
}

function cacheSet(key, value) {
  const cache = loadCache();
  cache[key] = { value, createdAt: Date.now() };
  saveCache(cache);
}

// ---------- Helpers ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// fetch() has no built-in timeout; without this, a stalled network call
// (bad connection, blocked domain, etc.) can hang a request forever.
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Geocoding (Nominatim, falls back to Photon) ----------

async function geocode(locationText) {
  const key = cacheKey("geocode", locationText.toLowerCase().trim());
  const cached = cacheGet(key);
  if (cached) return { ...cached, source: "cache" };

  const nominatimUrl = `${NOMINATIM_URL}?format=json&q=${encodeURIComponent(locationText)}&limit=1`;

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(nominatimUrl, { headers: HEADERS }, 10000);
      if (res.status === 403) throw new Error("403 Forbidden from Nominatim");
      if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
      const data = await res.json();
      if (!data || data.length === 0) throw new Error(`No results found for '${locationText}'`);
      const result = {
        lat: parseFloat(data[0].lat),
        lon: parseFloat(data[0].lon),
        display_name: data[0].display_name || locationText,
      };
      cacheSet(key, result);
      return { ...result, source: "live", provider: "nominatim" };
    } catch (e) {
      lastError = e;
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }

  // Nominatim failed every attempt -> try Photon
  try {
    const photonUrl = `${PHOTON_URL}?q=${encodeURIComponent(locationText)}&limit=1`;
    const res = await fetchWithTimeout(photonUrl, {}, 10000);
    if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
    const data = await res.json();
    const features = data.features || [];
    if (features.length === 0) throw new Error(`No results found for '${locationText}'`);
    const [lon, lat] = features[0].geometry.coordinates;
    const props = features[0].properties || {};
    const displayName = [props.name, props.city, props.country].filter(Boolean).join(", ");
    const result = { lat, lon, display_name: displayName || locationText };
    cacheSet(key, result);
    return { ...result, source: "live", provider: "photon" };
  } catch (e2) {
    throw new Error(`Geocoding failed. Nominatim: ${lastError}. Photon fallback: ${e2}`);
  }
}

// ---------- Overpass query building ----------

// Map friendly category names -> OSM tag filters.
// Extend this as you find categories that matter to you.
const CATEGORY_TAGS = {
  // Food & drink
  restaurant: ['["amenity"="restaurant"]'],
  cafe: ['["amenity"="cafe"]'],
  bakery: ['["shop"="bakery"]'],
  bar: ['["amenity"="bar"]'],
  pub: ['["amenity"="pub"]'],
  fast_food: ['["amenity"="fast_food"]'],
  butcher: ['["shop"="butcher"]'],
  supermarket: ['["shop"="supermarket"]'],
  convenience_store: ['["shop"="convenience"]'],

  // Fitness & wellness
  gym: ['["leisure"="fitness_centre"]'],
  yoga_studio: ['["leisure"="fitness_centre"]["sport"="yoga"]', '["sport"="yoga"]'],
  spa: ['["shop"="massage"]', '["leisure"="spa"]'],
  salon: ['["shop"="hairdresser"]', '["shop"="beauty"]'],
  barber: ['["shop"="hairdresser"]'],
  nail_salon: ['["shop"="beauty"]["beauty"="nails"]', '["shop"="nails"]'],
  tattoo_studio: ['["shop"="tattoo"]'],

  // Health
  dentist: ['["amenity"="dentist"]'],
  veterinarian: ['["amenity"="veterinary"]'],
  pharmacy: ['["amenity"="pharmacy"]'],
  optician: ['["shop"="optician"]'],
  physiotherapist: ['["healthcare"="physiotherapist"]', '["amenity"="clinic"]["healthcare"="physiotherapist"]'],
  chiropractor: ['["healthcare"="chiropractor"]'],
  clinic: ['["amenity"="clinic"]'],

  // Professional services
  lawyer: ['["office"="lawyer"]'],
  accountant: ['["office"="accountant"]'],
  insurance_agent: ['["office"="insurance"]'],
  architect: ['["office"="architect"]'],
  notary: ['["office"="notary"]'],
  recruitment_agency: ['["office"="employment_agency"]'],
  marketing_agency: ['["office"="advertising_agency"]', '["office"="marketing"]'],
  it_support: ['["office"="it"]', '["shop"="computer"]'],
  coworking_space: ['["office"="coworking"]'],
  travel_agency: ['["shop"="travel_agency"]'],

  // Property & trades
  real_estate: ['["office"="estate_agent"]'],
  auto_repair: ['["shop"="car_repair"]'],
  car_dealer: ['["shop"="car"]'],
  tire_shop: ['["shop"="tyres"]'],
  car_wash: ['["amenity"="car_wash"]'],
  electrician: ['["craft"="electrician"]'],
  plumber: ['["craft"="plumber"]'],
  hvac: ['["craft"="hvac"]'],
  painter: ['["craft"="painter"]'],
  carpenter: ['["craft"="carpenter"]'],
  locksmith: ['["craft"="locksmith"]', '["shop"="locksmith"]'],
  roofer: ['["craft"="roofer"]'],
  landscaping: ['["craft"="gardener"]', '["shop"="garden_centre"]'],
  pest_control: ['["craft"="pest_control"]'],
  cleaning_service: ['["craft"="cleaning"]'],
  moving_company: ['["shop"="storage_rental"]', '["office"="moving_company"]'],
  storage_facility: ['["shop"="storage_rental"]'],

  // Retail
  hotel: ['["tourism"="hotel"]'],
  jeweler: ['["shop"="jewelry"]'],
  furniture_store: ['["shop"="furniture"]'],
  hardware_store: ['["shop"="hardware"]'],
  electronics_store: ['["shop"="electronics"]'],
  mobile_repair: ['["shop"="mobile_phone"]', '["craft"="electronics_repair"]'],
  bike_shop: ['["shop"="bicycle"]'],
  pet_store: ['["shop"="pet"]'],
  bookstore: ['["shop"="books"]'],
  toy_store: ['["shop"="toys"]'],
  florist: ['["shop"="florist"]'],
  laundry: ['["shop"="laundry"]', '["shop"="dry_cleaning"]'],
  pawn_shop: ['["shop"="pawnbroker"]'],
  funeral_home: ['["shop"="funeral_directors"]'],
  photographer: ['["craft"="photographer"]'],

  // Education & childcare
  driving_school: ['["amenity"="driving_school"]'],
  daycare: ['["amenity"="childcare"]'],
  tutor: ['["office"="educational_institution"]'],

  retail: ['["shop"="yes"]'],
};

function buildOverpassQuery(lat, lon, category, radiusM = 5000) {
  const tags = CATEGORY_TAGS[category.toLowerCase().trim()] || [
    '["shop"]',
    '["office"]',
    '["amenity"~"restaurant|cafe|bar|dentist|clinic|bank"]',
  ];

  const clauses = [];
  for (const tag of tags) {
    clauses.push(`node${tag}(around:${radiusM},${lat},${lon});`);
    clauses.push(`way${tag}(around:${radiusM},${lat},${lon});`);
  }

  return `
    [out:json][timeout:25];
    (
      ${clauses.join(" ")}
    );
    out center tags;
  `;
}

async function fetchOverpassLeads(lat, lon, category, radiusM = 5000) {
  const key = cacheKey("leads", lat.toFixed(4), lon.toFixed(4), category.toLowerCase(), radiusM);
  const cached = cacheGet(key);
  if (cached) return { leads: cached, source: "cache" };

  const query = buildOverpassQuery(lat, lon, category, radiusM);

  let lastError = null;
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetchWithTimeout(
          mirror,
          {
            method: "POST",
            headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
            body: `data=${encodeURIComponent(query)}`,
          },
          15000
        );
        if (res.status === 429) throw new Error("Rate limited (429)");
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
        const data = await res.json();
        const leads = parseOverpassElements(data.elements || [], category);
        cacheSet(key, leads);
        return { leads, source: "live", mirror };
      } catch (e) {
        lastError = e;
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
    // this mirror failed all retries -> try next mirror
  }

  throw new Error(`All Overpass mirrors failed: ${lastError}`);
}

function parseOverpassElements(elements, category) {
  return elements.map((el, idx) => {
    const tags = el.tags || {};
    const name = tags.name || tags.brand || `${category[0].toUpperCase()}${category.slice(1)} #${idx + 1}`;

    let lat, lon;
    if (el.type === "node") {
      lat = el.lat;
      lon = el.lon;
    } else {
      const center = el.center || {};
      lat = center.lat;
      lon = center.lon;
    }

    const addressParts = [tags["addr:housenumber"], tags["addr:street"], tags["addr:city"]].filter(Boolean);
    const address = addressParts.length ? addressParts.join(" ") : null;

    return {
      name,
      lat,
      lon,
      phone: tags.phone || tags["contact:phone"] || null,
      website: tags.website || tags["contact:website"] || null,
      email: tags.email || tags["contact:email"] || null,
      address,
      category,
      osm_id: el.id,
      osm_type: el.type,
    };
  });
}

// ---------- Express API (same routes as the Python version) ----------

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "mapminer-crawler", version: "1.1.0", time: Date.now() });
});

app.get("/api/geocode", async (req, res) => {
  const location = (req.query.q || "").trim();
  if (!location) return res.status(400).json({ error: "Missing 'q' parameter" });
  try {
    const result = await geocode(location);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/leads", async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    return res.status(400).json({ error: "Missing/invalid 'lat' or 'lon' parameter" });
  }
  const category = (req.query.category || "retail").trim();
  const radiusM = parseInt(req.query.radius || "5000", 10);

  try {
    const { leads, source } = await fetchOverpassLeads(lat, lon, category, radiusM);
    res.json({ count: leads.length, leads, source });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/search", async (req, res) => {
  const location = (req.query.location || "").trim();
  const category = (req.query.category || "retail").trim();
  const radiusM = parseInt(req.query.radius || "5000", 10);

  if (!location) return res.status(400).json({ error: "Missing 'location' parameter" });

  try {
    const geo = await geocode(location);
    const { leads, source } = await fetchOverpassLeads(geo.lat, geo.lon, category, radiusM);
    res.json({ location: geo, count: leads.length, leads, source });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MapMiner crawler running at http://127.0.0.1:${PORT}`);
  console.log(`Health check: http://127.0.0.1:${PORT}/api/health`);
  console.log(`Try: http://127.0.0.1:${PORT}/api/search?location=Lagos&category=restaurant`);
});
