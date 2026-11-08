/* Sentiers Vélo — itinéraires vélo qui évitent les routes.
 * Services utilisés (gratuits, sans clé) :
 *  - BRouter (brouter.de)        : calcul d'itinéraire vélo
 *  - Photon (photon.komoot.io)   : recherche d'adresses
 *  - Overpass API                : points d'intérêt OpenStreetMap
 *  - Tuiles CyclOSM / OSM / OpenTopoMap
 */
'use strict';

const BROUTER = 'https://brouter.de/brouter';
const PHOTON = 'https://photon.komoot.io';
const GEOPF = 'https://data.geopf.fr/geocodage'; // Géoplateforme IGN (France) : rapide et fiable
const WIKI = 'https://fr.wikipedia.org/w/api.php';
// Plusieurs serveurs Overpass : souvent saturés, on les essaie en cascade
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** fetch avec délai maximum (et annulation optionnelle). */
function fetchT(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  const outer = opts.signal;
  if (outer) { if (outer.aborted) ctrl.abort(); else outer.addEventListener('abort', () => ctrl.abort(), { once: true }); }
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}
const isCancel = (e) => e?.name === 'AbortError' && currentOp?.signal.aborted;

/**
 * Requête « en cascade » : lance le 1er serveur, puis le suivant si le précédent échoue
 * ou n'a pas répondu après `stagger` ms. Le premier qui répond gagne, les autres sont annulés.
 */
function hedged(urls, makeReq, { stagger = 6000, total = 40000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let next = 0, failed = 0, done = false, staggerT, lastErr;
    const ctrls = [];
    const finish = (v, e) => {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(staggerT); ctrls.forEach((c) => c.abort());
      e ? reject(e) : resolve(v);
    };
    const timer = setTimeout(() => finish(null, lastErr || new Error('délai dépassé')), total);
    signal?.addEventListener('abort', () => finish(null, new DOMException('annulé', 'AbortError')), { once: true });
    const launch = () => {
      if (done || next >= urls.length) return;
      const c = new AbortController(); ctrls.push(c);
      makeReq(urls[next++], c.signal).then((v) => finish(v), (e) => {
        lastErr = e; failed++;
        if (failed >= urls.length) finish(null, e); else launch();
      });
      clearTimeout(staggerT); staggerT = setTimeout(launch, stagger);
    };
    launch();
  });
}

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
/* Mémoire de la session en cours : effacée quand on ferme l'application,
   mais conservée si le téléphone recharge la page en arrière-plan (pendant une sortie). */
const tmp = {
  get(k, d) { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

/* ------------------------------------------------------------------ */
/* Catégories                                                          */
/* ------------------------------------------------------------------ */
const MY_CATS = {
  fav: ['⭐', 'Coup de cœur'], view: ['🔭', 'Point de vue'], nature: ['🌲', 'Nature'],
  heritage: ['🏰', 'Patrimoine'], pause: ['🧺', 'Pause / pique-nique'], water: ['🚰', 'Eau'],
  food: ['☕', 'Café / resto'], photo: ['📷', 'Photo'], warn: ['⚠️', 'Attention'], other: ['📍', 'Autre'],
};

const SUGG_CATS = {
  shared: { emoji: '👥', label: 'Partagé', hidden: true, q: [], m: () => false },
  wiki: { emoji: '📖', label: 'Lieux Wikipédia', on: true, wiki: true, q: [], m: () => false },
  view: { emoji: '🔭', label: 'Points de vue', on: true, q: ['node["tourism"="viewpoint"]'], m: (t) => t.tourism === 'viewpoint' },
  nature: { emoji: '🌲', label: 'Nature', on: true,
    q: ['node["natural"~"^(peak|waterfall|cave_entrance|spring|rock|tree)$"]["name"]', 'nwr["waterway"="waterfall"]', 'nwr["leisure"="nature_reserve"]["name"]'],
    m: (t) => !!(t.natural || t.waterway === 'waterfall' || t.leisure === 'nature_reserve') },
  heritage: { emoji: '🏰', label: 'Patrimoine', on: true,
    q: ['nwr["historic"~"^(castle|ruins|monument|archaeological_site|manor|fort|tower|city_gate|monastery|church|chapel|mill|bridge|aqueduct)$"]', 'nwr["tourism"~"^(attraction|museum|artwork)$"]["name"]'],
    m: (t) => !!(t.historic || /attraction|museum|artwork/.test(t.tourism || '')) },
  picnic: { emoji: '🧺', label: 'Pique-nique', on: true, q: ['nwr["tourism"="picnic_site"]', 'node["leisure"="picnic_table"]'],
    m: (t) => t.tourism === 'picnic_site' || t.leisure === 'picnic_table' },
  water: { emoji: '🚰', label: 'Eau potable', on: true, q: ['node["amenity"="drinking_water"]', 'node["amenity"="water_point"]'],
    m: (t) => /drinking_water|water_point/.test(t.amenity || '') },
  bike: { emoji: '🔧', label: 'Réparation vélo', on: false, q: ['node["amenity"="bicycle_repair_station"]', 'nwr["shop"="bicycle"]'],
    m: (t) => t.amenity === 'bicycle_repair_station' || t.shop === 'bicycle' },
  food: { emoji: '☕', label: 'Cafés & restos', on: false, q: ['nwr["amenity"~"^(cafe|restaurant|pub|bar|ice_cream)$"]'],
    m: (t) => /cafe|restaurant|pub|bar|ice_cream/.test(t.amenity || '') },
  sleep: { emoji: '⛺', label: 'Hébergement', on: false, q: ['nwr["tourism"~"^(camp_site|guest_house|hostel|alpine_hut|wilderness_hut|chalet)$"]'],
    m: (t) => /camp_site|guest_house|hostel|alpine_hut|wilderness_hut|chalet/.test(t.tourism || '') },
};

const KIND_FR = {
  viewpoint: 'Point de vue', peak: 'Sommet', waterfall: 'Cascade', cave_entrance: 'Grotte', spring: 'Source', rock: 'Rocher', tree: 'Arbre remarquable',
  nature_reserve: 'Réserve naturelle', castle: 'Château', ruins: 'Ruines', monument: 'Monument', archaeological_site: 'Site archéologique', manor: 'Manoir',
  fort: 'Fort', tower: 'Tour', city_gate: 'Porte de ville', monastery: 'Abbaye / monastère', church: 'Église', chapel: 'Chapelle', mill: 'Moulin',
  bridge: 'Pont historique', aqueduct: 'Aqueduc', attraction: 'Attraction', museum: 'Musée', artwork: "Œuvre d'art", picnic_site: 'Aire de pique-nique',
  picnic_table: 'Table de pique-nique', drinking_water: 'Eau potable', water_point: "Point d'eau", bicycle_repair_station: 'Station de réparation vélo',
  bicycle: 'Magasin de vélos', cafe: 'Café', restaurant: 'Restaurant', pub: 'Pub', bar: 'Bar', ice_cream: 'Glacier', camp_site: 'Camping',
  guest_house: "Chambre d'hôtes", hostel: 'Auberge', alpine_hut: 'Refuge', wilderness_hut: 'Abri', chalet: 'Gîte',
};

/* Deux réglages indépendants :
   - AVOID : à quel point on évite les routes (pénalité sur les routes) ;
   - OPTIM : ce qu'on optimise. w = poids des préférences (1 = on suit pleinement le profil,
     plus w est petit, plus on se rapproche de la distance la plus courte). */
const AVOID = { 1: 'Faible', 2: 'Moyen', 3: 'Fort' };
const OPTIM = {
  balade: { w: 1, label: '🌲 Balade', hint: 'Privilégie les chemins et pistes cyclables, quitte à faire quelques détours.' },
  rapide: { w: 0.6, smooth: true, hills: true, label: '⚡ Plus rapide', hint: 'Privilégie les revêtements roulants et limite les côtes pour gagner du temps.' },
  court: { w: 0.3, label: '📏 Plus court', hint: 'Cherche la distance la plus courte, tout en évitant les routes selon le niveau choisi.' },
};
const avoidHint = { 1: 'Évite surtout les grands axes.', 2: 'Évite aussi les routes secondaires et le bruit.', 3: 'Évite toutes les routes autant que possible, même les petites, et les villes.' };
const prioLabel = () => `${OPTIM[settings.optim].label} · routes : ${AVOID[settings.avoid].toLowerCase()}`;
const SPEED = { gravel: 16, vtt: 13, ville: 14 }; // km/h sur le plat, rythme balade

/* ------------------------------------------------------------------ */
/* État                                                                */
/* ------------------------------------------------------------------ */
// Préférences durables (réglages, position de la carte) ; le trajet en cours ne vit que le temps de la session.
const oldSession = store.get('session', null); // ancienne version : tout était gardé
const prefs = oldSession ? { settings: oldSession.settings, view: oldSession.view } : store.get('prefs', {});
try { localStorage.removeItem('session'); localStorage.removeItem('lastRoute'); } catch { /* */ }
const saved = { ...tmp.get('trip', {}), settings: prefs.settings, view: prefs.view };
const state = {
  mode: saved.mode || 'ab',
  start: saved.start || null,
  end: saved.end || null,
  vias: saved.vias || [],
  route: tmp.get('route', null),
  loopSeed: Math.random() * 360,
  myPois: store.get('myPois', []),
  suggested: [],
  follow: false,
};

/* ------------------------------------------------------------------ */
/* Carte                                                               */
/* ------------------------------------------------------------------ */
const map = L.map('map', { zoomControl: false, attributionControl: true })
  .setView(saved.view?.c || [46.6, 2.4], saved.view?.z || 6);

const IGN_TILE = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png';
const ignLayer = L.tileLayer(IGN_TILE, { maxZoom: 19, maxNativeZoom: 18, minZoom: 2, attribution: '© <a href="https://www.ign.fr">IGN</a> – Géoplateforme' });
const baseLayers = {
  'CyclOSM (vélo)': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    maxZoom: 20, subdomains: 'abc', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · CyclOSM' }),
  'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }),
  'Topographique': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc', attribution: '© OpenStreetMap · © OpenTopoMap (CC-BY-SA)' }),
  'Plan IGN (France, hors ligne)': ignLayer,
};
const savedLayer = store.get('layer', 'CyclOSM (vélo)');
(baseLayers[savedLayer] || baseLayers['CyclOSM (vélo)']).addTo(map);
L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: false, position: 'topright' }).addTo(map);
map.on('baselayerchange', (e) => store.set('layer', e.name));
map.on('moveend', () => saveSession());

