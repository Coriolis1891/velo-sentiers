/* Sentiers Vélo — signalements (passage difficile, obstacle, zone interdite…)
 *  - bouton ⚠️ en bas à droite pendant le guidage et l'enregistrement d'un trajet ;
 *  - signalements gardés sur la carte (2D et 3D) et rattachés aux sorties de l'historique ;
 *  - alerte vocale à l'approche d'un signalement situé sur le parcours suivi.
 * S'appuie sur les variables et fonctions globales de app.js, extras.js et rides.js.
 */
'use strict';

const REPORT_CATS = {
  hard: ['🚧', 'Passage difficile'],
  obstacle: ['🪨', 'Obstacle / objet'],
  forbidden: ['⛔', 'Zone interdite'],
  surface: ['🕳️', 'Mauvais revêtement'],
  mud: ['💧', 'Boue / inondé'],
  danger: ['⚠️', 'Danger'],
  other: ['📌', 'Autre problème'],
};
const repCat = (c) => REPORT_CATS[c] || REPORT_CATS.other;

let reports = store.get('reports', []);
const reportLayer = L.layerGroup().addTo(map);
const rideReportLayer = L.layerGroup().addTo(map); // signalements d'une ancienne sortie, supprimés depuis
const saveReports = () => { if (!store.set('reports', reports)) toast('Mémoire pleine : supprimez d’anciens signalements'); };

