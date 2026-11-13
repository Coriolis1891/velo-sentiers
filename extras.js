/* Sentiers Vélo — fonctions avancées :
 *  1. Navigation guidée virage par virage (voix, vibrations, recalcul hors itinéraire)
 *  2. Cartes hors ligne (Plan IGN le long du parcours)
 *  3. Partage de parcours par lien + import GPX
 * S'appuie sur les variables et fonctions globales de app.js.
 */
'use strict';

/* ================================================================== */
/* 1. Navigation guidée                                                */
/* ================================================================== */
// Codes de commande BRouter (btools.router.VoiceHint)
const NAV_CMD = {
  1: ['↑', 'Continuez tout droit'], 2: ['←', 'Tournez à gauche'], 3: ['↖', 'Serrez légèrement à gauche'],
  4: ['↙', 'Virage serré à gauche'], 5: ['→', 'Tournez à droite'], 6: ['↗', 'Serrez légèrement à droite'],
  7: ['↘', 'Virage serré à droite'], 8: ['↖', 'Restez à gauche'], 9: ['↗', 'Restez à droite'],
  10: ['↶', 'Faites demi-tour'], 11: ['↷', 'Faites demi-tour'], 13: ['⟳', 'Prenez le rond-point'],
  14: ['⟲', 'Prenez le rond-point'], 15: ['↶', 'Faites demi-tour'], 17: ['↖', 'Sortez à gauche'],
  18: ['↗', 'Sortez à droite'], 100: ['🏁', 'Vous arrivez à destination'],
};
const SILENT_CMDS = new Set([1, 12, 16]); // tout droit, hors route, ligne droite : pas d'annonce

function hintInfo(h) {
  const [arrow, text] = NAV_CMD[h.cmd] || NAV_CMD[1];
  if ((h.cmd === 13 || h.cmd === 14) && h.exit) return [arrow, `Au rond-point, prenez la ${h.exit === 1 ? '1re' : h.exit + 'e'} sortie`];
  return [arrow, text];
}
const fmtNavDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : m >= 100 ? Math.round(m / 10) * 10 + ' m' : Math.max(0, Math.round(m / 5) * 5) + ' m');
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

const nav = { on: false, mute: store.get('navMute', false), use3d: store.get('nav3d', true), watch: null, lock: null, bearing: 0 };

/* ------------------------------------------------------------------ */
/* Vue 3D (MapLibre, chargé uniquement quand on lance le guidage 3D)    */
/* ------------------------------------------------------------------ */
const MAPLIBRE = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl';
const DEM_TILE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'; // relief (données ouvertes AWS)
let ml = null; // { map, marker, ready }