map.attributionControl.setPrefix('Powered by <b>F.CHAZE</b> · <a href="https://leafletjs.com">Leaflet</a>');
const routeLayer = L.layerGroup().addTo(map);
const pointLayer = L.layerGroup().addTo(map);
const myPoiLayer = L.layerGroup().addTo(map);
const suggLayer = L.layerGroup().addTo(map);
let hoverMarker = null;

const pin = (txt, cls) => L.divIcon({ className: 'pin ' + cls, html: `<span><b>${txt}</b></span>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });

/* ------------------------------------------------------------------ */
/* Utilitaires géo                                                     */
/* ------------------------------------------------------------------ */
const R_EARTH = 6371e3, rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
function hav(a, b) { // a, b : {lat, lng}
  const dφ = rad(b.lat - a.lat), dλ = rad(b.lng - a.lng);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dλ / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}
const cll = (c) => ({ lat: c[1], lng: c[0] }); // coordonnée [lon, lat, ele] -> {lat, lng}
function destination(p, bearing, dist) {
  const δ = dist / R_EARTH, θ = rad(bearing), φ1 = rad(p.lat), λ1 = rad(p.lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lng: ((deg(λ2) + 540) % 360) - 180 };
}
const fmtKm = (m) => (m >= 10000 ? (m / 1000).toFixed(0) : (m / 1000).toFixed(1)).replace('.', ',') + ' km';
const fmtDur = (h) => { const m = Math.round(h * 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };

/* ------------------------------------------------------------------ */
/* Interface : toasts, panneau, onglets                                */
/* ------------------------------------------------------------------ */
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
/* Opération longue en cours (calcul, recherche de POI) : annulable par l'utilisateur */
let currentOp = null;
function busy(on, text = 'Calcul de l’itinéraire…') { $('#busy').hidden = !on; $('#busyText').textContent = text; }
function startOp(text) { currentOp?.abort(); currentOp = new AbortController(); busy(true, text); return currentOp.signal; }
function endOp(signal) { if (currentOp?.signal === signal) { currentOp = null; busy(false); } }
$('#btnCancel').addEventListener('click', () => { currentOp?.abort(); currentOp = null; busy(false); toast('Annulé'); });

const sheet = $('#sheet');
const isDesktop = () => matchMedia('(min-width: 820px)').matches;

/* Panneau du bas : 3 positions (réduit / moitié / plein écran), à faire glisser au doigt */
function snapHeights() {
  const H = innerHeight;
  const head = $('#sheetHead').offsetHeight, foot = $('#sheetFoot').hidden ? 0 : $('#sheetFoot').offsetHeight;
  return { peek: head + foot, half: Math.round(Math.max(H * 0.52, head + foot + 200)), full: H - 64 };
}
function setSnap(name) {
  sheet.dataset.snap = name;
  if (isDesktop()) { sheet.style.height = ''; return; }
  sheet.style.transition = '';
  sheet.style.height = snapHeights()[name] + 'px';
  setTimeout(() => { map.invalidateSize(); if (state.route && name !== 'peek') drawElevation(state.route); }, 300);
}
(() => {
  const head = $('#sheetHead');
  let drag = null, justDragged = false;
  head.addEventListener('pointerdown', (e) => {
    if (isDesktop()) return;
    drag = { y: e.clientY, h: sheet.getBoundingClientRect().height, moved: false, t: Date.now() };
  });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (!drag.moved && Math.abs(dy) < 8) return;
    drag.moved = true;
    const sh = snapHeights();
    sheet.style.transition = 'none';
    sheet.style.height = Math.min(sh.full, Math.max(sh.peek, drag.h + dy)) + 'px';
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) {
      if (e.target.closest?.('.grab, .mini')) setSnap({ peek: 'half', half: 'full', full: 'peek' }[sheet.dataset.snap] || 'half');
      return;
    }
    justDragged = true; setTimeout(() => { justDragged = false; }, 50);
    const sh = snapHeights(), h = sheet.getBoundingClientRect().height;
    const v = (d.y - e.clientY) / Math.max(1, Date.now() - d.t); // vitesse (px/ms), > 0 vers le haut
    let target;
    if (Math.abs(v) > 0.6) target = v > 0 ? (h > sh.half ? 'full' : 'half') : (h < sh.half ? 'peek' : 'half');
    else target = ['peek', 'half', 'full'].reduce((a, b) => (Math.abs(sh[b] - h) < Math.abs(sh[a] - h) ? b : a));
    setSnap(target);
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
  head.addEventListener('click', (e) => { if (justDragged) { e.stopPropagation(); e.preventDefault(); } }, true);
  addEventListener('resize', () => setSnap(sheet.dataset.snap || 'half'));
  // Clavier : on agrandit le panneau pour que la saisie reste visible
  ['#inStart', '#inEnd'].forEach((sel) => $(sel).addEventListener('focus', () => { if (!isDesktop()) setSnap('full'); }));
})();
function mapPadding() {
  return isDesktop() ? { paddingTopLeft: [410, 30], paddingBottomRight: [30, 30] }
    : { paddingTopLeft: [30, 70], paddingBottomRight: [30, Math.min(innerHeight * 0.6, snapHeights()[sheet.dataset.snap || 'half'] || 300) + 20] };
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + name; });
  $('#sheetFoot').hidden = name !== 'route';
  if (sheet.dataset.snap === 'peek') setSnap('half'); else setSnap(sheet.dataset.snap || 'half');
  if (name === 'route' && state.route) requestAnimationFrame(() => drawElevation(state.route));
  if (name === 'saved') renderSaved();
}

/* ------------------------------------------------------------------ */
/* Réglages                                                            */
/* ------------------------------------------------------------------ */
const settings = Object.assign({ avoid: 2, optim: 'balade', bike: 'gravel', hills: 'any', forest: false, loopKm: 30, loopDir: 'auto' }, saved.settings || {});
/* Compatibilité avec les anciens réglages (version « priorité » : nature / équilibré / rapide / court) */
function normalizeSettings(st) {
  const old = { nature: [3, 'balade'], equilibre: [2, 'balade'], rapide: [1, 'rapide'], court: [1, 'court'] }[st.prio];
  if (old && !st.optim) [st.avoid, st.optim] = old;
  delete st.prio;
  if (!AVOID[st.avoid]) st.avoid = 2;
  if (!OPTIM[st.optim]) st.optim = 'balade';
}
normalizeSettings(settings);

/** Recopie les réglages dans l'interface (après chargement d'un parcours, d'un lien partagé…). */
function applySettingsToUI() {
  normalizeSettings(settings);
  document.querySelectorAll('#avoidSeg button').forEach((b) => b.classList.toggle('active', +b.dataset.avoid === settings.avoid));
  document.querySelectorAll('#optimSeg button').forEach((b) => b.classList.toggle('active', b.dataset.optim === settings.optim));
  $('#bike').value = settings.bike; $('#hills').value = settings.hills; $('#forest').checked = !!settings.forest;
  $('#loopKm').value = settings.loopKm; $('#loopDir').value = settings.loopDir;
  readSettings();
}
function readSettings() {
  settings.bike = $('#bike').value; settings.hills = $('#hills').value;
  settings.forest = $('#forest').checked; settings.loopKm = +$('#loopKm').value; settings.loopDir = $('#loopDir').value;
  $('#loopKmOut').textContent = settings.loopKm + ' km';
  $('#prioHint').textContent = `${avoidHint[settings.avoid]} ${OPTIM[settings.optim].hint}`;
  $('#moreSummary').textContent = [$('#bike').selectedOptions[0].text, settings.hills === 'avoid' && 'sans côtes', settings.forest && 'forêts'].filter(Boolean).join(' · ');
}
document.querySelectorAll('#avoidSeg button').forEach((b) => b.addEventListener('click', () => {
  if (settings.avoid === +b.dataset.avoid) return;
  settings.avoid = +b.dataset.avoid; applySettingsToUI(); saveSession(); markDirty();
}));
document.querySelectorAll('#optimSeg button').forEach((b) => b.addEventListener('click', () => {
  if (settings.optim === b.dataset.optim) return;
  settings.optim = b.dataset.optim; applySettingsToUI(); saveSession(); markDirty();
}));
['#bike', '#hills', '#forest', '#loopKm', '#loopDir'].forEach((s) => $(s).addEventListener('change', () => {
  readSettings(); saveSession(); markDirty();
}));
$('#loopKm').addEventListener('input', readSettings);

/* Le tracé n'est (re)calculé que sur demande : on signale qu'il n'est plus à jour */
function markDirty() {
  if (state.route) {
    state.dirty = true;
    $('#dirtyNote').hidden = false; $('#result').classList.add('stale');
    routeLayer.eachLayer((l) => l.setStyle?.({ opacity: 0.35 }));
  }
  updateRouteBtn();
}
function updateRouteBtn() {
  const again = state.route && state.dirty;
  $('#btnRoute').textContent = state.mode === 'loop'
    ? (again ? 'Recalculer la boucle' : 'Créer la boucle')
    : (again ? "Recalculer l'itinéraire" : "Calculer l'itinéraire");
  $('#btnRoute').classList.toggle('pulse', !!canRoute() && (!state.route || !!state.dirty));
  // Itinéraire à jour : le bouton principal devient « Démarrer le guidage »
  const ready = !!state.route && !state.dirty;
  $('#btnFootNav').hidden = !ready; $('#btnRoute').hidden = ready;
}

function saveSession() {
  const c = map.getCenter();
  store.set('prefs', { settings, view: { c: [c.lat, c.lng], z: map.getZoom() } });
  tmp.set('trip', { mode: state.mode, start: state.start, end: state.end, vias: state.vias });
}

/* Mode A→B / Boucle */
document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#modeSeg button').forEach((x) => x.classList.toggle('active', x.dataset.mode === mode));
  $('#fieldEnd').hidden = mode !== 'ab';
  $('#fieldLoop').hidden = mode !== 'loop';
  $('#btnOtherLoop').hidden = true;
  renderPoints(); saveSession();
  if (state.route) markDirty(); else updateRouteBtn();
}

/* ------------------------------------------------------------------ */
/* Recherche d'adresse : Géoplateforme (IGN) + Photon en parallèle      */
/* ------------------------------------------------------------------ */
const first = (v) => (Array.isArray(v) ? v[0] : v);
function photonLabel(p) {
  const name = p.name || [p.housenumber, p.street].filter(Boolean).join(' ');
  const parts = [name, p.city || p.town || p.village || p.locality, p.county || p.state, p.country];
  return [...new Set(parts.filter(Boolean))].slice(0, 3).join(', ');
}
function geopfLabel(p) {
  if (p._type === 'poi') return [...new Set([first(p.name) || p.toponym, first(p.city)].filter(Boolean))].join(', ');
  return p.label || first(p.name);
}
const parseCoords = (q) => {
  const m = /^\s*(-?\d{1,2}(?:[.,]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*$/.exec(q);
  if (!m) return null;
  const lat = +m[1].replace(',', '.'), lng = +m[2].replace(',', '.');
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng, label: `${lat}, ${lng}` } : null;
};

/** Chaque fournisseur renvoie [{lat, lng, label}] ; onPartial est appelé dès qu'un fournisseur répond. */
async function geocode(q, signal, onPartial) {
  const c = map.getCenter();
  const ll = `lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`;
  const enc = encodeURIComponent(q);
  const providers = [
    fetchT(`${GEOPF}/search?q=${enc}&limit=5&index=address,poi&${ll}`, { signal }, 7000)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('geopf ' + r.status))))
      .then((j) => j.features.map((f) => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: geopfLabel(f.properties) }))),
    fetchT(`${PHOTON}/api/?q=${enc}&limit=5&lang=fr&${ll}`, { signal }, 7000)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('photon ' + r.status))))
      .then((j) => j.features.map((f) => ({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], label: photonLabel(f.properties) }))),
  ];
  const lists = [[], []];
  const merge = () => {
    // Géoplateforme d'abord (meilleure en France), puis Photon (monde entier), sans doublons proches
    const out = [];
    for (const it of [...lists[0].slice(0, 4), ...lists[1], ...lists[0].slice(4)]) {
      if (!it.label || out.some((o) => o.label === it.label || hav(o, it) < 150)) continue;
      out.push(it);
      if (out.length >= 6) break;
    }
    return out;
  };
  const res = await Promise.allSettled(providers.map((p, i) => p.then((v) => { lists[i] = v; onPartial?.(merge()); })));
  if (res.every((r) => r.status === 'rejected')) throw res[0].reason;
  return merge();
}

function setupSearch(input, list, kind) {
  let timer, ctrl, items = [], itemsFor = '';
  const pick = (it) => { ctrl?.abort(); ctrl = null; clearTimeout(timer); items = []; list.innerHTML = ''; input.blur(); setPoint(kind, it, it.label); };
  const render = (arr, emptyMsg) => {
    items = arr; itemsFor = input.value.trim(); list.innerHTML = '';
    arr.forEach((it) => {
      const li = document.createElement('li');
      li.textContent = it.label;
      li.addEventListener('pointerdown', (e) => e.preventDefault()); // garde le focus (évite la fermeture)
      li.addEventListener('click', () => pick(it));
      list.append(li);
    });
    if (!arr.length && emptyMsg) list.innerHTML = `<li class="muted">${emptyMsg}</li>`;
  };
  const run = async (immediate) => {
    const q = input.value.trim();
    ctrl?.abort();
    if (q.length < 3) { list.innerHTML = ''; return; }
    const coords = parseCoords(q);
    if (coords) { render([coords]); if (immediate) pick(coords); return; }
    ctrl = new AbortController();
    const mine = ctrl;
    render([], 'Recherche…');
    try {
      const arr = await geocode(q, mine.signal, (partial) => { if (ctrl === mine && !mine.signal.aborted && partial.length) render(partial); });
      if (ctrl !== mine || mine.signal.aborted) return;
      render(arr, 'Aucun résultat. Essayez « ville » ou « rue, ville ».');
      if (immediate && arr[0]) pick(arr[0]);
    } catch (e) {
      if (ctrl !== mine || (e.name === 'AbortError' && mine.signal.aborted)) return;
      render([], 'Recherche indisponible pour le moment. Réessayez, ou touchez la carte.');
    }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(false), 450); });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); clearTimeout(timer);
    if (items[0] && itemsFor === input.value.trim()) pick(items[0]); else run(true);
  });
  input.addEventListener('blur', () => setTimeout(() => { list.innerHTML = ''; }, 200));
}
setupSearch($('#inStart'), $('#sugStart'), 'start');
setupSearch($('#inEnd'), $('#sugEnd'), 'end');

async function reverseLabel(p) {
  try {
    const r = await fetchT(`${GEOPF}/reverse?lat=${p.lat}&lon=${p.lng}&limit=1`, {}, 5000);
    const j = await r.json();
    const f = j.features?.[0]; // hors de France, la Géoplateforme renvoie l'adresse française la plus proche : on l'ignore
    if (f && hav(p, { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }) < 1500) return geopfLabel(f.properties);
  } catch { /* on essaie Photon */ }
  try {
    const r = await fetchT(`${PHOTON}/reverse?lat=${p.lat}&lon=${p.lng}&lang=fr`, {}, 5000);
    const j = await r.json();
    if (j.features?.[0]) return photonLabel(j.features[0].properties);
  } catch { /* hors ligne */ }
  return `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;
}

/* ------------------------------------------------------------------ */
/* Départ / arrivée / étapes                                           */
/* ------------------------------------------------------------------ */
function canRoute() { return state.start && (state.mode === 'loop' || state.end); }

function setPoint(kind, ll, label) {
  const p = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), label: label || 'Point sur la carte' };
  if (kind === 'via') insertVia(p); else state[kind] = p;
  if (!label) reverseLabel(p).then((l) => { p.label = l; renderPoints(); saveSession(); });
  renderPoints(); saveSession(); markDirty();
  if (canRoute() && (!state.route || kind === 'via')) toast(state.mode === 'loop' ? 'Prêt : choisissez la distance puis « Créer la boucle »' : 'Prêt : appuyez sur « Calculer l’itinéraire »');
}

