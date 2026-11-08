/* Sentiers Vélo — trajets enregistrés au GPS
 *  - « Créer un trajet » : on enregistre sa sortie, « Terminer » la range dans « Mes créations » ;
 *  - Historique : chaque sortie faite avec le guidage (ou enregistrée) est gardée automatiquement.
 * S'appuie sur les variables et fonctions globales de app.js et extras.js.
 */
'use strict';

const HISTORY_MAX = 40;
const REC_KEY = 'recording'; // enregistrement en cours (survit à une fermeture de l'application)

/* ------------------------------------------------------------------ */
/* Outils                                                              */
/* ------------------------------------------------------------------ */
const fmtClock = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const fmtSpeed = (m, s) => (s > 30 ? `${((m / 1000) / (s / 3600)).toFixed(1).replace('.', ',')} km/h` : '–');
const fmtDate = (t) => new Date(t).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Simplifie une trace (Douglas-Peucker, tolérance en mètres) pour économiser la mémoire. */
function simplifyTrack(pts, tol = 4) {
  if (pts.length < 3) return pts;
  const lat0 = rad(pts[0][1]), kx = Math.cos(lat0) * 111320, ky = 111320;
  const xy = pts.map((p) => [p[0] * kx, p[1] * ky]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > fd) { fd = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Transforme une trace [[lon, lat, alt], …] en parcours affichable (comme un import GPX). */
function trackToRoute(c, up) {
  const coords = c.map((p) => [p[0], p[1], p[2] == null ? null : Math.round(p[2])]);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + hav(cll(coords[i - 1]), cll(coords[i])));
  const length = cum[cum.length - 1];
  return { coords, cum, segs: [{ cat: 'unk', from: 0, to: coords.length - 1 }], dist: { off: 0, calm: 0, road: 0, unk: length }, length, ascend: Math.round(up || 0), hints: [] };
}

/** Enregistre dans une liste (création ou historique) ; si la mémoire est pleine, on retire les plus anciennes sorties de l'historique. */
function pushItem(key, item, max) {
  let list = store.get(key, []);
  list.unshift(item);
  if (max) list = list.slice(0, max);
  while (!store.set(key, list)) {
    const hist = store.get('history', []);
    if (key === 'history' && list.length > 1) { list.pop(); continue; }
    if (key !== 'history' && hist.length) { hist.pop(); store.set('history', hist); continue; }
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Enregistreur GPS                                                    */
/* ------------------------------------------------------------------ */
const rec = {
  on: false, paused: false, kind: null, // 'manual' (Créer un trajet) | 'nav' (guidage)
  pts: [], dist: 0, moving: 0, elapsed: 0, up: 0, altRef: null, t0: 0, lastT: 0, last: null,
  planned: null, watch: null, timer: null, lock: null, line: null,
};

function recPersist() {
  if (!rec.on) return;
  store.set(REC_KEY, { kind: rec.kind, pts: rec.pts, dist: rec.dist, moving: rec.moving, elapsed: rec.elapsed, up: rec.up, t0: rec.t0, planned: rec.planned, saved: Date.now() });
}

function onRecPosition(pos) {
  if (!rec.on) return;
  const c = pos.coords, now = pos.timestamp || Date.now();
  if (rec.kind === 'manual' && !nav.on) { const ll = showMe(pos); map.panTo(ll, { animate: true }); }
  if (rec.paused) { rec.last = null; return; }
  if (c.accuracy > 35 && rec.pts.length) return; // position trop imprécise
  const p = [+c.longitude.toFixed(6), +c.latitude.toFixed(6), c.altitude == null ? null : +c.altitude.toFixed(1)];
  if (rec.last) {
    const d = hav(cll(rec.last), cll(p)), dt = (now - rec.lastT) / 1000;
    if (d < 6) return; // immobile : on n'ajoute pas de point
    if (dt > 0 && d / dt > 25) return; // saut aberrant (> 90 km/h)
    rec.dist += d;
    if (dt < 60 && d / dt > 0.5) rec.moving += dt; // temps en mouvement
  }
  // Dénivelé positif : on ne compte une montée qu'au-delà de 4 m (le GPS est bruité en altitude)
  if (p[2] != null && (c.altitudeAccuracy == null || c.altitudeAccuracy < 25)) {
    if (rec.altRef == null) rec.altRef = p[2];
    else if (p[2] - rec.altRef > 4) { rec.up += p[2] - rec.altRef; rec.altRef = p[2]; }
    else if (rec.altRef - p[2] > 4) rec.altRef = p[2];
  }
  rec.pts.push(p); rec.last = p; rec.lastT = now;
  rec.line?.addLatLng([p[1], p[0]]);
  if (rec.pts.length % 5 === 0) recPersist();
  renderRecBar();
}

function renderRecBar() {
  if (!rec.on) return;
  const el = rec.elapsed + (rec.paused ? 0 : (Date.now() - rec.resumedAt) / 1000);
  $('#recDist').textContent = rec.dist < 1000 ? `${Math.round(rec.dist)} m` : fmtKm(rec.dist);
  $('#recTime').textContent = fmtClock(el);
  $('#recSpeed').textContent = fmtSpeed(rec.dist, rec.moving);
  $('#recTitle').textContent = rec.paused ? 'En pause' : 'Enregistrement en cours';
  $('#recBar').classList.toggle('paused', rec.paused);
}

async function recStart(kind, restore) {
  if (rec.on) return;
  if (!navigator.geolocation) { toast('Géolocalisation non disponible sur cet appareil'); return; }
  Object.assign(rec, { on: true, paused: false, kind, pts: [], dist: 0, moving: 0, elapsed: 0, up: 0, altRef: null, t0: Date.now(), last: null, planned: null }, restore || {});
  rec.resumedAt = Date.now();
  rec.line = L.polyline(rec.pts.map((p) => [p[1], p[0]]), { color: '#d64545', weight: 5, opacity: 0.9, interactive: false }).addTo(map);
  rec.watch = navigator.geolocation.watchPosition(onRecPosition, (e) => {
    // Refus d'autorisation dès le départ : on annule. Plus tard (application en arrière-plan,
    // page qui se ferme…), on garde l'enregistrement : il pourra être repris.
    if (e.code === 1 && !rec.pts.length && document.visibilityState === 'visible') { toast('Autorisez la localisation pour enregistrer un trajet'); recCancel(); }
  }, { enableHighAccuracy: true, maximumAge: 1000 });
  rec.timer = setInterval(() => { renderRecBar(); if (Date.now() % 15000 < 1000) recPersist(); }, 1000);
  if (kind === 'manual') {
    $('#recBar').hidden = false; $('#btnRecord').classList.add('on');
    $('#btnRecord').title = 'Enregistrement en cours';
    try { rec.lock = await navigator.wakeLock?.request('screen'); } catch { /* */ }
    if (!isDesktop()) setSnap('peek');
    toast(restore ? 'Enregistrement repris' : 'C’est parti ! Gardez l’application ouverte pendant la sortie.', 4500);
  }
  recPersist(); renderRecBar();
}

function recTogglePause() {
  if (!rec.on) return;
  if (rec.paused) { rec.paused = false; rec.resumedAt = Date.now(); }
  else { rec.elapsed += (Date.now() - rec.resumedAt) / 1000; rec.paused = true; }
  $('#recPause').textContent = rec.paused ? '▶ Reprendre' : '⏸ Pause';
  recPersist(); renderRecBar();
}

/** Arrête l'enregistrement et renvoie la sortie (ou null si trop courte). */
function recFinish() {
  if (!rec.on) return null;
  if (!rec.paused) rec.elapsed += (Date.now() - rec.resumedAt) / 1000;
  const out = {
    kind: rec.kind, planned: rec.planned, t0: rec.t0,
    track: simplifyTrack(rec.pts).map((p) => [+p[0].toFixed(5), +p[1].toFixed(5), p[2] == null ? null : Math.round(p[2])]),
    stats: { dist: Math.round(rec.dist), moving: Math.round(rec.moving), elapsed: Math.round(rec.elapsed), up: Math.round(rec.up) },
  };
  recCancel();
  return out.track.length >= 2 && out.stats.dist >= 150 ? out : null;
}
function recCancel() {
  if (rec.watch != null) navigator.geolocation.clearWatch(rec.watch);
  clearInterval(rec.timer); rec.lock?.release?.(); rec.line?.remove();
  Object.assign(rec, { on: false, paused: false, watch: null, timer: null, lock: null, line: null, kind: null });
  try { localStorage.removeItem(REC_KEY); } catch { /* */ }
  $('#recBar').hidden = true; $('#btnRecord').classList.remove('on'); $('#recPause').textContent = '⏸ Pause';
  $('#btnRecord').title = 'Créer un trajet : enregistrer ma sortie au GPS';
}

addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') recPersist(); });
addEventListener('pagehide', recPersist);

const isLoopTrack = (t) => t.length > 2 && hav(cll(t[0]), cll(t[t.length - 1])) < 250;
function rideItem(r, name) {
  const reportsDone = typeof reportsBetween === 'function' ? reportsBetween(r.t0, Date.now()) : [];
  return { id: uid(), name, date: r.t0, kind: r.kind, planned: r.planned, track: r.track, stats: r.stats, loop: isLoopTrack(r.track), reports: reportsDone };
}
function addToHistory(r, name) {
  pushItem('history', rideItem(r, name), HISTORY_MAX);
  renderLibrary();
}

/* ------------------------------------------------------------------ */
/* « Créer un trajet » : démarrage, fin, enregistrement                 */
/* ------------------------------------------------------------------ */
let pendingRide = null;
function startManualRecording() {
  if (rec.on && rec.kind === 'manual') { showTab('route'); return; }
  if (rec.on && rec.kind === 'nav') { toast('Votre sortie guidée est déjà enregistrée automatiquement.'); return; }
  recStart('manual');
}
$('#btnRecord').addEventListener('click', () => (rec.on && rec.kind === 'manual' ? stopManualRecording() : startManualRecording()));
$('#btnRecordNew').addEventListener('click', startManualRecording);
$('#recPause').addEventListener('click', recTogglePause);
$('#recStop').addEventListener('click', () => stopManualRecording());

function stopManualRecording() {
  if (!rec.on) return;
  if (!confirm('Terminer l’enregistrement ?')) return;
  const r = recFinish();
  if (!r) { toast('Trajet trop court pour être enregistré'); return; }
  openRideDialog(r);
}
function openRideDialog(r) {
  pendingRide = r;
  const s = r.stats;
  $('#recSummary').innerHTML = `<div><b>${fmtKm(s.dist)}</b><small>distance</small></div><div><b>${fmtClock(s.elapsed)}</b><small>durée</small></div><div><b>${fmtSpeed(s.dist, s.moving)}</b><small>moyenne</small></div>`;
  $('#recName').value = `${isLoopTrack(r.track) ? 'Boucle' : 'Trajet'} du ${new Date(r.t0).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
  $('#recDialog').showModal();
}
$('#recDialog').addEventListener('close', () => {
  const r = pendingRide; pendingRide = null;
  if (!r) return;
  if ($('#recDialog').returnValue !== 'save') { toast('Trajet supprimé'); return; }
  const name = $('#recName').value.trim() || 'Mon trajet';
  const item = rideItem(r, name);
  if (!pushItem('creations', item)) { toast('Mémoire pleine : supprimez d’anciens trajets'); return; }
  addToHistory(r, name);
  showLibrary('created');
  openRide(item);
  toast('Trajet ajouté à « Mes créations » ✏️', 4000);
});

/* Guidage : la sortie est enregistrée d'office dans l'historique */
function ridesOnNavStart() {
  if (rec.on) return; // un enregistrement manuel est déjà en cours
  recStart('nav').then(() => { rec.planned = state.route ? routeName() : null; });
}
function ridesOnNavStop() {
  if (!rec.on || rec.kind !== 'nav') return;
  const planned = rec.planned;
  const r = recFinish();
  if (!r) return;
  addToHistory(r, planned ? `Sortie : ${planned}` : 'Sortie guidée');
  toast('Sortie enregistrée dans « Historique » 🕓', 4000);
}

/* ------------------------------------------------------------------ */
/* Bibliothèque : Enregistrés / Créations / Historique                  */
/* ------------------------------------------------------------------ */
function showLibrary(which) {
  showTab('saved');
  document.querySelectorAll('#libSeg button').forEach((b) => b.classList.toggle('active', b.dataset.lib === which));
  ['saved', 'created', 'history'].forEach((k) => { $('#lib-' + k).hidden = k !== which; });
  store.set('libTab', which);
  renderLibrary();
}
document.querySelectorAll('#libSeg button').forEach((b) => b.addEventListener('click', () => showLibrary(b.dataset.lib)));

/** Affiche un trajet enregistré au GPS comme parcours courant (refaisable en guidage). */
function openRide(it) {
  const r = trackToRoute(it.track, it.stats?.up);
  if (nav.on) stopNav();
  const c = it.track;
  setMode(it.loop ? 'loop' : 'ab');
  state.start = { lat: c[0][1], lng: c[0][0], label: `${it.name} (départ)` };
  state.end = it.loop ? null : { lat: c[c.length - 1][1], lng: c[c.length - 1][0], label: `${it.name} (arrivée)` };
  state.vias = [];
  state.route = r; tmp.set('route', r);
  renderPoints(); saveSession(); showTab('route'); showRoute(r, true);
  $('#resTitle').textContent = it.name;
  $('#resPrio').textContent = it.kind === 'manual' ? '✏️ Ma création' : '🕓 Sortie';
  if (it.stats) {
    $('#stTime').textContent = fmtClock(it.stats.elapsed);
    $('#miniStats').textContent = `${fmtKm(it.stats.dist)} · ${fmtClock(it.stats.elapsed)} · ${fmtSpeed(it.stats.dist, it.stats.moving)}`;
  }
  const nRep = typeof showRideReports === 'function' ? showRideReports(it) : 0;
  $('#routeNote').textContent = (nRep ? `⚠️ ${nRep} signalement(s) fait(s) pendant cette sortie, affichés sur la carte. ` : '') + 'Trajet enregistré au GPS : « 🧭 Démarrer le guidage » pour le refaire (le guidage suit le tracé et vous alerte si vous vous en écartez), « ⬇️ GPX » pour l’exporter.';
}

function renderRideList(key, ul, emptyMsg) {
  const list = store.get(key, []);
  ul.innerHTML = list.length ? '' : `<li class="empty">${emptyMsg}</li>`;
  list.forEach((it) => {
    const s = it.stats || {};
    const li = document.createElement('li');
    li.innerHTML = `<span>${it.loop ? '↻' : '→'}</span><span class="grow"><b>${esc(it.name)}</b>
      <small>${fmtDate(it.date)} · ${fmtKm(s.dist || 0)} · ${fmtClock(s.elapsed || 0)} · ${fmtSpeed(s.dist, s.moving)}${s.up ? ` · ${s.up} m D+` : ''}${it.reports?.length ? ` · ⚠️ ${it.reports.length}` : ''}</small></span>
      ${key === 'history' ? '<button class="keep" aria-label="Copier dans Mes créations" title="Copier dans Mes créations">✏️</button>' : ''}
      <button class="del" aria-label="Supprimer">🗑</button>`;
    li.querySelector('.grow').addEventListener('click', () => openRide(it));
    li.querySelector('.keep')?.addEventListener('click', () => {
      const copy = { ...it, id: uid(), kind: 'manual', name: it.name.replace(/^Sortie : /, '') };
      if (pushItem('creations', copy)) { toast('Copié dans « Mes créations »'); renderLibrary(); }
    });
    li.querySelector('.del').addEventListener('click', () => {
      if (!confirm(`Supprimer « ${it.name} » ?`)) return;
      store.set(key, store.get(key, []).filter((x) => x.id !== it.id)); renderLibrary();
    });
    ul.append(li);
  });
  return list.length;
}
function renderLibrary() {
  const nC = renderRideList('creations', $('#createdList'), 'Aucune création. Appuyez sur « ⏺ Créer un trajet » avant votre sortie.');
  const nH = renderRideList('history', $('#historyList'), 'Aucune sortie pour l’instant. Démarrez un guidage ou enregistrez un trajet.');
  const nS = store.get('routes', []).length;
  $('#cntSaved').textContent = nS ? `(${nS})` : '';
  $('#cntCreated').textContent = nC ? `(${nC})` : '';
  $('#cntHistory').textContent = nH ? `(${nH})` : '';
}
document.querySelector('.tabs button[data-tab=saved]').addEventListener('click', () => {
  const which = store.get('libTab', 'saved');
  document.querySelectorAll('#libSeg button').forEach((b) => b.classList.toggle('active', b.dataset.lib === which));
  ['saved', 'created', 'history'].forEach((k) => { $('#lib-' + k).hidden = k !== which; });
  renderLibrary();
});

/* ------------------------------------------------------------------ */
/* Reprise d'un enregistrement interrompu (application fermée…)         */
/* ------------------------------------------------------------------ */
(() => {
  const saved = store.get(REC_KEY, null);
  if (!saved || !saved.pts?.length) { try { localStorage.removeItem(REC_KEY); } catch { /* */ } return; }
  const age = (Date.now() - saved.saved) / 3600e3;
  $('#recResumeInfo').textContent = `${saved.kind === 'nav' ? 'Une sortie guidée' : 'Un trajet'} commencé le ${fmtDate(saved.t0)} (${fmtKm(saved.dist)}) n'a pas été terminé.`;
  const dlg = $('#recResume');
  dlg.addEventListener('close', () => {
    const v = dlg.returnValue;
    if (v === 'resume' && age < 12) { recStart('manual', { pts: saved.pts, dist: saved.dist, moving: saved.moving, elapsed: saved.elapsed, up: saved.up, t0: saved.t0, last: null }); return; }
    // Terminer : on reconstruit la sortie à partir de ce qui a été sauvegardé
    Object.assign(rec, { on: true, paused: true, kind: saved.kind, pts: saved.pts, dist: saved.dist, moving: saved.moving, elapsed: saved.elapsed, up: saved.up, t0: saved.t0, planned: saved.planned });
    const r = recFinish();
    if (v === 'discard' || !r) { toast(v === 'discard' ? 'Enregistrement supprimé' : 'Trajet trop court, non enregistré'); return; }
    if (saved.kind === 'nav') { addToHistory(r, saved.planned ? `Sortie : ${saved.planned}` : 'Sortie guidée'); toast('Sortie ajoutée à « Historique »'); }
    else openRideDialog(r);
  }, { once: true });
  if (age >= 12) dlg.querySelector('button[value=resume]').hidden = true;
  dlg.showModal();
})();