function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  return new Promise((ok, ko) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = MAPLIBRE + '.css'; document.head.append(css);
    const js = document.createElement('script'); js.src = MAPLIBRE + '.js'; js.onload = ok; js.onerror = () => ko(new Error('chargement 3D impossible'));
    document.head.append(js);
  });
}
function webglOK() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}
function rasterFor3d() {
  const c = map.getCenter();
  const inFrance = c.lat > 41 && c.lat < 51.6 && c.lng > -5.6 && c.lng < 10;
  if (map.hasLayer(ignLayer) || !navigator.onLine || inFrance) return { tiles: [IGN_TILE], maxzoom: 18, attribution: '© IGN – Géoplateforme' };
  return { tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], maxzoom: 19, attribution: '© OpenStreetMap' };
}
function routeGeoJSON(r) {
  const col = COLORS();
  return {
    type: 'FeatureCollection',
    features: r.segs.map((sg) => ({
      type: 'Feature', properties: { color: col[sg.cat] || col.unk },
      geometry: { type: 'LineString', coordinates: r.coords.slice(sg.from, sg.to + 1).map((c) => [c[0], c[1]]) },
    })),
  };
}
async function open3d() {
  if (!webglOK()) throw new Error('WebGL indisponible');
  await loadMapLibre();
  const el = $('#map3d'); el.hidden = false;
  const r = state.route, ras = rasterFor3d();
  const c = meMarker ? meMarker.getLatLng() : { lat: r.coords[0][1], lng: r.coords[0][0] };
  const m = new maplibregl.Map({
    container: el,
    style: {
      version: 8,
      sources: { base: { type: 'raster', tiles: ras.tiles, tileSize: 256, maxzoom: ras.maxzoom, attribution: ras.attribution } },
      layers: [{ id: 'base', type: 'raster', source: 'base' }],
    },
    center: [c.lng, c.lat], zoom: 16.5, pitch: 62, bearing: nav.bearing, maxPitch: 75,
    attributionControl: { compact: true, customAttribution: 'Powered by <b>F.CHAZE</b>' },
  });
  const arrow = document.createElement('div');
  arrow.className = 'nav-arrow';
  arrow.innerHTML = '<svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" fill="#fff"/><path d="M22 7 L33 34 L22 28 L11 34 Z" fill="#2b6cb0"/></svg>';
  const marker = new maplibregl.Marker({ element: arrow, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([c.lng, c.lat]).addTo(m);
  ml = { map: m, marker, ready: false };
  m.on('load', () => {
    if (navigator.onLine) {
      try {
        m.addSource('dem', { type: 'raster-dem', tiles: [DEM_TILE], encoding: 'terrarium', tileSize: 256, maxzoom: 14 });
        m.setTerrain({ source: 'dem', exaggeration: 1.5 });
        m.addLayer({ id: 'hills', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#3a4a3c' } });
      } catch (e) { console.warn('Relief 3D indisponible', e); }
    }
    m.addSource('route', { type: 'geojson', data: routeGeoJSON(state.route) });
    m.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#fff', 'line-width': 12 } });
    m.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 7 } });
    ml.ready = true;
    m.on('zoomstart', (ev) => { if (ev.originalEvent) nav.manualUntil = Date.now() + 15000; }); // zoom aux doigts
    if (typeof reports3d === 'function') reports3d(m);
  });
}
function close3d() {
  if (ml) cancelAnimationFrame(ml.raf);
  try { ml?.map.remove(); } catch { /* */ }
  ml = null; $('#map3d').hidden = true;
}
function update3dRoute() { if (ml?.ready) ml.map.getSource('route')?.setData(routeGeoJSON(state.route)); }
function update3dCamera(p, bearing) {
  if (!ml) return;
  ml.marker.setLngLat([p.lng, p.lat]).setRotation(bearing);
  // Animation maison (jumpTo image par image) : avec le relief, easeTo réajuste l'inclinaison
  // et le zoom en fin de mouvement ; ici la caméra reste à 62° et le zoom suit la vitesse.
  const m = ml.map, from = m.getCenter(), b0 = m.getBearing(), z0 = m.getZoom();
  const z1 = navManualZoom() ? z0 : (nav.zoom3d || 17);
  const db = ((bearing - b0 + 540) % 360) - 180; // rotation par le plus court chemin
  const H = m.getContainer().clientHeight;
  const padding = { top: Math.round(H * 0.42), bottom: 30, left: 0, right: 0 }; // utilisateur dans le tiers bas
  const t0 = performance.now(), D = 800;
  cancelAnimationFrame(ml.raf);
  const step = (now) => {
    if (!ml) return;
    const k = Math.min(1, (now - t0) / D), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    m.jumpTo({ center: [from.lng + (p.lng - from.lng) * e, from.lat + (p.lat - from.lat) * e], bearing: b0 + db * e, pitch: 62, zoom: z0 + (z1 - z0) * e, padding });
    if (k < 1) ml.raf = requestAnimationFrame(step);
  };
  ml.raf = requestAnimationFrame(step);
}
async function set3d(on) {
  nav.use3d = on; store.set('nav3d', on);
  $('#nav3d').textContent = on ? '2D' : '3D';
  if (!nav.on) return;
  if (on) {
    try { await open3d(); if (nav.lastP) update3dCamera(nav.lastP, nav.bearing); }
    catch (e) { console.warn(e); close3d(); nav.use3d = false; $('#nav3d').textContent = '3D'; toast('Vue 3D indisponible sur cet appareil : guidage en 2D'); }
  } else close3d();
}
/** Cap (en degrés) du tracé à la distance d, mesuré sur les 30 m suivants. */
function routeBearing(r, d) {
  const a = pointAt(r, d), b = pointAt(r, Math.min(d + 30, r.cum[r.cum.length - 1]));
  if (hav(a, b) < 2) return nav.bearing;
  const φ1 = rad(a.lat), φ2 = rad(b.lat), Δλ = rad(b.lng - a.lng);
  return (deg(Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ))) + 360) % 360;
}
function pointAt(r, d) {
  const i = Math.max(1, idxAtDistance(r, d));
  const c0 = r.coords[i - 1], c1 = r.coords[i];
  const seg = r.cum[i] - r.cum[i - 1] || 1, t = Math.max(0, Math.min(1, (d - r.cum[i - 1]) / seg));
  return { lat: c0[1] + (c1[1] - c0[1]) * t, lng: c0[0] + (c1[0] - c0[0]) * t };
}
$('#nav3d').addEventListener('click', () => set3d(!nav.use3d));