/** Insère l'étape à l'endroit qui allonge le moins le trajet. */
function insertVia(p) {
  const last = state.mode === 'loop' ? state.start : state.end;
  const chain = [state.start, ...state.vias, last];
  if (!state.start || !last) { state.vias.push(p); return; }
  let best = 0, bestCost = Infinity;
  for (let i = 0; i < chain.length - 1; i++) {
    const cost = hav(chain[i], p) + hav(p, chain[i + 1]) - hav(chain[i], chain[i + 1]);
    if (cost < bestCost) { bestCost = cost; best = i; }
  }
  state.vias.splice(best, 0, p);
}

function renderPoints() {
  pointLayer.clearLayers();
  const mk = (p, txt, cls, onMove) => {
    const m = L.marker([p.lat, p.lng], { icon: pin(txt, cls), draggable: true, zIndexOffset: 500 }).addTo(pointLayer);
    m.on('dragend', () => { const ll = m.getLatLng(); onMove(ll); });
    m.bindTooltip(esc(p.label));
    return m;
  };
  const moved = (obj) => (ll) => {
    obj.lat = +ll.lat.toFixed(6); obj.lng = +ll.lng.toFixed(6); obj.label = 'Point sur la carte';
    reverseLabel(obj).then((l) => { obj.label = l; renderPoints(); saveSession(); });
    renderPoints(); saveSession(); markDirty();
  };
  if (state.start) mk(state.start, 'A', 'start', moved(state.start));
  if (state.end && state.mode === 'ab') mk(state.end, 'B', 'end', moved(state.end));
  state.vias.forEach((v, i) => mk(v, i + 1, 'via', moved(v)));

  $('#inStart').value = state.start?.label || '';
  $('#inEnd').value = state.end?.label || '';
  const ol = $('#viaList'); ol.innerHTML = '';
  $('#viaBox').hidden = !state.vias.length;
  state.vias.forEach((v, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="pin via" style="position:relative"><span style="width:22px;height:22px"><b style="font-size:11px">${i + 1}</b></span></span>
      <span class="grow">${esc(v.label)}</span><button aria-label="Retirer">✕</button>`;
    li.querySelector('.grow').addEventListener('click', () => map.setView([v.lat, v.lng], Math.max(map.getZoom(), 14)));
    li.querySelector('button').addEventListener('click', () => {
      state.vias.splice(i, 1); renderPoints(); saveSession(); markDirty();
    });
    ol.append(li);
  });
}

$('#btnSwap').addEventListener('click', () => {
  [state.start, state.end] = [state.end, state.start]; state.vias.reverse();
  renderPoints(); saveSession(); markDirty();
});
$('#btnClear').addEventListener('click', () => {
  state.start = state.end = null; state.vias = []; state.route = null;
  tmp.set('route', null); routeLayer.clearLayers(); $('#result').hidden = true; $('#btnOtherLoop').hidden = true;
  state.dirty = false; showPlan(true);
  renderPoints(); saveSession(); updateRouteBtn();
});

/* Clic sur la carte : menu contextuel */
map.on('click', (e) => {
  const ll = e.latlng;
  const div = document.createElement('div'); div.className = 'ctx';
  const items = [['🟢 Départ ici', () => setPoint('start', ll)]];
  if (state.mode === 'ab') items.push(['🏁 Arrivée ici', () => setPoint('end', ll)]);
  items.push(['➕ Passer par ici (étape)', () => setPoint('via', ll)]);
  items.push(["📍 Nouveau point d'intérêt", () => openPoiDialog({ lat: ll.lat, lng: ll.lng })]);
  if (typeof openReport === 'function') items.push(['⚠️ Signaler un problème ici', () => openReport(ll)]);
  items.forEach(([t, fn]) => {
    const b = document.createElement('button'); b.textContent = t;
    b.addEventListener('click', () => { map.closePopup(); fn(); });
    div.append(b);
  });
  const title = document.createElement('h4'); title.textContent = 'Que faire ici ?'; div.prepend(title);
  L.popup({ closeButton: true, className: 'ctx-popup' }).setLatLng(ll).setContent(div).openOn(map);
});

/* ------------------------------------------------------------------ */
/* Géolocalisation                                                     */
/* ------------------------------------------------------------------ */
let meMarker = null, meCircle = null, watchId = null, wakeLock = null;
function getPosition() {
  return new Promise((ok, ko) => {
    if (!navigator.geolocation) return ko(new Error('Géolocalisation non disponible'));
    navigator.geolocation.getCurrentPosition((p) => ok(p), ko, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}
function showMe(pos) {
  const ll = [pos.coords.latitude, pos.coords.longitude];
  if (!meMarker) {
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
    meCircle = L.circle(ll, { radius: pos.coords.accuracy, weight: 1, color: '#2b6cb0', fillOpacity: 0.08, interactive: false }).addTo(map);
  } else { meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(pos.coords.accuracy); }
  return ll;
}
$('#btnLocate').addEventListener('click', async () => {
  try { const p = await getPosition(); map.setView(showMe(p), Math.max(map.getZoom(), 14)); }
  catch { toast("Impossible d'obtenir votre position"); }
});
$('#btnStartGps').addEventListener('click', async () => {
  try { const p = await getPosition(); const ll = showMe(p); map.setView(ll, Math.max(map.getZoom(), 13)); setPoint('start', { lat: ll[0], lng: ll[1] }, 'Ma position'); }
  catch { toast("Impossible d'obtenir votre position"); }
});
$('#btnFollow').addEventListener('click', async () => {
  state.follow = !state.follow;
  $('#btnFollow').classList.toggle('on', state.follow);
  if (state.follow) {
    if (!navigator.geolocation) { toast('Géolocalisation non disponible'); return; }
    watchId = navigator.geolocation.watchPosition((p) => { const ll = showMe(p); map.panTo(ll); },
      () => toast('Position indisponible'), { enableHighAccuracy: true, maximumAge: 5000 });
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* non supporté */ }
    setSnap('peek');
    toast('Suivi activé : la carte suit votre position');
  } else {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null; wakeLock?.release?.(); wakeLock = null;
    toast('Suivi désactivé');
  }
});

/* ------------------------------------------------------------------ */
/* Profil BRouter « éviter les routes »                                */
/* ------------------------------------------------------------------ */
let baseProfileText = null;
const profileIds = {}; // clé de réglages -> id de profil sur le serveur

function setGlobal(txt, name, val) {
  const re = new RegExp(`^assign ${name} (true|false)`, 'm');
  if (!re.test(txt)) throw new Error('Paramètre de profil introuvable : ' + name);
  return txt.replace(re, `assign ${name} ${val}`);
}
function replaceOnce(txt, from, to) {
  if (!txt.includes(from)) throw new Error('Profil : motif introuvable');
  return txt.replace(from, to);
}

/** Construit le profil à partir du profil « gravel » de BRouter (conçu pour éviter le trafic) */
function buildProfile(base, s) {
  let t = base;
  // Pénalité supplémentaire sur les routes selon le niveau d'évitement
  const lvl = { 1: { big: 1.0, small: 1.0 }, 2: { big: 2.5, small: 1.5 }, 3: { big: 6.0, small: 2.6 } }[s.avoid];
  t = replaceOnce(t, '\nassign costfactor\n', `
assign roadavoidpenalty
    switch highway=trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link ${lvl.big.toFixed(2)}
    switch highway=unclassified|road|residential|living_street|service ${lvl.small.toFixed(2)}
    1

assign costfactor
    multiply roadavoidpenalty
`);
  if (s.avoid >= 2) t = setGlobal(t, 'avoid_noise', true);
  if (s.avoid >= 3) { t = setGlobal(t, 'avoid_towns', true); t = setGlobal(t, 'consider_traffic_estimate', true); }

  if (s.bike === 'vtt') {
    t = setGlobal(t, 'prefer_unpaved_paths', true);
    t = replaceOnce(t, 'if mtb:scale=0    then 1.5 else    if mtb:scale=0+    then 3.0 else 9.0', 'if mtb:scale=0|0+    then 1.1 else if mtb:scale=1-|1|1+ then 1.4 else if mtb:scale=2-|2|2+ then 2.5 else 9.0');
    t = replaceOnce(t, 'if sac_scale=hiking    then 2.5 else 10000', 'if sac_scale=hiking    then 1.3 else if sac_scale=mountain_hiking then 3.0 else 10000');
  } else if (s.bike === 'ville') {
    t = setGlobal(t, 'assume_wet_conditions', true); // pénalise fortement les chemins accidentés
    t = setGlobal(t, 'prefer_cycle_routes', true);
  }
  const pr = OPTIM[s.optim] || OPTIM.balade;
  if (s.hills === 'avoid' || pr.hills) t = setGlobal(t, 'consider_elevation', true);
  if (pr.w < 1 || pr.smooth) {
    // Rapproche le coût de chaque voie de 1 (= distance pure) selon le poids w, sans jamais
    // rendre praticable une voie interdite (coût ≥ 9999). « Rapide » favorise en plus les revêtements lisses.
    const W = pr.w.toFixed(2);
    t = replaceOnce(t, '\n# way priorities used for voice hint generation', `
assign costfactor
    switch greater costfactor 9998 costfactor
    add 1 multiply ${W} max 0 sub costfactor 1
${pr.smooth ? `
assign costfactor
    switch greater costfactor 9998 costfactor
    multiply costfactor smoothnesspenalty
` : ''}
# way priorities used for voice hint generation`);
  }
  if (s.forest) { t = setGlobal(t, 'prefer_forests', true); t = setGlobal(t, 'prefer_rivers', true); }
  return t;
}
const profileKey = (s) => `${s.avoid}-${s.optim}-${s.bike}-${s.hills}-${s.forest ? 1 : 0}`;

async function getProfileId(force = false, signal) {
  const key = profileKey(settings);
  if (!force && profileIds[key]) return profileIds[key];
  if (!baseProfileText) baseProfileText = await (await fetch('profiles/gravel.brf')).text();
  const body = buildProfile(baseProfileText, settings);
  const r = await fetchT(`${BROUTER}/profile`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, signal }, 15000);
  const j = await r.json();
  if (!j.profileid) throw new Error(j.error || 'téléversement du profil refusé');
  profileIds[key] = j.profileid;
  return j.profileid;
}

