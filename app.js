// Parkeringskarta kring Årsta torg.
// Läser stadens föreskrifter (data/city/*.geojson), grupperar dem per
// gatusegment (EXTENT_NO) och färgar varje segment efter vad som gäller
// vid vald tidpunkt.

const ARSTA_TORG = [59.2985, 18.0485];
const STEP_MIN = 15;          // upplösning när vi letar efter nästa förbud
const WARN_HOURS = 24;        // orange om förbud börjar inom så här många timmar
const LOOKAHEAD_DAYS = 8;     // hur långt fram popupen letar efter nästa förbud

const COLORS = { red: '#d62828', orange: '#f08c00', blue: '#1c64d4', purple: '#8a3ffc' };
const WEEKDAYS = ['söndag', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

// ---------- Tid (alltid svensk tid, oavsett var telefonen tror att den är) ----------

const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm', hour12: false,
  year: 'numeric', month: 'numeric', day: 'numeric',
  weekday: 'long', hour: 'numeric', minute: 'numeric',
});

function stockholmParts(date) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const hour = Number(p.hour) % 24;
  return {
    month: Number(p.month), day: Number(p.day),
    weekday: p.weekday.toLowerCase(),
    hhmm: hour * 100 + Number(p.minute),
  };
}

function inSeason(rule, t) {
  if (rule.START_MONTH == null) return true;           // gäller hela året
  const md = t.month * 100 + t.day;
  const s = rule.START_MONTH * 100 + rule.START_DAY;
  const e = rule.END_MONTH * 100 + rule.END_DAY;
  return s <= e ? (md >= s && md <= e) : (md >= s || md <= e);   // t.ex. 1 nov–15 maj går över nyår
}

function serviceActive(rule, t) {
  return rule.START_WEEKDAY === t.weekday
    && inSeason(rule, t)
    && t.hhmm >= rule.START_TIME && t.hhmm < rule.END_TIME;
}

// Förberäknar tidpunkter framåt så att alla segment kan dela på dem.
function buildTimeline(start, days) {
  // Första punkten är exakt vald tid, sedan jämna kvartar (08:00, 08:15 ...),
  // så att "nästa förbud" landar på rätt klockslag.
  const stepMs = STEP_MIN * 60000;
  const end = start.getTime() + days * 86400000;
  const out = [{ date: start, parts: stockholmParts(start) }];
  for (let t = Math.floor(start.getTime() / stepMs) * stepMs + stepMs; t <= end; t += stepMs) {
    const d = new Date(t);
    out.push({ date: d, parts: stockholmParts(d) });
  }
  return out;
}

// ---------- Data ----------