function speak(text) {
  if (nav.mute || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR'; u.rate = 1.0;
    const v = speechSynthesis.getVoices().find((x) => /^fr/i.test(x.lang));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch { /* synthèse vocale indisponible */ }
}
const buzz = (p) => { try { navigator.vibrate?.(p); } catch { /* */ } };

/** Projette p sur le tracé (recherche locale autour de fromIdx, ou globale). */
function projectOnRoute(r, p, fromIdx) {
  const n = r.coords.length;
  const lo = fromIdx == null ? 0 : Math.max(0, fromIdx - 40);
  const hi = fromIdx == null ? n - 1 : Math.min(n - 1, fromIdx + 500);
  const kx = Math.cos(rad(p.lat)) * 111320, ky = 111320;
  let best = { d: Infinity, i: 0, along: 0 };
  for (let i = lo; i < hi; i++) {
    const a = r.coords[i], b = r.coords[i + 1];
    const ax = (a[0] - p.lng) * kx, ay = (a[1] - p.lat) * ky, bx = (b[0] - p.lng) * kx, by = (b[1] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
    if (d < best.d) best = { d, i, along: r.cum[i] + t * (r.cum[i + 1] - r.cum[i]) };
  }
  if (fromIdx != null && best.d > 150) return projectOnRoute(r, p, null); // grand saut : recherche globale
  return best;
}

function prepareNav(r) {
  nav.hints = (r.hints || []).filter((h) => !SILENT_CMDS.has(h[1]))
    .map(([idx, cmd, exit]) => ({ idx, cmd, exit, at: r.cum[Math.min(idx, r.cum.length - 1)] }));
  nav.hints.push({ idx: r.coords.length - 1, cmd: 100, exit: 0, at: r.cum[r.cum.length - 1] });
  nav.k = 0; nav.pi = null; nav.along = 0; nav.offCount = 0; nav.announced = new Set(); nav.offAnnounced = false;
  if (typeof reportsPrepare === 'function') reportsPrepare(r); // signalements situés sur le parcours
  // Position de chaque point de passage le long du tracé (pour le recalcul)
  const pts = r.pts || [];
  let from = null;
  nav.ptsAt = pts.map((q, k) => {
    if (k === 0) return 0;
    if (k === pts.length - 1) return r.cum[r.cum.length - 1];
    const pr = projectOnRoute(r, q, from); from = pr.i; return pr.along;
  });
}

async function startNav() {
  const r = state.route;
  if (!r) return;
  if (!navigator.geolocation) { toast('Géolocalisation non disponible sur cet appareil'); return; }
  if (state.follow) $('#btnFollow').click(); // le suivi simple est remplacé par la navigation
  prepareNav(r);
  nav.on = true;
  if (typeof ridesOnNavStart === 'function') ridesOnNavStart(); // la sortie est enregistrée dans l'historique
  document.body.classList.add('navigating');
  $('#nav').hidden = false; $('#navOff').hidden = true;
  $('#navArrow').textContent = '📡'; $('#navDist').textContent = 'Recherche GPS…'; $('#navText').textContent = 'Placez-vous sur le parcours';
  $('#navRemain').textContent = fmtKm(r.length);
  $('#navMute').textContent = nav.mute ? '🔇' : '🔊';
  $('#nav3d').textContent = nav.use3d ? '2D' : '3D';
  setSnap('peek');
  nav.lastP = null; nav.bearing = routeBearing(r, 0);
  nav.speed = null; nav.prevFix = null; nav.zoom3d = null; nav.zoom2d = null; nav.manualUntil = 0;
  if (nav.use3d) set3d(true);
  setTimeout(() => map.invalidateSize(), 300);
  speak(r.hints?.length ? 'Navigation démarrée.' : 'Navigation démarrée. Instructions de virage non disponibles pour ce parcours, suivez le tracé.');
  try { nav.lock = await navigator.wakeLock?.request('screen'); } catch { /* */ }
  nav.watch = navigator.geolocation.watchPosition(onNavPosition, (e) => {
    if (e.code === 1) { toast('Autorisez la localisation pour naviguer'); stopNav(); }
    else if (!nav.lastFix || Date.now() - nav.lastFix > 30000) $('#navDist').textContent = 'Signal GPS faible…';
  }, { enableHighAccuracy: true, maximumAge: 1000 });
}

function stopNav() {
  nav.on = false;
  if (typeof ridesOnNavStop === 'function') ridesOnNavStop();
  if (nav.watch != null) navigator.geolocation.clearWatch(nav.watch);
  nav.watch = null; nav.lock?.release?.(); nav.lock = null;
  try { speechSynthesis.cancel(); } catch { /* */ }
  document.body.classList.remove('navigating');
  $('#nav').hidden = true;
  close3d();
  setSnap('half');
  setTimeout(() => map.invalidateSize(), 300);
}

/* ------------------------------------------------------------------ */
/* Zoom automatique, comme un GPS : on se rapproche quand on ralentit   */
/* ou à l'approche d'un virage, on s'éloigne quand on roule vite.       */
/* ------------------------------------------------------------------ */
const navManualZoom = () => Date.now() < (nav.manualUntil || 0);
// Zoom aux doigts sur la carte 2D : le zoom automatique se met en pause 15 s
(() => {
  const el = map.getContainer();
  const pause = () => { if (nav.on) nav.manualUntil = Date.now() + 15000; };
  el.addEventListener('touchstart', (e) => { if (e.touches.length >= 2) pause(); }, { passive: true });
  el.addEventListener('wheel', pause, { passive: true });
  el.addEventListener('dblclick', pause);
})();

/** Vitesse lissée (m/s), donnée par le GPS ou calculée entre deux positions. */
function updateNavSpeed(pos, p) {
  let v = pos.coords.speed;
  const now = pos.timestamp || Date.now();
  if ((v == null || Number.isNaN(v)) && nav.prevFix) {
    const dt = (now - nav.prevFix.t) / 1000;
    if (dt > 0.5 && dt < 30) v = hav(nav.prevFix.p, p) / dt;
  }
  nav.prevFix = { p, t: now };
  if (v == null || Number.isNaN(v) || v < 0 || v > 25) return nav.speed || 0;
  nav.speed = nav.speed == null ? v : nav.speed * 0.6 + v * 0.4;
  return nav.speed;
}

/** Zooms cibles selon la vitesse (km/h) et la distance au prochain virage (m). */
function navZoomTargets(kmh, dTurn) {
  let z3 = kmh < 6 ? 17.8 : kmh < 12 ? 17.4 : kmh < 18 ? 17 : kmh < 25 ? 16.6 : 16.2; // 3D : progressif
  let z2 = kmh < 10 ? 18 : kmh < 22 ? 17 : 16;                                     // 2D : niveaux entiers (carte nette)
  if (dTurn < 90) { z3 = Math.max(z3, 17.6); z2 = Math.min(18, Math.max(z2, kmh > 22 ? 17 : 18)); } // virage proche
  return { z3, z2 };
}

function applyNavZoom(pos, p, dTurn) {
  const kmh = updateNavSpeed(pos, p) * 3.6;
  const { z3, z2 } = navZoomTargets(kmh, dTurn);
  // 3D : approche progressive de la cible
  nav.zoom3d = nav.zoom3d == null ? z3 : nav.zoom3d + (z3 - nav.zoom3d) * 0.45;
  // 2D : on change de niveau seulement si la cible est confirmée par deux positions de suite
  if (z2 === nav.z2cand) nav.z2count = (nav.z2count || 0) + 1; else { nav.z2cand = z2; nav.z2count = 1; }
  if (nav.zoom2d == null || (nav.z2count >= 2 && z2 !== nav.zoom2d)) nav.zoom2d = z2;
  nav.kmh = kmh;
}

function onNavPosition(pos) {
  if (!nav.on) return;
  const r = state.route;
  nav.lastFix = Date.now();
  const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  const ll = showMe(pos);
  const pr = projectOnRoute(r, p, nav.pi);
  const next = nav.hints?.[nav.k];
  applyNavZoom(pos, p, next ? next.at - pr.along : Infinity);
  if (navManualZoom()) map.panTo(ll, { animate: true });
  else map.setView(ll, nav.zoom2d, { animate: true });

  const tol = Math.max(35, Math.min(pos.coords.accuracy || 0, 80));
  if (pr.d > tol) {
    if (pos.coords.heading != null && !Number.isNaN(pos.coords.heading) && (pos.coords.speed || 0) > 1.5) nav.bearing = pos.coords.heading;
    nav.lastP = p; update3dCamera(p, nav.bearing);
    nav.offCount++;
    if (nav.offCount >= 3) {
      $('#navOff').hidden = false;
      $('#navOffDist').textContent = `à ${Math.round(pr.d)} m du tracé`;
      $('#navArrow').textContent = '⚠️'; $('#navDist').textContent = 'Rejoignez le tracé';
      if (!nav.offAnnounced) { nav.offAnnounced = true; speak('Vous avez quitté l’itinéraire.'); buzz([300, 150, 300]); }
    }
    return;
  }
  nav.offCount = 0; nav.offAnnounced = false; $('#navOff').hidden = true;
  nav.pi = pr.i; nav.along = pr.along;
  // Vue 3D : position recalée sur le tracé et carte orientée dans le sens de la marche
  nav.bearing = routeBearing(r, nav.along);
  nav.lastP = pointAt(r, nav.along);
  update3dCamera(nav.lastP, nav.bearing);

  while (nav.k < nav.hints.length - 1 && nav.hints[nav.k].at < nav.along - 8) nav.k++;
  const h = nav.hints[nav.k];
  const dist = h.at - nav.along;
  const [arrow, text] = hintInfo(h);
  $('#navArrow').textContent = arrow;
  $('#navDist').textContent = fmtNavDist(dist);
  $('#navText').textContent = text;
  const remain = r.cum[r.cum.length - 1] - nav.along;
  const eta = new Date(Date.now() + (remain / 1000 / SPEED[settings.bike]) * 3600e3);
  $('#navRemain').textContent = `Reste ${fmtKm(remain)} · arrivée vers ${eta.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  if (typeof reportsOnNav === 'function') reportsOnNav(nav.along); // alerte à l'approche d'un signalement

  // Annonces : une à ~150 m, une juste avant le virage
  if (h.cmd === 100) {
    if (dist < 30 && !nav.announced.has('end')) {
      nav.announced.add('end'); speak('Vous êtes arrivé. Bravo !'); buzz([200, 100, 200, 100, 400]);
      $('#navDist').textContent = 'Arrivé !';
      setTimeout(() => { if (nav.on) { stopNav(); toast('Parcours terminé 🎉', 5000); } }, 8000);
    } else if (dist < 160 && dist > 60 && !nav.announced.has('end-far')) {
      nav.announced.add('end-far'); speak(`Dans ${Math.round(dist / 10) * 10} mètres, vous arrivez à destination.`);
    }
    return;
  }
  const key = nav.k;
  if (dist <= 160 && dist > 60 && !nav.announced.has(key + 'f')) {
    nav.announced.add(key + 'f');
    speak(`Dans ${Math.round(dist / 10) * 10} mètres, ${lowerFirst(text)}.`);
  } else if (dist <= 35 && !nav.announced.has(key + 'n')) {
    nav.announced.add(key + 'n'); nav.announced.add(key + 'f');
    speak(text + '.'); buzz([200, 100, 200]);
  }
}

/** Recalcule depuis la position actuelle en repassant par les points de passage restants. */
async function rerouteFromHere() {
  const r = state.route;
  const pos = meMarker?.getLatLng();
  if (!pos) { toast('Position inconnue'); return; }
  if (!navigator.onLine) { toast('Pas de réseau : rejoignez le tracé pour continuer', 5000); return; }
  const pts = r.pts || [state.start, ...state.vias, state.mode === 'loop' ? state.start : state.end].filter(Boolean);
  const remaining = pts.filter((q, k) => k > 0 && (k === pts.length - 1 || (nav.ptsAt?.[k] ?? 0) > nav.along + 50));
  const signal = startOp('Recalcul de l’itinéraire…');
  try {
    const here = { lat: pos.lat, lng: pos.lng };
    const { gj } = await brouter([here, ...remaining], signal);
    const res = analyze(gj); res.pts = ptsOf([here, ...remaining]);
    state.route = res; tmp.set('route', res);
    showRoute(res, false); setSnap('peek');
    prepareNav(res);
    update3dRoute();
    $('#navOff').hidden = true;
    speak('Nouvel itinéraire calculé.');
  } catch (e) {
    if (!signal.aborted) toast(e instanceof RouteError ? humanError(e.message) : 'Recalcul impossible (réseau ?)', 5000);
  } finally { endOp(signal); }
}

$('#btnNav').addEventListener('click', startNav);
$('#btnFootNav').addEventListener('click', startNav);

/** Feuille de route : liste des virages avec leur kilomètre (touchez-en un pour le voir sur la carte). */
function renderRoadbook(r) {
  const box = $('#roadbook'), ol = $('#roadbookList');
  const hints = (r.hints || []).filter((h) => !SILENT_CMDS.has(h[1]));
  box.hidden = !hints.length;
  if (!hints.length) return;
  ol.innerHTML = '';
  const rows = hints.map(([idx, cmd, exit]) => ({ idx, cmd, exit, at: r.cum[Math.min(idx, r.cum.length - 1)] }));
  rows.push({ idx: r.coords.length - 1, cmd: 100, exit: 0, at: r.cum[r.cum.length - 1] });
  rows.forEach((h) => {
    const [arrow, text] = hintInfo(h);
    const li = document.createElement('li');
    li.innerHTML = `<span class="ar">${arrow}</span><span class="grow">${esc(text)}</span><span class="km">${(h.at / 1000).toFixed(1).replace('.', ',')} km</span>`;
    li.addEventListener('click', () => {
      const c = r.coords[h.idx];
      map.setView([c[1], c[0]], 17);
      L.popup({ closeButton: true }).setLatLng([c[1], c[0]]).setContent(`<b>${arrow} ${esc(text)}</b><br>au km ${(h.at / 1000).toFixed(1).replace('.', ',')}`).openOn(map);
      if (!isDesktop()) setSnap('peek');
    });
    ol.append(li);
  });
  $('#roadbookCount').textContent = `${rows.length - 1} indication(s)`;
}
$('#navStop').addEventListener('click', () => { stopNav(); toast('Navigation arrêtée'); });
$('#navReroute').addEventListener('click', rerouteFromHere);
$('#navMute').addEventListener('click', () => {
  nav.mute = !nav.mute; store.set('navMute', nav.mute);
  $('#navMute').textContent = nav.mute ? '🔇' : '🔊';
  if (nav.mute) { try { speechSynthesis.cancel(); } catch { /* */ } } else speak('Voix activée');
});

/* ================================================================== */
/* 2. Cartes hors ligne (Plan IGN, licence ouverte)                     */
/* ================================================================== */
const OFF_ZMIN = 11, OFF_ZMAX = 16, AVG_TILE_KB = 45;
const tileUrl = (z, x, y) => IGN_TILE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
function lngToX(lng, z) { return Math.floor(((lng + 180) / 360) * 2 ** z); }
function latToY(lat, z) { const r = rad(lat); return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); }

/** Tuiles couvrant un couloir de padM mètres autour du parcours, de OFF_ZMIN à OFF_ZMAX. */
function tilesForRoute(r, padM = 300) {
  const tiles = new Set();
  const idxs = sampleRoute(r, Math.max(20, Math.ceil(r.length / 100)));
  for (const i of idxs) {
    const [lng, lat] = r.coords[i];
    const dLat = padM / 111320, dLng = padM / (111320 * Math.cos(rad(lat)));
    for (let z = OFF_ZMIN; z <= OFF_ZMAX; z++) {
      const x0 = lngToX(lng - dLng, z), x1 = lngToX(lng + dLng, z), y0 = latToY(lat + dLat, z), y1 = latToY(lat - dLat, z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.add(`${z}/${x}/${y}`);
    }
  }
  return [...tiles];
}

async function downloadOffline() {
  const r = state.route;
  if (!r) return;
  if (!('caches' in window)) { toast('Le mode hors ligne n’est pas pris en charge par ce navigateur'); return; }
  const tiles = tilesForRoute(r);
  const mb = Math.round((tiles.length * AVG_TILE_KB) / 1024);
  if (tiles.length > 6000) { toast('Parcours trop long pour le hors ligne : découpez-le en plusieurs parties', 5000); return; }
  if (!confirm(`Télécharger les cartes (Plan IGN) le long de ce parcours ?\n\n${tiles.length} images, environ ${mb} Mo.\nIdéalement en Wi-Fi.`)) return;
  try { await navigator.storage?.persist?.(); } catch { /* */ }

  const id = uid();
  const cache = await caches.open('tiles-' + id);
  const signal = startOp('Téléchargement des cartes…');
  let done = 0, failed = 0, bytes = 0, i = 0;
  const worker = async () => {
    while (i < tiles.length && !signal.aborted) {
      const [z, x, y] = tiles[i++].split('/');
      const url = tileUrl(z, x, y);
      try {
        const res = await fetchT(url, { signal, mode: 'cors' }, 20000);
        if (!res.ok) throw new Error(res.status);
        const blob = await res.clone().blob(); bytes += blob.size;
        await cache.put(url, res);
      } catch (e) { if (signal.aborted) return; failed++; }
      done++;
      if (done % 5 === 0 || done === tiles.length) busy(true, `Téléchargement des cartes… ${Math.round((100 * done) / tiles.length)} % (${done}/${tiles.length})`);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (signal.aborted) { await caches.delete('tiles-' + id); return; }
    if (failed > tiles.length * 0.2) {
      await caches.delete('tiles-' + id);
      toast('Téléchargement incomplet (réseau instable). Réessayez.', 5000); return;
    }
    const packs = store.get('packs', []);
    packs.unshift({ id, name: routeName(), tiles: tiles.length - failed, bytes, date: Date.now() });
    store.set('packs', packs);
    // Garde aussi le parcours lui-même, utilisable sans réseau
    const list = store.get('routes', []);
    if (!list.some((x) => x.route === r || (x.route.length === r.length && x.route.coords.length === r.coords.length))) {
      list.unshift({ id: uid(), name: routeName() + ' (hors ligne)', date: Date.now(), mode: state.mode, start: state.start, end: state.end, vias: state.vias, settings: { ...settings }, route: r });
      store.set('routes', list);
    }
    map.eachLayer((l) => { if (l instanceof L.TileLayer && l !== ignLayer) map.removeLayer(l); });
    ignLayer.addTo(map); store.set('layer', 'Plan IGN (France, hors ligne)');
    toast(`Cartes prêtes hors ligne (${(bytes / 1048576).toFixed(0)} Mo). Fond « Plan IGN » activé.`, 6000);
    renderPacks();
  } finally { endOp(signal); }
}
$('#btnOffline').addEventListener('click', downloadOffline);

async function renderPacks() {
  const ul = $('#packList'); if (!ul) return;
  const packs = store.get('packs', []);
  ul.innerHTML = packs.length ? '' : '<li class="empty">Aucune carte téléchargée. Ouvrez un parcours puis « 📥 Hors ligne ».</li>';
  packs.forEach((pk) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>🗺️</span><span class="grow"><b>${esc(pk.name)}</b><small>${pk.tiles} images · ${(pk.bytes / 1048576).toFixed(1).replace('.', ',')} Mo · ${new Date(pk.date).toLocaleDateString('fr-FR')}</small></span><button aria-label="Supprimer">🗑</button>`;
    li.querySelector('button').addEventListener('click', async () => {
      if (!confirm(`Supprimer les cartes hors ligne « ${pk.name} » ?`)) return;
      await caches.delete('tiles-' + pk.id);
      store.set('packs', store.get('packs', []).filter((x) => x.id !== pk.id)); renderPacks();
    });
    ul.append(li);
  });
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('#storageInfo').textContent = `Espace utilisé par l’application : ${(est.usage / 1048576).toFixed(0)} Mo`;
  } catch { /* */ }
}