class RouteError extends Error {}
function humanError(msg) {
  if (/not mapped|position/i.test(msg)) return "Un des points est trop loin d'un chemin praticable. Déplacez-le un peu.";
  if (/island/i.test(msg)) return 'Point isolé (île, zone privée…) : déplacez-le.';
  if (msg === 'timeout') return 'Le serveur de calcul met trop de temps à répondre. Réessayez dans un instant, ou raccourcissez le trajet.';
  if (/retry later/i.test(msg)) return 'Le serveur de calcul est très sollicité. Réessayez dans une minute.';
  if (/killed|timeout|too long|watchdog/i.test(msg)) return 'Itinéraire trop long ou trop complexe : ajoutez une étape ou réduisez la distance.';
  if (/datafile|rd5/i.test(msg)) return 'Zone non couverte par le calculateur.';
  return 'Calcul impossible : ' + msg.slice(0, 120);
}

const sleep = (ms, signal) => new Promise((ok, ko) => {
  const t = setTimeout(ok, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); ko(new DOMException('annulé', 'AbortError')); }, { once: true });
});

/** nogos : zones pondérées « lon,lat,rayon,poids » que le calcul évite (sans les interdire). */
async function brouterRaw(points, profile, signal, nogos = []) {
  const lonlats = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url = `${BROUTER}?lonlats=${lonlats}&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson&timode=2` + (nogos.length ? `&nogos=${nogos.join('|')}` : '');
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetchT(url, { signal }, 60000);
    } catch (e) {
      if (e.name === 'TimeoutError' || (e.name === 'AbortError' && !signal?.aborted)) throw new RouteError('timeout');
      throw e;
    }
    const t = await r.text();
    // Serveur public momentanément saturé : on patiente un peu puis on réessaie
    if ((/retry later/i.test(t) || r.status === 429 || r.status === 503) && attempt < 4) { await sleep(1500 * (attempt + 1), signal); continue; }
    if (!r.ok || t.trim()[0] !== '{') throw new RouteError(t.trim() || `HTTP ${r.status}`);
    return JSON.parse(t);
  }
}

/** Calcule l'itinéraire passant par `points` avec le profil personnalisé, avec repli sur « trekking ». */
async function brouter(points, signal, nogos = []) {
  let profile, note = '';
  try { profile = await getProfileId(false, signal); }
  catch (e) {
    if (signal?.aborted) throw e;
    console.warn('Profil personnalisé indisponible', e); profile = 'trekking'; note = 'Profil standard « trekking » utilisé (profil personnalisé indisponible).';
  }
  try {
    return { gj: await brouterRaw(points, profile, signal, nogos), note };
  } catch (e) {
    if (signal?.aborted || !(e instanceof RouteError) || /not mapped|position|island|timeout|retry/i.test(e.message) || profile === 'trekking') throw e;
    // Le profil a pu expirer sur le serveur : on le renvoie une fois, sinon repli
    try { profile = await getProfileId(true, signal); return { gj: await brouterRaw(points, profile, signal, nogos), note }; }
    catch (e2) { if (signal?.aborted) throw e2; return { gj: await brouterRaw(points, 'trekking', signal, nogos), note: 'Profil standard « trekking » utilisé.' }; }
  }
}