async function loadLayer(name) {
  const res = await fetch(`data/city/${name}.geojson`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return (await res.json()).features;
}

function groupSegments(allowed, service, reservedDisabled, reservedMc) {
  const segs = new Map();
  const get = (f) => {
    const id = f.properties.EXTENT_NO;
    if (!segs.has(id)) {
      segs.set(id, {
        id, street: f.properties.STREET_NAME, geometry: f.geometry,
        vehicle: 'fordon', allowed: [], service: [], rate: f.properties.PARKING_RATE,
        meters: null, links: new Set(),
      });
    }
    const s = segs.get(id);
    if (f.properties.VF_METER) s.meters = f.properties.VF_METER;
    if (f.properties.RDT_URL) s.links.add(f.properties.RDT_URL);
    return s;
  };
  for (const f of allowed) {
    const s = get(f);
    s.allowed.push(f.properties);
    if (f.properties.VEHICLE && f.properties.VEHICLE !== 'fordon') s.vehicle = f.properties.VEHICLE;
  }
  for (const f of service) get(f).service.push(f.properties);
  for (const f of reservedDisabled) get(f).vehicle = 'rörelsehindrade';
  for (const f of reservedMc) get(f).vehicle = 'motorcykel';
  return [...segs.values()];
}

// ---------- Status ----------

function statusAt(seg, timeline) {
  if (seg.vehicle !== 'fordon') return { color: 'purple' };
  const now = timeline[0];
  const active = seg.service.find((r) => serviceActive(r, now.parts));
  if (active) {
    const end = timeline.find((x) => !seg.service.some((r) => serviceActive(r, x.parts)));
    return { color: 'red', until: end && end.date };
  }
  const next = timeline.find((x) => seg.service.some((r) => serviceActive(r, x.parts)));
  if (!next) return { color: 'blue', next: null };
  const hours = (next.date - now.date) / 3600000;
  return { color: hours <= WARN_HOURS ? 'orange' : 'blue', next: next.date };
}

// ---------- Text till popup ----------

const timeStr = (n) => `${String(Math.floor(n / 100)).padStart(2, '0')}:${String(n % 100).padStart(2, '0')}`;

function describeService(r) {
  const season = r.START_MONTH == null
    ? 'hela året'
    : `${r.START_DAY} ${MONTHS[r.START_MONTH - 1]}–${r.END_DAY} ${MONTHS[r.END_MONTH - 1]}`;
  return `${r.START_WEEKDAY} ${timeStr(r.START_TIME)}–${timeStr(r.END_TIME)} (${season})`;
}

function whenStr(date) {
  return date.toLocaleString('sv-SE', {
    timeZone: 'Europe/Stockholm', weekday: 'long', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

function popupHtml(seg, st) {
  let status;
  if (st.color === 'purple') status = `Reserverad för ${seg.vehicle}`;
  else if (st.color === 'red') status = `Förbjudet nu (servicetid)${st.until ? `, till ${whenStr(st.until)}` : ''}`;
  else if (st.next) status = `Tillåtet nu. Nästa förbud: ${whenStr(st.next)}`;
  else status = `Tillåtet nu. Inget förbud de närmaste ${LOOKAHEAD_DAYS} dagarna`;

  const uniqueService = [...new Set(seg.service.map(describeService))];
  const links = [...seg.links].map((u, i) => `<a href="${u}" target="_blank" rel="noopener">föreskrift ${i + 1}</a>`).join(' · ');

  return `<div class="pop">
    <h3>${seg.street}</h3>
    <span class="badge">Ej verifierad</span>
    <div class="status ${st.color}">${status}</div>
    ${uniqueService.length ? `<div><b>Servicetid (förbud):</b><ul>${uniqueService.map((s) => `<li>${s}</li>`).join('')}</ul></div>` : ''}
    ${seg.rate ? `<div class="small"><b>Avgift:</b> ${seg.rate}</div>` : ''}
    ${seg.meters ? `<div class="small">Längd: ${seg.meters} m</div>` : ''}
    <div class="small">${links}</div>
  </div>`;
}

// ---------- Karta ----------

const map = L.map('map', { zoomControl: false }).setView(ARSTA_TORG, 16);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  maxZoom: 20, subdomains: 'abcd',
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a> · Data: Stockholms stad',
}).addTo(map);

const segLayer = L.layerGroup().addTo(map);
let segments = [];
let chosenTime = null;   // null = följ klockan

function currentStart() {
  return chosenTime ? new Date(chosenTime) : new Date();
}

function render() {
  const start = currentStart();
  const shortTimeline = buildTimeline(start, WARN_HOURS / 24 + 0.1);
  segLayer.clearLayers();

  for (const seg of segments) {
    const st = statusAt(seg, shortTimeline);
    const coords = seg.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const style = {
      color: COLORS[st.color], weight: 6, opacity: 0.9, lineCap: 'round',
      dashArray: st.color === 'purple' ? '6 6' : null,
    };
    // Bred osynlig linje under, så att det går att träffa med fingret.
    const hit = L.polyline(coords, { color: '#000', opacity: 0, weight: 22 });
    const line = L.polyline(coords, style);
    const open = (e) => {
      const full = statusAt(seg, buildTimeline(currentStart(), LOOKAHEAD_DAYS));
      L.popup({ maxWidth: 300, autoPanPaddingTopLeft: popupPadding() }).setLatLng(e.latlng).setContent(popupHtml(seg, full)).openOn(map);
    };
    hit.on('click', open); line.on('click', open);
    segLayer.addLayer(hit); segLayer.addLayer(line);
  }
}

function popupPadding() {
  const panel = document.getElementById('panel');
  const r = panel.getBoundingClientRect();
  // Bredvid panelen på stor skärm, under den på mobil.
  return window.innerWidth >= 700 ? L.point(r.right + 10, 20) : L.point(10, r.bottom + 10);
}

// ---------- Panel ----------

const whenInput = document.getElementById('when');
function toLocalInput(d) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
whenInput.value = toLocalInput(new Date());
whenInput.addEventListener('change', () => {
  chosenTime = whenInput.value ? new Date(whenInput.value).getTime() : null;
  render();
});
document.getElementById('now').addEventListener('click', () => {
  chosenTime = null;
  whenInput.value = toLocalInput(new Date());
  render();
});
document.getElementById('toggle').addEventListener('click', (e) => {
  const p = document.getElementById('panel');
  p.classList.toggle('collapsed');
  e.target.textContent = p.classList.contains('collapsed') ? '+' : '–';
});
if (window.innerWidth < 600) document.getElementById('toggle').click();

// Uppdatera färgerna varje minut när vi följer klockan.
setInterval(() => {
  if (chosenTime === null) { whenInput.value = toLocalInput(new Date()); render(); }
}, 60000);

// ---------- Start ----------

(async () => {
  try {
    const [allowed, service, disabled, mc, meta] = await Promise.all([
      loadLayer('ptillaten'), loadLayer('servicedagar'),
      loadLayer('prorelsehindrad'), loadLayer('pmotorcykel'),
      fetch('data/city/meta.json').then((r) => r.json()).catch(() => null),
    ]);
    segments = groupSegments(allowed, service, disabled, mc);
    render();
    const all = L.featureGroup(segLayer.getLayers());
    if (all.getLayers().length) map.fitBounds(all.getBounds(), { padding: [20, 20] });
    if (meta && meta.fetched_at) {
      document.getElementById('fetched').textContent =
        `Stadens data hämtad ${new Date(meta.fetched_at).toLocaleDateString('sv-SE')}.`;
    }
  } catch (err) {
    document.getElementById('fetched').textContent = `Kunde inte läsa data: ${err.message}`;
    console.error(err);
  }
})();