/* ------------------------------------------------------------------ */
/* Affichage sur la carte                                              */
/* ------------------------------------------------------------------ */
function reportPopup(rp, fromRide) {
  const [emoji, label] = repCat(rp.cat);
  const div = document.createElement('div'); div.className = 'ctx';
  const dfr = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  div.innerHTML = `<h4>${emoji} ${esc(label)}</h4><p>Signalé le ${dfr(rp.date)}${fromRide ? ' (ancienne sortie)' : ''}${rp.confirmed ? `<br>👍 Toujours là le ${dfr(rp.confirmed)}` : ''}</p>${rp.note ? `<p>${esc(rp.note)}</p>` : ''}`;
  if (!fromRide) {
    const edit = document.createElement('button'); edit.textContent = '✏️ Modifier la note';
    edit.addEventListener('click', () => {
      const n = prompt('Note du signalement', rp.note || '');
      if (n == null) return;
      rp.note = n.trim().slice(0, 200); saveReports(); renderReports(); map.closePopup();
    });
    const del = document.createElement('button'); del.textContent = '✅ Résolu / supprimer';
    del.addEventListener('click', () => {
      if (!confirm('Supprimer ce signalement de la carte ?')) return;
      reports = reports.filter((x) => x.id !== rp.id); saveReports(); renderReports(); map.closePopup();
    });
    div.append(edit, del);
  }
  return div;
}
const reportIcon = (rp) => L.divIcon({ className: 'pin report', html: `<span><b>${repCat(rp.cat)[0]}</b></span>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });

function renderReports() {
  reportLayer.clearLayers();
  reports.forEach((rp) => L.marker([rp.lat, rp.lng], { icon: reportIcon(rp), zIndexOffset: 300 }).bindPopup(() => reportPopup(rp)).addTo(reportLayer));
  const ul = $('#reportList');
  if (ul) {
    ul.innerHTML = reports.length ? '' : '<li class="empty">Aucun signalement. Pendant une sortie, touchez ⚠️ en bas à droite.</li>';
    reports.slice().sort((a, b) => b.date - a.date).forEach((rp) => {
      const [emoji, label] = repCat(rp.cat);
      const li = document.createElement('li');
      li.innerHTML = `<span>${emoji}</span><span class="grow"><b>${esc(label)}</b><small>${new Date(rp.date).toLocaleDateString('fr-FR')}${rp.note ? ' · ' + esc(rp.note) : ''}</small></span><button aria-label="Supprimer">🗑</button>`;
      li.querySelector('.grow').addEventListener('click', () => { map.setView([rp.lat, rp.lng], Math.max(map.getZoom(), 16)); if (!isDesktop()) setSnap('peek'); });
      li.querySelector('button').addEventListener('click', () => {
        if (!confirm(`Supprimer « ${label} » ?`)) return;
        reports = reports.filter((x) => x.id !== rp.id); saveReports(); renderReports();
      });
      ul.append(li);
    });
  }
  if (ml?.ready) reports3d(ml.map);
}

/** Vue 3D du guidage : on y affiche aussi les signalements. */
function reports3d(m) {
  (m.__reportMarkers || []).forEach((mk) => mk.remove());
  m.__reportMarkers = reports.map((rp) => {
    const el = document.createElement('div'); el.className = 'report3d'; el.textContent = repCat(rp.cat)[0];
    return new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([rp.lng, rp.lat]).addTo(m);
  });
}

/* ------------------------------------------------------------------ */
/* Bouton ⚠️ et fenêtre de signalement                                  */
/* ------------------------------------------------------------------ */
let reportAt = null;
function openReport(ll) {
  const here = meMarker?.getLatLng();
  reportAt = ll || here || map.getCenter();
  $('#reportWhere').textContent = ll ? 'À l’endroit touché sur la carte' : here ? 'À votre position actuelle' : 'Au centre de la carte (position GPS inconnue)';
  $('#reportNote').value = '';
  $('#reportDialog').showModal();
}
$('#reportCats').innerHTML = Object.entries(REPORT_CATS).map(([k, [e, l]]) => `<button value="${k}"><span>${e}</span>${l}</button>`).join('');
$('#reportDialog').addEventListener('close', () => {
  const cat = $('#reportDialog').returnValue;
  if (!REPORT_CATS[cat] || !reportAt) return;
  const rp = { id: uid(), lat: +reportAt.lat.toFixed(6), lng: +reportAt.lng.toFixed(6), cat, note: $('#reportNote').value.trim().slice(0, 200), date: Date.now() };
  reports.push(rp); saveReports(); renderReports();
  try { navigator.vibrate?.(80); } catch { /* */ }
  toast(`${repCat(cat)[0]} ${repCat(cat)[1]} signalé`, 3000);
});
$('#btnReport').addEventListener('click', () => openReport());

/** Le bouton ⚠️ n'apparaît que pendant le guidage ou l'enregistrement d'un trajet. */
function updateReportBtn() {
  const active = (typeof nav !== 'undefined' && nav.on) || (typeof rec !== 'undefined' && rec.on);
  $('#btnReport').hidden = !active;
  document.body.classList.toggle('recording', !!(rec?.on && !nav?.on));
}
setInterval(updateReportBtn, 1000);

/* ------------------------------------------------------------------ */
/* Liens avec le guidage, l'historique, le GPX et le partage            */
/* ------------------------------------------------------------------ */
/** Signalements situés sur le parcours (à moins de 40 m), avec leur position le long du tracé. */
let reportsAhead = [];
function reportsPrepare(r) {
  reportsAhead = [];
  if (!r || r.coords.length < 2) return;
  const all = [...reports, ...(r.rideReports || [])];
  for (const rp of all) {
    const pr = projectOnRoute(r, rp, null);
    if (pr.d < 40) reportsAhead.push({ ...rp, at: pr.along });
  }
}
function reportsOnNav(along) {
  for (const rp of reportsAhead) {
    const d = rp.at - along;
    const key = 'rp' + rp.id;
    if (d > 0 && d < 180 && !nav.announced.has(key)) {
      nav.announced.add(key);
      const [emoji, label] = repCat(rp.cat);
      speak(`Attention : ${label.toLowerCase()} signalé dans ${Math.max(10, Math.round(d / 10) * 10)} mètres.`);
      try { navigator.vibrate?.([300, 100, 300]); } catch { /* */ }
      toast(`${emoji} ${label} dans ${Math.round(d)} m${rp.note ? ' : ' + rp.note : ''}`, 5000);
    }
  }
}
/** Signalements faits pendant une sortie (rattachés à la sortie dans l'historique). */
function reportsBetween(t0, t1) {
  return reports.filter((rp) => rp.date >= t0 && rp.date <= t1 + 5000).map((rp) => ({ ...rp }));
}
/** Signalements proches d'un parcours (GPX, partage). */
function reportsNear(r, samples, maxD = 100) {
  return [...reports, ...(r.rideReports || [])].filter((rp) => nearestOnRoute(r, samples, rp).d < maxD);
}
/** Ouverture d'une ancienne sortie : on affiche ses signalements (même supprimés depuis de la carte). */
function showRideReports(it) {
  rideReportLayer.clearLayers();
  const list = it.reports || [];
  state.route.rideReports = list;
  list.filter((rp) => !reports.some((x) => x.id === rp.id))
    .forEach((rp) => L.marker([rp.lat, rp.lng], { icon: reportIcon(rp), opacity: 0.85 }).bindPopup(() => reportPopup(rp, true)).addTo(rideReportLayer));
  return list.length;
}

/* ------------------------------------------------------------------ */
/* « Toujours là ? » : quand on passe sur un signalement existant      */
/*  Non → supprimé ; Oui ou pas de réponse → conservé                  */
/* ------------------------------------------------------------------ */
let stillTimeoutMs = 25000;
const STILL_RADIUS = 35;       // mètres
const askedReports = new Set(); // une seule question par signalement et par session
let stillCurrent = null, stillTimer = null;

function closeStill() {
  clearTimeout(stillTimer); stillTimer = null; stillCurrent = null;
  $('#stillThere').hidden = true;
}
function askStillThere(rp) {
  stillCurrent = rp; askedReports.add(rp.id);
  const [emoji, label] = repCat(rp.cat);
  $('#stillEmoji').textContent = emoji;
  $('#stillText').textContent = `${label} signalé ici`;
  $('#stillInfo').textContent = `le ${new Date(rp.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}${rp.note ? ' · ' + rp.note : ''}`;
  $('#stillThere').hidden = false;
  // barre de temps restant
  const bar = $('#stillTimer');
  bar.style.transition = 'none'; bar.style.width = '100%';
  requestAnimationFrame(() => { bar.style.transition = `width ${stillTimeoutMs}ms linear`; bar.style.width = '0%'; });
  try { navigator.vibrate?.([150, 80, 150]); } catch { /* */ }
  if (typeof speak === 'function') speak(`${label} signalé ici. Toujours là ?`);
  stillTimer = setTimeout(closeStill, stillTimeoutMs); // pas de réponse : on garde le signalement
}
$('#stillYes').addEventListener('click', () => {
  const rp = stillCurrent; closeStill();
  if (!rp) return;
  const live = reports.find((x) => x.id === rp.id);
  if (live) { live.confirmed = Date.now(); saveReports(); renderReports(); }
  toast('Merci ! Signalement confirmé 👍');
});
$('#stillNo').addEventListener('click', () => {
  const rp = stillCurrent; closeStill();
  if (!rp) return;
  reports = reports.filter((x) => x.id !== rp.id); saveReports(); renderReports();
  reportsAhead = reportsAhead.filter((x) => x.id !== rp.id);
  toast('Merci ! Signalement retiré de la carte ✅');
});

/** Vérifie régulièrement si l'on passe sur un signalement (pendant le guidage ou l'enregistrement). */
function checkPassingReports() {
  const active = (typeof nav !== 'undefined' && nav.on) || (typeof rec !== 'undefined' && rec.on);
  if (!active) { if (stillCurrent) closeStill(); return; }
  if (stillCurrent || !meMarker) return;
  const here = meMarker.getLatLng(), now = Date.now();
  const rp = reports.find((x) => !askedReports.has(x.id)
    && now - x.date > 10 * 60e3                        // pas un signalement qu'on vient de créer
    && (!x.confirmed || now - x.confirmed > 10 * 60e3)
    && hav(here, x) < STILL_RADIUS);
  if (rp) askStillThere(rp);
}
setInterval(checkPassingReports, 2000);

renderReports();
updateReportBtn();