/* ------------------------------------------------------------------ */
/* Analyse du tracé                                                    */
/* ------------------------------------------------------------------ */
function classify(tags) {
  const h = (/(?:^| )highway=([^ ]+)/.exec(tags) || [])[1] || '';
  if (/^(cycleway|track|path|bridleway|footway|pedestrian|steps)$/.test(h)) return 'off';
  if (!h && /route=ferry/.test(tags)) return 'calm';
  if (/^(residential|service|living_street|unclassified|road)$/.test(h)) return 'calm';
  if (/(?:^| )cycleway=track/.test(tags) || /bicycle_road=yes/.test(tags)) return 'calm';
  return h ? 'road' : 'calm';
}

function analyze(gj) {
  const f = gj.features[0];
  const c = f.geometry.coordinates.map(([lo, la, e]) => [+(+lo).toFixed(6), +(+la).toFixed(6), e == null ? null : Math.round(e)]);
  const cum = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + hav(cll(c[i - 1]), cll(c[i])));
  const msgs = f.properties.messages || [];
  const hdr = msgs[0] || [];
  const iLon = hdr.indexOf('Longitude'), iLat = hdr.indexOf('Latitude'), iDist = hdr.indexOf('Distance'), iTags = hdr.indexOf('WayTags');
  const dist = { off: 0, calm: 0, road: 0 };
  const segs = [];
  let from = 0, lastCat = 'calm';
  for (let k = 1; k < msgs.length; k++) {
    const m = msgs[k];
    const cat = classify(iTags >= 0 ? String(m[iTags] || '') : '');
    dist[cat] += +m[iDist] || 0;
    lastCat = cat;
    const lon = +m[iLon] / 1e6, lat = +m[iLat] / 1e6;
    let j = from;
    while (j < c.length && !(Math.abs(c[j][0] - lon) < 3e-6 && Math.abs(c[j][1] - lat) < 3e-6)) j++;
    if (j >= c.length) continue; // point non retrouvé : la ligne suivante couvrira ce tronçon
    if (j > from) {
      const prev = segs[segs.length - 1];
      if (prev && prev.cat === cat) prev.to = j; else segs.push({ cat, from, to: j });
      from = j;
    }
  }
  if (from < c.length - 1) segs.push({ cat: lastCat, from, to: c.length - 1 });
  if (segs.length) {
    dist.off = dist.calm = dist.road = 0;
    segs.forEach((sg) => { dist[sg.cat] += cum[sg.to] - cum[sg.from]; });
  }
  const totalMsg = dist.off + dist.calm + dist.road;
  const length = +f.properties['track-length'] || cum[cum.length - 1];
  if (!totalMsg) dist.calm = length;
  let ascend = +f.properties['filtered ascend'];
  if (!Number.isFinite(ascend)) {
    ascend = 0;
    for (let i = 1; i < c.length; i++) if (c[i][2] != null && c[i - 1][2] != null && c[i][2] > c[i - 1][2]) ascend += c[i][2] - c[i - 1][2];
  }
  // Instructions de guidage BRouter : [index du point, commande, n° de sortie, …]
  const hints = (f.properties.voicehints || []).map((h) => [+h[0], +h[1], +h[2] || 0]).filter((h) => h[0] < c.length);
  return { coords: c, cum, segs, dist, length, ascend: Math.round(ascend), hints };
}

/* ------------------------------------------------------------------ */
/* Calcul A→B et boucle                                                */
/* ------------------------------------------------------------------ */
$('#btnRoute').addEventListener('click', () => computeRoute());
$('#btnOtherLoop').addEventListener('click', () => { state.loopSeed += 70 + Math.random() * 80; computeRoute(); });

/* ------------------------------------------------------------------ */
/* Boucles sans aller-retour                                           */
/*  - la boucle est calculée tronçon par tronçon ;                     */
/*  - chaque tronçon évite (pénalité) les chemins déjà parcourus ;     */
/*  - les culs-de-sac aux points de passage sont supprimés ;           */
/*  - plusieurs directions sont essayées, la meilleure est gardée.     */
/* ------------------------------------------------------------------ */
const sameNode = (a, b) => Math.abs(a[0] - b[0]) < 2e-6 && Math.abs(a[1] - b[1]) < 2e-6;
/** Nombre de points du cul-de-sac : fin de A et début de B empruntent le même chemin à rebours. */
function spurLen(A, B) {
  let m = 0;
  while (m + 1 < A.length && m + 1 < B.length && sameNode(A[A.length - 2 - m], B[m + 1])) m++;
  return m;
}
/** Zones pondérées le long des chemins déjà parcourus (sauf autour des points de jonction). */
function nogosAlong(coords, keepClear, spacing = 140, radius = 70, weight = 3) {
  const out = [];
  let acc = spacing;
  for (let i = 1; i < coords.length; i++) {
    const b = cll(coords[i]);
    acc += hav(cll(coords[i - 1]), b);
    if (acc < spacing) continue;
    acc = 0;
    if (keepClear.some((k) => hav(k, b) < 350)) continue;
    out.push(`${b.lng.toFixed(5)},${b.lat.toFixed(5)},${radius},${weight}`);
  }
  return out.slice(-400); // limite la taille de la requête
}
const bearingOf = (a, b) => {
  const φ1 = rad(a[1]), φ2 = rad(b[1]), Δλ = rad(b[0] - a[0]);
  return (deg(Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ))) + 360) % 360;
};
/** Instruction de virage à une jonction entre deux tronçons (BRouter ne la fournit pas). */
function junctionHint(C, idx, next) {
  const prev = C[Math.max(0, idx - 2)] || C[idx - 1];
  if (!prev || !next) return null;
  const t = ((bearingOf(C[idx], next) - bearingOf(prev, C[idx]) + 540) % 360) - 180; // > 0 : à droite
  const a = Math.abs(t);
  if (a < 25) return null;
  const cmd = a < 60 ? (t > 0 ? 6 : 3) : a < 130 ? (t > 0 ? 5 : 2) : (t > 0 ? 7 : 4);
  return [idx, cmd, 0];
}

/** Calcule une boucle passant par pts (pts[0] = départ = arrivée), tronçon par tronçon. */
async function loopLegs(pts, signal, trim = true) {
  let C = [], hints = [], rows = [], header = null, ascend = 0, note = '';
  for (let k = 0; k < pts.length - 1; k++) {
    const nogos = C.length ? nogosAlong(C, [pts[0], pts[k], pts[k + 1]]) : [];
    const { gj, note: n } = await brouter([pts[k], pts[k + 1]], signal, nogos);
    if (n) note = n;
    const f = gj.features[0], lc = f.geometry.coordinates;
    const msgs = f.properties.messages || [];
    header = header || msgs[0];
    rows.push(...msgs.slice(1));
    ascend += +f.properties['filtered ascend'] || 0;
    const lh = (f.properties.voicehints || []).map((h) => [+h[0], +h[1], +h[2] || 0]);
    if (!C.length) { C = lc.slice(); hints = lh; continue; }
    const m = trim ? spurLen(C, lc) : 0; // cul-de-sac : on le coupe des deux côtés
    if (m) C.length -= m;
    const j = C.length - 1; // jonction
    hints = hints.filter((h) => h[0] < j);
    const jh = junctionHint(C, j, lc[m + 1]);
    if (jh) hints.push(jh);
    const offset = j - m;
    lh.forEach((h) => { if (h[0] > m) hints.push([h[0] + offset, h[1], h[2]]); });
    C.push(...lc.slice(m + 1));
  }
  const gj = { features: [{ geometry: { coordinates: C }, properties: { messages: header ? [header, ...rows] : [], voicehints: hints, 'filtered ascend': ascend } }] };
  const res = analyze(gj);
  res.pts = ptsOf(pts);
  res.overlap = routeOverlap(res);
  return { res, note };
}

/** Part du parcours empruntée deux fois (dans un sens ou dans l'autre). */
function routeOverlap(r) {
  const cells = new Map(), step = 15;
  let reused = 0, total = 0;
  for (let i = 1; i < r.coords.length; i++) {
    const a = cll(r.coords[i - 1]), b = cll(r.coords[i]), d = r.cum[i] - r.cum[i - 1], n = Math.max(1, Math.ceil(d / step));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, key = Math.round((a.lat + (b.lat - a.lat) * t) / 0.0002) + ':' + Math.round((a.lng + (b.lng - a.lng) * t) / 0.00028);
      const pos = r.cum[i - 1] + d * t, first = cells.get(key);
      if (first == null) cells.set(key, pos); else if (pos - first > 250) reused += d / n;
      total += d / n;
    }
  }
  return total ? reused / total : 0;
}

function loopWaypoints(S, targetM, bearing) {
  // Cercle passant par le départ ; les chemins réels font ~30 % de détours en plus
  const r = targetM / (2 * Math.PI * 1.3);
  const center = destination(S, bearing, r);
  return [90, 180, 270].map((a) => destination(center, (bearing + 180 + a) % 360, r));
}

const ptsOf = (arr) => arr.map((q) => ({ lat: +q.lat.toFixed(6), lng: +q.lng.toFixed(6) }));