// Hors connexion : on n'affiche que les niveaux de zoom téléchargés
function applyNetworkMode() {
  const offline = !navigator.onLine;
  ignLayer.options.maxNativeZoom = offline ? OFF_ZMAX : 18;
  if (map.hasLayer(ignLayer)) ignLayer.redraw();
  $('#offlineBadge').hidden = !offline;
  if (offline && !map.hasLayer(ignLayer) && store.get('packs', []).length) {
    map.eachLayer((l) => { if (l instanceof L.TileLayer) map.removeLayer(l); });
    ignLayer.addTo(map);
  }
}
addEventListener('online', applyNetworkMode);
addEventListener('offline', applyNetworkMode);

/* ================================================================== */
/* 3. Partage de parcours                                              */
/* ================================================================== */
const b64u = (bytes) => { let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4)), (c) => c.charCodeAt(0));

async function packShare(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if ('CompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return 'z' + b64u(new Uint8Array(await new Response(stream).arrayBuffer()));
  }
  return 'j' + b64u(bytes);
}
async function unpackShare(str) {
  const bytes = unb64u(str.slice(1));
  let text;
  if (str[0] === 'z') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    text = await new Response(stream).text();
  } else text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

async function shareRoute() {
  const r = state.route;
  if (!r) return;
  if (!r.pts || r.pts.length < 2) { // trace importée : on partage le fichier GPX
    $('#btnGpx').click(); return;
  }
  const samples = sampleRoute(r, 400);
  const pois = state.myPois.filter((p) => nearestOnRoute(r, samples, p).d < 500).slice(0, 30)
    .map((p) => [+p.lat.toFixed(5), +p.lng.toFixed(5), p.name, p.cat, (p.note || '').slice(0, 200)]);
  if (typeof reportsNear === 'function') reportsNear(r, samples).slice(0, 30).forEach((rp) => pois.push([+rp.lat.toFixed(5), +rp.lng.toFixed(5), `${repCat(rp.cat)[0]} ${repCat(rp.cat)[1]}`, 'warn', (rp.note || '').slice(0, 200)]));
  const name = routeName();
  const obj = {
    v: 1, n: name, m: state.mode, km: Math.round(r.length / 100) / 10, auto: state.mode === 'loop' && !state.vias.some((v) => !v.auto) ? 1 : 0,
    p: r.pts.map((q) => [+q.lat.toFixed(5), +q.lng.toFixed(5)]),
    lb: [state.start?.label || '', state.mode === 'ab' ? state.end?.label || '' : ''],
    s: { avoid: settings.avoid, optim: settings.optim, bike: settings.bike, hills: settings.hills, forest: settings.forest },
    poi: pois,
  };
  const url = `${location.origin}${location.pathname}#p=${await packShare(obj)}`;
  const text = `🚴 ${name} – ${fmtKm(r.length)}, ${r.ascend} m D+${pois.length ? `, ${pois.length} point(s) d’intérêt` : ''}`;
  if (navigator.share) {
    try { await navigator.share({ title: name, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Lien copié : collez-le dans un message à vos amis', 5000); }
  catch { prompt('Copiez ce lien et envoyez-le :', url); }
}
$('#btnShare').addEventListener('click', shareRoute);

let pendingShare = null;
async function handleShareLink() {
  const m = /^#p=([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const o = await unpackShare(m[1]);
    if (o.v !== 1 || !Array.isArray(o.p) || o.p.length < 2) throw new Error('format');
    pendingShare = o;
    $('#shareTitle').textContent = o.n || 'Parcours partagé';
    $('#shareInfo').textContent = [o.m === 'loop' ? 'Boucle' : 'Aller simple', o.km && `${String(o.km).replace('.', ',')} km`, o.poi?.length && `${o.poi.length} point(s) d’intérêt`].filter(Boolean).join(' · ');
    $('#shareDialog').showModal();
  } catch (e) { console.warn(e); toast('Lien de partage invalide ou incomplet', 5000); }
}
$('#shareDialog').addEventListener('close', () => {
  const o = pendingShare; pendingShare = null;
  if (!o || $('#shareDialog').returnValue !== 'open') return;
  const P = o.p.map(([lat, lng]) => ({ lat, lng }));
  if (nav.on) stopNav();
  Object.assign(settings, o.s || {});
  if (!o.s?.optim && !o.s?.prio) settings.optim = 'balade';
  applySettingsToUI();
  setMode(o.m === 'loop' ? 'loop' : 'ab');
  state.start = { ...P[0], label: o.lb?.[0] || 'Départ' };
  if (o.m === 'loop') { state.end = null; state.vias = P.slice(1, -1).map((q, i) => ({ ...q, label: `Point de la boucle ${i + 1}`, auto: !!o.auto })); }
  else { state.end = { ...P[P.length - 1], label: o.lb?.[1] || 'Arrivée' }; state.vias = P.slice(1, -1).map((q, i) => ({ ...q, label: `Étape ${i + 1}` })); }
  renderPoints(); saveSession(); showTab('route');
  state.suggested = (o.poi || []).map(([lat, lng, name, cat, note], i) => ({
    id: 'shared' + i, lat, lng, name, cat: 'shared', myCat: MY_CATS[cat] ? cat : 'other',
    kind: `Partagé par un ami${MY_CATS[cat] ? ' · ' + MY_CATS[cat][1] : ''}`, t: { description: note },
  }));
  renderSuggestions();
  computeRoute();
});
addEventListener('hashchange', handleShareLink);

/* Import d'un fichier GPX (Komoot, Strava, Garmin, ami…) */
$('#fileImportGpx').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const doc = new DOMParser().parseFromString(await f.text(), 'application/xml');
    let nodes = [...doc.getElementsByTagName('trkpt')];
    if (!nodes.length) nodes = [...doc.getElementsByTagName('rtept')];
    const c = nodes.map((n) => {
      const ele = n.getElementsByTagName('ele')[0];
      return [+(+n.getAttribute('lon')).toFixed(6), +(+n.getAttribute('lat')).toFixed(6), ele ? Math.round(+ele.textContent) : null];
    }).filter((x) => Number.isFinite(x[0]) && Number.isFinite(x[1]));
    if (c.length < 2) throw new Error('vide');
    const cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + hav(cll(c[i - 1]), cll(c[i])));
    let up = 0;
    for (let i = 1; i < c.length; i++) if (c[i][2] != null && c[i - 1][2] != null && c[i][2] - c[i - 1][2] > 0) up += c[i][2] - c[i - 1][2];
    const length = cum[cum.length - 1];
    const r = { coords: c, cum, segs: [{ cat: 'unk', from: 0, to: c.length - 1 }], dist: { off: 0, calm: 0, road: 0, unk: length }, length, ascend: Math.round(up * 0.8), hints: [] };
    const gpxName = doc.getElementsByTagName('name')[0]?.textContent?.trim() || f.name.replace(/\.gpx$/i, '');
    if (nav.on) stopNav();
    const isLoop = hav(cll(c[0]), cll(c[c.length - 1])) < 300;
    setMode(isLoop ? 'loop' : 'ab');
    state.start = { lat: c[0][1], lng: c[0][0], label: gpxName + ' (départ)' };
    state.end = isLoop ? null : { lat: c[c.length - 1][1], lng: c[c.length - 1][0], label: gpxName + ' (arrivée)' };
    state.vias = [];
    state.route = r; tmp.set('route', r);
    renderPoints(); saveSession(); showTab('route'); showRoute(r, true);
    $('#routeNote').textContent = 'Trace GPX importée : pas d’instructions de virage, la navigation vous guide le long du tracé. Déplacer un point recalcule un nouvel itinéraire.';
    const list = store.get('routes', []);
    list.unshift({ id: uid(), name: gpxName, date: Date.now(), mode: state.mode, start: state.start, end: state.end, vias: [], settings: { ...settings }, route: r });
    store.set('routes', list);
    toast('Trace importée et ajoutée à « Mes parcours »');
  } catch (err) { console.warn(err); toast('Fichier GPX illisible'); }
});

/* ------------------------------------------------------------------ */
/* Démarrage                                                           */
/* ------------------------------------------------------------------ */
document.querySelector('.tabs button[data-tab=saved]').addEventListener('click', renderPacks);
applyNetworkMode();
if (state.route) renderRoadbook(state.route);
handleShareLink();