async function computeRoute() {
  if (!state.start) { toast('Choisissez un point de départ'); $('#inStart').focus(); return; }
  if (state.mode === 'ab' && !state.end) { toast("Choisissez un point d'arrivée"); $('#inEnd').focus(); return; }
  const signal = startOp(state.mode === 'loop' ? 'Recherche d’une belle boucle…' : 'Calcul de l’itinéraire…');
  try {
    let result, note = '';
    if (state.mode === 'ab') {
      const pts = [state.start, ...state.vias, state.end];
      ({ gj: result, note } = await brouter(pts, signal));
      result = analyze(result); result.pts = ptsOf(pts);
    } else if (state.vias.length) {
      // Boucle par des étapes : celles choisies par l'utilisateur sont toujours atteintes (pas de découpe)
      const userVias = state.vias.some((v) => !v.auto);
      ({ res: result, note } = await loopLegs([state.start, ...state.vias, state.start], signal, !userVias));
      if (userVias) note = (note ? note + ' ' : '') + 'Boucle passant par vos étapes (distance libre).';
    } else {
      const target = settings.loopKm * 1000;
      const b0 = settings.loopDir === 'auto' ? state.loopSeed % 360 : +settings.loopDir + ((state.loopSeed % 40) - 20);
      const bearings = settings.loopDir === 'auto' ? [b0, b0 + 120, b0 + 240] : [b0, b0 + 35, b0 - 35];
      // Score : allers-retours + écart à la distance demandée (tolérance de 8 %)
      const score = (a) => a.overlap * 2 + Math.max(0, Math.abs(a.length / target - 1) - 0.08) * 1.5;
      let best = null, bestB = 0, bestScale = 1, lastErr = null;
      // 1) plusieurs directions : on garde la boucle avec le moins d'allers-retours et la bonne distance
      for (let i = 0; i < bearings.length; i++) {
        busy(true, `Recherche de la meilleure boucle (${i + 1}/${bearings.length})…`);
        try {
          const { res: a, note: n } = await loopLegs([state.start, ...loopWaypoints(state.start, target, bearings[i] % 360), state.start], signal);
          note = n;
          if (!best || score(a) < score(best)) { best = a; bestB = bearings[i] % 360; }
          if (a.overlap < 0.06 && Math.abs(a.length / target - 1) < 0.15) break; // déjà très bonne
        } catch (e) {
          if (signal.aborted || !(e instanceof RouteError)) throw e;
          lastErr = e; // point tombé dans un lac, une zone privée… direction suivante
        }
      }
      if (!best) throw lastErr || new RouteError('Aucune boucle trouvée');
      // 2) ajustement de la distance sur la meilleure direction
      let lastLen = best.length;
      for (let k = 0; k < 2 && Math.abs(best.length / target - 1) > 0.12; k++) {
        bestScale = Math.min(Math.max(bestScale * target / lastLen, 0.35), 2.5);
        busy(true, `Ajustement de la distance (${fmtKm(best.length)} → ${settings.loopKm} km)…`);
        try {
          const { res: a } = await loopLegs([state.start, ...loopWaypoints(state.start, target * bestScale, bestB), state.start], signal);
          lastLen = a.length;
          if (score(a) < score(best)) best = a;
        } catch (e) { if (signal.aborted || !(e instanceof RouteError)) throw e; break; }
      }
      result = best;
      $('#btnOtherLoop').hidden = false;
    }
    if (signal.aborted) return;
    state.route = result;
    if (!tmp.set('route', result)) tmp.set('route', null);
    if (!isDesktop()) setSnap('half'); // avant le cadrage, pour que le parcours soit visible au-dessus du panneau
    showRoute(result, true);
    if (state.mode === 'loop' && result.overlap != null) {
      const ov = Math.round(result.overlap * 100);
      note = (ov <= 3 ? '✅ Vraie boucle : aucun aller-retour.' : `↔️ ${ov} % du parcours est emprunté deux fois (souvent inévitable près du départ ou en montagne). Essayez « ↻ Autre ».`) + (note ? ' ' + note : '');
    }
    $('#routeNote').textContent = note;
    $('#tab-route').scrollTop = 0;
    if (!isDesktop()) setSnap('half');
  } catch (e) {
    if (signal.aborted) return;
    console.error(e);
    toast(e instanceof RouteError ? humanError(e.message) : 'Service de calcul injoignable. Vérifiez votre connexion.', 6000);
  } finally {
    endOp(signal);
  }
}

/** Affiche (true) ou replie (false) le formulaire de préparation. */
function showPlan(open) {
  $('#planForm').hidden = !open;
  $('#planToggle').hidden = !state.route;
  $('#planToggle').setAttribute('aria-expanded', String(open));
  $('#planToggle .chev').textContent = open ? 'Replier ▴' : 'Modifier ▾';
  const pts = state.mode === 'loop' ? `↻ ${settings.loopKm} km` : 'A → B';
  $('#planSummary').textContent = `${pts} · ${prioLabel()}${state.vias.length ? ` · ${state.vias.length} étape(s)` : ''}`;
}
$('#planToggle').addEventListener('click', () => {
  const open = $('#planForm').hidden;
  showPlan(open);
  if (open && !isDesktop()) { setSnap('full'); setTimeout(() => $('#planToggle').scrollIntoView({ block: 'start', behavior: 'smooth' }), 320); }
});

const COLORS = () => {
  const cs = getComputedStyle(document.documentElement);
  return { off: cs.getPropertyValue('--off').trim(), calm: cs.getPropertyValue('--calm').trim(), road: cs.getPropertyValue('--road').trim(), unk: '#2b6cb0' };
};

function showRoute(r, fit) {
  routeLayer.clearLayers();
  const col = COLORS();
  const all = r.coords.map((c) => [c[1], c[0]]);
  L.polyline(all, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(routeLayer);
  r.segs.forEach((s) => L.polyline(all.slice(s.from, s.to + 1), { color: col[s.cat], weight: 5, opacity: 0.95, interactive: false }).addTo(routeLayer));
  if (fit) map.fitBounds(L.latLngBounds(all), mapPadding());

  $('#result').hidden = false;
  state.dirty = false; $('#dirtyNote').hidden = true; $('#result').classList.remove('stale');
  showPlan(false); updateRouteBtn();
  const short = (l) => (l || '').split(',')[0];
  $('#resTitle').textContent = state.mode === 'loop' ? `↻ Boucle depuis ${short(state.start?.label)}` : `${short(state.start?.label)} → ${short(state.end?.label)}`;
  $('#resPrio').textContent = prioLabel();
  $('#miniStats').hidden = false;
  const known = r.dist.off + r.dist.calm + r.dist.road;
  const off = r.dist.off / (known || 1);
  $('#stDist').textContent = fmtKm(r.length);
  $('#stUp').textContent = r.ascend + ' m';
  $('#stTime').textContent = fmtDur(r.length / 1000 / SPEED[settings.bike] + r.ascend / 500);
  $('#stOff').textContent = known ? Math.round(off * 100) + ' %' : '–';
  $('#miniStats').textContent = `${$('#stDist').textContent} · ${$('#stTime').textContent} · ${$('#stOff').textContent} hors route`;
  const tot = known + (r.dist.unk || 0) || 1;
  $('#surfBar').innerHTML = ['off', 'calm', 'road', 'unk'].filter((k) => r.dist[k]).map((k) => `<div class="c-${k}" style="width:${(100 * r.dist[k] / tot).toFixed(1)}%" title="${fmtKm(r.dist[k])}"></div>`).join('');
  requestAnimationFrame(() => drawElevation(r));
  if (typeof renderRoadbook === 'function') renderRoadbook(r);
}

/* Profil altimétrique */
function drawElevation(r) {
  const cv = $('#elev');
  const w = cv.clientWidth, h = 110;
  if (!w) return;
  const dpr = devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  const cs = getComputedStyle(document.documentElement);
  const muted = cs.getPropertyValue('--muted').trim(), col = COLORS();
  const pts = r.coords.map((c, i) => [r.cum[i], c[2]]).filter((p) => p[1] != null);
  ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = muted;
  if (pts.length < 2) { ctx.fillText('Altitude indisponible', 8, 20); return; }
  let min = Math.min(...pts.map((p) => p[1])), max = Math.max(...pts.map((p) => p[1]));
  if (max - min < 30) { const m = (max + min) / 2; min = m - 15; max = m + 15; }
  const total = r.cum[r.cum.length - 1] || 1, L0 = 34, B = 16;
  const x = (d) => L0 + (w - L0 - 4) * d / total;
  const y = (e) => 6 + (h - B - 6) * (1 - (e - min) / (max - min));
  // aire
  ctx.beginPath(); ctx.moveTo(x(pts[0][0]), h - B);
  pts.forEach((p) => ctx.lineTo(x(p[0]), y(p[1])));
  ctx.lineTo(x(pts[pts.length - 1][0]), h - B); ctx.closePath();
  ctx.fillStyle = 'rgba(63,138,76,.18)'; ctx.fill();
  // ligne colorée par type de voie
  ctx.lineWidth = 2;
  r.segs.forEach((s) => {
    ctx.beginPath(); ctx.strokeStyle = col[s.cat]; let started = false;
    for (let i = s.from; i <= s.to; i++) {
      const e = r.coords[i][2]; if (e == null) continue;
      if (!started) { ctx.moveTo(x(r.cum[i]), y(e)); started = true; } else ctx.lineTo(x(r.cum[i]), y(e));
    }
    ctx.stroke();
  });
  ctx.fillStyle = muted;
  ctx.fillText(Math.round(max) + ' m', 0, 12);
  ctx.fillText(Math.round(min) + ' m', 0, h - B);
  ctx.fillText('0', L0, h - 3);
  const lbl = fmtKm(total); ctx.fillText(lbl, w - ctx.measureText(lbl).width - 2, h - 3);
}
function idxAtDistance(r, d) {
  let lo = 0, hi = r.cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (r.cum[mid] < d) lo = mid + 1; else hi = mid; }
  return lo;
}
const elevCv = $('#elev');
elevCv.addEventListener('pointermove', (e) => {
  const r = state.route; if (!r) return;
  const rect = elevCv.getBoundingClientRect();
  const d = Math.max(0, Math.min(1, (e.clientX - rect.left - 34) / (rect.width - 38))) * r.cum[r.cum.length - 1];
  const c = r.coords[idxAtDistance(r, d)];
  const ll = [c[1], c[0]];
  if (!hoverMarker) hoverMarker = L.circleMarker(ll, { radius: 7, color: '#fff', weight: 3, fillColor: '#2b6cb0', fillOpacity: 1 }).addTo(map);
  else hoverMarker.setLatLng(ll);
  hoverMarker.bindTooltip(`${fmtKm(d)}${c[2] != null ? ' · ' + c[2] + ' m' : ''}`, { permanent: true, direction: 'top', offset: [0, -8] }).openTooltip();
});
elevCv.addEventListener('pointerleave', () => { hoverMarker?.remove(); hoverMarker = null; });
addEventListener('resize', () => { if (state.route && !$('#result').hidden) drawElevation(state.route); });

/* ------------------------------------------------------------------ */
/* Export GPX, sauvegarde des parcours                                 */
/* ------------------------------------------------------------------ */
function sampleRoute(r, maxPts) {
  const total = r.cum[r.cum.length - 1], step = total / maxPts, out = [];
  let next = 0;
  for (let i = 0; i < r.coords.length; i++) if (r.cum[i] >= next || i === r.coords.length - 1) { out.push(i); next = r.cum[i] + step; }
  return out;
}
function nearestOnRoute(r, samples, p) {
  let best = Infinity, km = 0;
  for (const i of samples) { const d = hav(p, cll(r.coords[i])); if (d < best) { best = d; km = r.cum[i]; } }
  return { d: best, at: km };
}

function toGpx(r, name) {
  const x = (s) => esc(s);
  const wpts = [];
  const add = (p, n, sym) => wpts.push(`<wpt lat="${p.lat}" lon="${p.lng}"><name>${x(n)}</name><sym>${sym}</sym></wpt>`);
  if (state.start) add(state.start, 'Départ', 'Flag, Green');
  if (state.end && state.mode === 'ab') add(state.end, 'Arrivée', 'Flag, Red');
  const samples = sampleRoute(r, 400);
  state.myPois.forEach((p) => { if (nearestOnRoute(r, samples, p).d < 500) add(p, `${MY_CATS[p.cat]?.[0] || ''} ${p.name}`, 'Scenic Area'); });
  if (typeof reportsNear === 'function') reportsNear(r, samples).forEach((rp) => add(rp, `${repCat(rp.cat)[0]} ${repCat(rp.cat)[1]}${rp.note ? ' – ' + rp.note : ''}`, 'Danger Area'));
  const trk = r.coords.map((c) => `<trkpt lat="${c[1]}" lon="${c[0]}">${c[2] != null ? `<ele>${c[2]}</ele>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Sentiers Vélo" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${x(name)}</name></metadata>
${wpts.join('\n')}
<trk><name>${x(name)}</name><trkseg>
${trk}
</trkseg></trk>
</gpx>`;
}
function routeName() {
  const short = (l) => (l || '').split(',')[0];
  return state.mode === 'loop' ? `Boucle de ${fmtKm(state.route.length)} – ${short(state.start?.label)}` : `${short(state.start?.label)} → ${short(state.end?.label)}`;
}
async function shareOrDownload(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const file = new File([blob], filename, { type: mime });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#btnGpx').addEventListener('click', () => {
  if (!state.route) return;
  const name = routeName();
  shareOrDownload(toGpx(state.route, name), name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().replace(/\s+/g, '_') + '.gpx', 'application/gpx+xml');
});

$('#btnSave').addEventListener('click', () => {
  if (!state.route) return;
  const name = prompt('Nom du parcours', routeName());
  if (name == null) return;
  const list = store.get('routes', []);
  list.unshift({ id: uid(), name: name.trim() || routeName(), date: Date.now(), mode: state.mode, start: state.start, end: state.end, vias: state.vias, settings: { ...settings }, route: state.route });
  if (!store.set('routes', list)) { toast('Mémoire pleine : supprimez d’anciens parcours'); return; }
  toast('Parcours enregistré dans « Mes parcours »');
});

function renderSaved() {
  const ul = $('#savedList'); const list = store.get('routes', []);
  ul.innerHTML = list.length ? '' : '<li class="empty">Aucun parcours enregistré pour l’instant.</li>';
  list.forEach((it) => {
    const li = document.createElement('li');
    const kn = it.route.dist.off + it.route.dist.calm + it.route.dist.road;
    const off = kn ? Math.round(100 * it.route.dist.off / kn) + ' %' : '–';
    li.innerHTML = `<span>${it.mode === 'loop' ? '↻' : '→'}</span><span class="grow"><b>${esc(it.name)}</b>
      <small>${fmtKm(it.route.length)} · ${it.route.ascend} m D+ · ${off} hors route · ${new Date(it.date).toLocaleDateString('fr-FR')}</small></span>
      <button aria-label="Supprimer">🗑</button>`;
    li.querySelector('.grow').addEventListener('click', () => {
      state.mode = it.mode; state.start = it.start; state.end = it.end; state.vias = it.vias || [];
      Object.assign(settings, it.settings); applySettingsToUI();
      state.route = it.route; tmp.set('route', it.route);
      setMode(it.mode); showTab('route'); showRoute(it.route, true);
    });
    li.querySelector('button').addEventListener('click', () => {
      if (!confirm(`Supprimer « ${it.name} » ?`)) return;
      store.set('routes', store.get('routes', []).filter((x) => x.id !== it.id)); renderSaved();
    });
    ul.append(li);
  });
}

/* ------------------------------------------------------------------ */
/* Mes points d'intérêt                                                */
/* ------------------------------------------------------------------ */
const poiDialog = $('#poiDialog'), poiForm = $('#poiForm');
$('#poiCatSelect').innerHTML = Object.entries(MY_CATS).map(([k, [e, l]]) => `<option value="${k}">${e} ${l}</option>`).join('');
let editingPoi = null;

function openPoiDialog(poi) {
  editingPoi = poi;
  $('#poiDialogTitle').textContent = poi.id ? 'Modifier le point' : "Nouveau point d'intérêt";
  poiForm.name.value = poi.name || ''; poiForm.cat.value = poi.cat || 'fav'; poiForm.note.value = poi.note || '';
  $('#poiDelete').hidden = !poi.id;
  poiDialog.showModal();
}
poiDialog.addEventListener('close', () => {
  const p = editingPoi; editingPoi = null; if (!p) return;
  const v = poiDialog.returnValue;
  if (v === 'save') {
    Object.assign(p, { name: poiForm.name.value.trim(), cat: poiForm.cat.value, note: poiForm.note.value.trim() });
    if (!p.id) { p.id = uid(); p.lat = +p.lat.toFixed(6); p.lng = +p.lng.toFixed(6); p.created = Date.now(); state.myPois.push(p); }
    toast('Point enregistré');
  } else if (v === 'delete') {
    state.myPois = state.myPois.filter((x) => x.id !== p.id);
  } else return;
  store.set('myPois', state.myPois); renderMyPois();
});

function poiPopup(p, actions) {
  const div = document.createElement('div'); div.className = 'ctx';
  div.innerHTML = p.html;
  actions.forEach(([t, fn]) => { const b = document.createElement('button'); b.textContent = t; b.addEventListener('click', () => { map.closePopup(); fn(); }); div.append(b); });
  return div;
}

function renderMyPois() {
  myPoiLayer.clearLayers();
  const ul = $('#myPoiList'); ul.innerHTML = state.myPois.length ? '' : '<li class="empty">Aucun point pour l’instant.</li>';
  state.myPois.forEach((p) => {
    const [emoji, catLabel] = MY_CATS[p.cat] || MY_CATS.other;
    const m = L.marker([p.lat, p.lng], { icon: pin(emoji, 'mine') }).addTo(myPoiLayer);
    m.bindPopup(() => poiPopup({ html: `<h4>${esc(p.name)}</h4><p>${esc(catLabel)}</p>${p.note ? `<p>${esc(p.note)}</p>` : ''}` }, [
      ['➕ Passer par ici (étape)', () => setPoint('via', p, p.name)],
      ['✏️ Modifier', () => openPoiDialog(p)],
    ]));
    const li = document.createElement('li');
    li.innerHTML = `<span>${emoji}</span><span class="grow"><b>${esc(p.name)}</b><small>${esc(p.note || catLabel)}</small></span><button aria-label="Modifier">✏️</button>`;
    li.querySelector('.grow').addEventListener('click', () => { map.setView([p.lat, p.lng], Math.max(map.getZoom(), 15)); m.openPopup(); });
    li.querySelector('button').addEventListener('click', () => openPoiDialog(p));
    ul.append(li);
  });
}

$('#btnExportPoi').addEventListener('click', () => {
  shareOrDownload(JSON.stringify({ app: 'sentiers-velo', version: 1, pois: state.myPois }, null, 2), 'mes-points-interet.json', 'application/json');
});
$('#fileImportPoi').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const arr = (Array.isArray(j) ? j : j.pois || []).filter((p) => Number.isFinite(+p.lat) && Number.isFinite(+p.lng) && p.name);
    const ids = new Set(state.myPois.map((p) => p.id));
    let n = 0;
    arr.forEach((p) => { if (!ids.has(p.id)) { state.myPois.push({ id: p.id || uid(), lat: +p.lat, lng: +p.lng, name: String(p.name).slice(0, 80), cat: MY_CATS[p.cat] ? p.cat : 'other', note: String(p.note || '').slice(0, 500), created: p.created || Date.now() }); n++; } });
    store.set('myPois', state.myPois); renderMyPois(); toast(`${n} point(s) importé(s)`);
  } catch { toast('Fichier invalide'); }
  e.target.value = '';
});

/* ------------------------------------------------------------------ */
/* Suggestions de points d'intérêt (OpenStreetMap / Overpass)          */
/* ------------------------------------------------------------------ */
const catState = store.get('suggCats', Object.fromEntries(Object.entries(SUGG_CATS).map(([k, c]) => [k, c.on])));
$('#poiCats').innerHTML = Object.entries(SUGG_CATS).filter(([, c]) => !c.hidden).map(([k, c]) => `<label><input type="checkbox" value="${k}" ${catState[k] ? 'checked' : ''}>${c.emoji} ${c.label}</label>`).join('');
$('#poiCats').addEventListener('change', (e) => { catState[e.target.value] = e.target.checked; store.set('suggCats', catState); });

function overpass(q, signal) {
  return hedged(OVERPASS, (url, sig) => fetchT(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal: sig }, 35000)
    .then(async (r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!Array.isArray(j.elements)) throw new Error('réponse invalide');
      if (!j.elements.length && /runtime error|timed out|out of memory/i.test(j.remark || '')) throw new Error(j.remark);
      return j;
    }), { stagger: 6000, total: 35000, signal });
}

/** Découpe le parcours en tronçons de ~10 km et renvoie une emprise (s,w,n,e) par tronçon, élargie de padM mètres. */
function routeBoxes(r, padM) {
  const boxes = [], step = 10000;
  let box = null, startD = 0;
  const dLat = padM / 111320;
  r.coords.forEach((c, i) => {
    if (!box) box = [c[1], c[0], c[1], c[0]];
    box[0] = Math.min(box[0], c[1]); box[1] = Math.min(box[1], c[0]); box[2] = Math.max(box[2], c[1]); box[3] = Math.max(box[3], c[0]);
    if (r.cum[i] - startD > step || i === r.coords.length - 1) { boxes.push(box); box = [c[1], c[0], c[1], c[0]]; startD = r.cum[i]; }
  });
  return boxes.map(([s, w, n, e]) => {
    const dLng = padM / (111320 * Math.cos(rad((s + n) / 2)));
    return [s - dLat, w - dLng, n + dLat, e + dLng].map((v) => v.toFixed(5)).join(',');
  });
}

/** Articles Wikipédia géolocalisés (monuments, sites, curiosités…) autour du parcours ou de la zone visible. */
async function wikiNearby(r, signal) {
  let centers, radius;
  if (r) {
    radius = 3500;
    const n = Math.min(30, Math.ceil(r.length / 6000) + 1);
    centers = Array.from({ length: n }, (_, k) => cll(r.coords[idxAtDistance(r, (r.length * k) / Math.max(1, n - 1))]));
  } else {
    const b = map.getBounds(), c = map.getCenter();
    radius = Math.round(Math.min(10000, Math.max(500, hav(c, b.getNorthEast()))));
    centers = [c];
  }
  const NOISE = /^(Gare|Halte|Collège|Lycée|École|Groupe scolaire|Université|Stade|Gymnase|Liste|Arrondissement|Canton|Rue|Avenue|Boulevard|Cours|Quai|Place|Impasse|Quartier|Station|Arrêt|Hôpital|Clinique|Aéroport|Autoroute|Route|Ligne|Échangeur|Rocade|Périphérique|Tramway|Métro)\b/i;
  const found = new Map();
  let ok = 0, i = 0;
  const worker = async () => {
    while (i < centers.length) {
      const c = centers[i++];
      try {
        const res = await fetchT(`${WIKI}?action=query&list=geosearch&gscoord=${c.lat.toFixed(5)}|${c.lng.toFixed(5)}&gsradius=${radius}&gslimit=100&gsprimary=primary&format=json&origin=*`, { signal }, 10000);
        const j = await res.json();
        ok++;
        for (const g of j.query?.geosearch || []) {
          if (NOISE.test(g.title) || found.has(g.pageid)) continue;
          found.set(g.pageid, { id: 'wiki' + g.pageid, lat: g.lat, lng: g.lon, t: { wikipedia: 'fr:' + g.title }, cat: 'wiki', kind: 'Article Wikipédia', name: g.title });
        }
      } catch (e) { if (signal?.aborted) throw e; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (!ok) throw new Error('Wikipédia injoignable');
  return [...found.values()];
}

$('#btnSuggest').addEventListener('click', () => suggestPois());
$('#btnPoiRoute').addEventListener('click', () => { showTab('poi'); suggestPois(); });
$('#btnClearSuggest').addEventListener('click', () => { suggLayer.clearLayers(); state.suggested = []; $('#suggestInfo').textContent = ''; $('#suggList').innerHTML = ''; });

async function suggestPois() {
  const cats = Object.keys(SUGG_CATS).filter((k) => catState[k] && !SUGG_CATS[k].hidden);
  if (!cats.length) { toast('Sélectionnez au moins une catégorie'); return; }
  const r = state.route;
  if (!r && map.getZoom() < 11) { toast('Zoomez sur une zone, ou calculez d’abord un itinéraire'); return; }
  const osmCats = cats.filter((k) => !SUGG_CATS[k].wiki);
  const buffer = r ? (r.length > 60000 ? 700 : 500) : 0;
  const boxes = r ? routeBoxes(r, buffer) : [(() => { const b = map.getBounds(); return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(5)).join(','); })()];
  const parts = osmCats.flatMap((k) => SUGG_CATS[k].q).flatMap((q) => boxes.map((bb) => `${q}(${bb});`)).join('');
  const q = `[out:json][timeout:25];(${parts});out center tags 2000;`;

  const signal = startOp('Recherche de points d’intérêt…');
  const t0 = Date.now();
  const tick = setInterval(() => busy(true, `Recherche de points d’intérêt… ${Math.round((Date.now() - t0) / 1000)} s`), 1000);
  try {
    const [osm, wiki] = await Promise.allSettled([
      osmCats.length ? overpass(q, signal) : Promise.resolve({ elements: [] }),
      cats.includes('wiki') ? wikiNearby(r, signal) : Promise.resolve([]),
    ]);
    if (signal.aborted) return;
    const samples = r ? sampleRoute(r, 500) : null;
    const items = [];
    const keep = (it) => {
      if (samples) { const n = nearestOnRoute(r, samples, it); if (n.d > buffer) return; it.at = n.at; }
      items.push(it);
    };
    if (osm.status === 'fulfilled') {
      for (const el of osm.value.elements) {
        const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon, t = el.tags || {};
        if (lat == null) continue;
        const cat = osmCats.find((k) => SUGG_CATS[k].m(t));
        if (!cat) continue;
        const kindKey = t.tourism || t.historic || t.natural || t.amenity || t.leisure || (t.waterway === 'waterfall' && 'waterfall') || (t.shop === 'bicycle' && 'bicycle');
        keep({ id: el.type + el.id, lat, lng, t, cat, kind: KIND_FR[kindKey] || SUGG_CATS[cat].label, name: t['name:fr'] || t.name || '' });
      }
    }
    if (wiki.status === 'fulfilled') {
      const osmWiki = new Set(items.map((x) => x.t.wikipedia).filter(Boolean));
      wiki.value.forEach((w) => {
        if (osmWiki.has(w.t.wikipedia) || items.some((x) => x.name && x.name === w.name && hav(x, w) < 400)) return;
        keep(w);
      });
    }
    if (samples) items.sort((a, b) => a.at - b.at);
    state.suggested = items.slice(0, 400);
    renderSuggestions();

    const fails = [];
    if (osm.status === 'rejected' && osmCats.length) { console.warn('Overpass', osm.reason); fails.push('les serveurs OpenStreetMap sont saturés'); }
    if (wiki.status === 'rejected' && cats.includes('wiki')) { console.warn('Wikipédia', wiki.reason); fails.push('Wikipédia ne répond pas'); }
    if (fails.length === 2 || (fails.length && !items.length)) {
      $('#suggestInfo').textContent = `Recherche impossible pour le moment (${fails.join(', ')}). Réessayez dans une minute.`;
      toast('Points d’intérêt indisponibles pour le moment, réessayez dans une minute.', 5000);
      return;
    }
    $('#suggestInfo').textContent = (items.length
      ? `${items.length} point(s) trouvé(s) ${r ? 'le long du parcours' : 'dans la zone'}. Touchez-en un pour l'ajouter comme étape ou à vos points.`
      : 'Rien trouvé pour ces catégories.') + (fails.length ? ` (Résultats partiels : ${fails[0]}.)` : '');
    if (!isDesktop() && items.length) { toast(`${items.length} lieu(x) trouvé(s) : touchez-les sur la carte`); setSnap('peek'); }
  } finally { clearInterval(tick); endOp(signal); }
}

function renderSuggestions() {
  suggLayer.clearLayers();
  const ul = $('#suggList'); ul.innerHTML = '';
  state.suggested.forEach((s, idx) => {
    const t = s.t;
    const wiki = t.wikipedia && /^([a-z-]+):(.+)$/.exec(t.wikipedia);
    const links = [
      wiki ? `<a href="https://${wiki[1]}.wikipedia.org/wiki/${encodeURIComponent(wiki[2].replace(/ /g, '_'))}" target="_blank" rel="noopener">Wikipédia</a>` : '',
      /^https?:\/\//.test(t.website || '') ? `<a href="${esc(t.website)}" target="_blank" rel="noopener">Site web</a>` : '',
    ].filter(Boolean).join(' · ');
    const km = s.at != null ? `km ${(s.at / 1000).toFixed(1).replace('.', ',')}` : '';
    const extra = [t.ele && `${t.ele} m`, km && 'au ' + km, t.opening_hours && `Horaires : ${t.opening_hours}`].filter(Boolean).join(' · ');
    const emoji = SUGG_CATS[s.cat].emoji;
    const m = L.marker([s.lat, s.lng], { icon: pin(emoji, 'sugg') }).addTo(suggLayer);
    m.bindPopup(() => poiPopup({ html: `<h4>${esc(s.name || s.kind)}</h4><p>${esc(s.kind)}${extra ? ' · ' + esc(extra) : ''}</p>${links ? `<p>${links}</p>` : ''}` }, [
      ['➕ Passer par ici (étape)', () => setPoint('via', s, s.name || s.kind)],
      ['⭐ Ajouter à mes points', () => openPoiDialog({ lat: s.lat, lng: s.lng, name: s.name || s.kind, cat: s.myCat || { view: 'view', nature: 'nature', heritage: 'heritage', wiki: 'heritage', picnic: 'pause', water: 'water', food: 'food' }[s.cat] || 'other', note: [s.kind, t.description].filter(Boolean).join(' – ') })],
    ]));
    if (idx < 60 && (s.name || s.cat !== 'water')) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${emoji}</span><span class="grow"><b>${esc(s.name || s.kind)}</b><small>${esc([s.kind, km].filter(Boolean).join(' · '))}</small></span>`;
      li.querySelector('.grow').addEventListener('click', () => { map.setView([s.lat, s.lng], Math.max(map.getZoom(), 15)); m.openPopup(); });
      ul.append(li);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */
applySettingsToUI();
setMode(state.mode);
renderMyPois();
if (state.route) showRoute(state.route, false);
showPlan(!state.route);
updateRouteBtn();
setSnap('half');

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
