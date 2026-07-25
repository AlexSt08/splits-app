"use strict";

/* ============================================================
   SPLITS — suivi de course personnel (PWA)
   Stockage local : localStorage. Sync optionnelle : Supabase.
   ============================================================ */

const STORAGE_KEY = "splits.runs.v1";
const GOAL_KEY = "splits.weeklyGoalKm.v1";
const LAST_SYNC_KEY = "splits.lastSync.v1";
const DEFAULT_GOAL_KM = 20;

const MIN_ACCURACY_M = 30;      // ignore les points trop imprécis
const MIN_STEP_M = 3;           // ignore le bruit GPS sous ce seuil

const SUPABASE_URL = "https://fyuvconzpqglvhufixzv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_YFi6gTCa6b6i5APTxMT6vg_x06ofpEr";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ---------- state ----------
let runs = loadRuns();
let weeklyGoal = Number(localStorage.getItem(GOAL_KEY)) || DEFAULT_GOAL_KM;
let currentUser = null;
let syncing = false;

let tracking = {
  active: false,
  paused: false,
  watchId: null,
  startTime: null,
  elapsedBeforePause: 0,
  path: [],           // {lat, lng, t, accuracy}
  distanceM: 0,
  splits: [],          // {km: 1, seconds: ...}
  lastSplitDistanceM: 0,
  lastSplitTime: null,
  clockInterval: null,
  map: null,
  polyline: null,
  marker: null,
  wakeLock: null,
  screenLocked: false,
};

// ---------- persistence ----------
function loadRuns() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
function saveRuns() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
}

// ---------- helpers ----------
function haversineM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s1));
}

function fmtKm(m, decimals = 2) {
  return (m / 1000).toFixed(decimals).replace(".", ",");
}
function fmtClock(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function fmtDurationShort(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.round((totalSec % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}`;
  return `${m} min`;
}
function fmtPace(secPerKm) {
  if (!isFinite(secPerKm) || secPerKm <= 0) return "—'—\"";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}'${String(s).padStart(2, "0")}"`;
}
function fmtDateShort(iso) {
  const d = new Date(iso);
  const days = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
  return `${days[d.getDay()]}\n${d.getDate()}/${d.getMonth() + 1}`;
}
function fmtDateFull(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------- navigation ----------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.remove("active"));
  if (id === "screen-home") document.querySelector(".tab-home").classList.add("active");
  if (id === "screen-history") document.querySelector(".tab-history").classList.add("active");
}

document.querySelectorAll(".tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (tracking.active) return; // pas de navigation pendant une course
    showScreen(btn.dataset.tab === "home" ? "screen-home" : "screen-history");
    if (btn.dataset.tab === "history") renderHistory();
  });
});
document.getElementById("btn-see-all").addEventListener("click", () => {
  showScreen("screen-history");
  renderHistory();
});
document.getElementById("btn-back-from-history").addEventListener("click", () => {
  showScreen("screen-home");
  renderHome();
});
document.getElementById("btn-back-from-detail").addEventListener("click", () => {
  showScreen("screen-history");
});
document.getElementById("btn-account").addEventListener("click", () => {
  if (tracking.active) return;
  showScreen("screen-account");
  updateAccountUI();
});
document.getElementById("btn-back-from-account").addEventListener("click", () => {
  showScreen("screen-home");
  renderHome();
});

// ============================================================
// HOME rendering
// ============================================================
function renderHome() {
  const totalM = runs.reduce((s, r) => s + r.distanceM, 0);
  const totalSec = runs.reduce((s, r) => s + r.durationSec, 0);
  document.getElementById("home-total-dist").innerHTML = `${fmtKm(totalM, 1)}<span>km</span>`;
  document.getElementById("home-count").textContent = runs.length;
  document.getElementById("home-total-time").textContent = totalSec ? fmtDurationShort(totalSec) : "0h00";
  const avgPace = totalM > 0 ? totalSec / (totalM / 1000) : 0;
  document.getElementById("home-avg-pace").textContent = totalM > 0 ? fmtPace(avgPace) : "—";

  const list = document.getElementById("home-run-list");
  renderRunList(list, runs.slice(0, 5));
}

function renderRunList(container, list) {
  container.innerHTML = "";
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state">Aucune course enregistrée.<br>Lance ta première sortie ↑</div>`;
    return;
  }
  list.forEach((r) => {
    const row = document.createElement("button");
    row.className = "run-row";
    const [dayLabel, dateLabel] = fmtDateShort(r.date).split("\n");
    row.innerHTML = `
      <div class="date">${dayLabel}<br>${dateLabel}</div>
      <div class="mid">
        <div class="dist">${fmtKm(r.distanceM)} km</div>
        <div class="pace">${fmtPace(r.avgPaceSecPerKm)} / km${r.isPR ? '  <span class="pr-flag">RECORD</span>' : ""}</div>
      </div>
      <div class="time">${fmtClock(r.durationSec)}</div>
    `;
    row.addEventListener("click", () => openDetail(r.id));
    container.appendChild(row);
  });
}

function renderHistory() {
  const list = document.getElementById("history-run-list");
  renderRunList(list, runs);

  // best 1km split across all runs
  const best = bestKmSplit();
  document.getElementById("stat-best-km").textContent = best ? fmtPace(best.seconds) : "—";

  // longest run
  const longest = runs.reduce((max, r) => (r.distanceM > (max ? max.distanceM : 0) ? r : max), null);
  document.getElementById("stat-longest").textContent = longest ? `${fmtKm(longest.distanceM, 1)} km` : "—";

  // this week
  const now = new Date();
  const dayIdx = (now.getDay() + 6) % 7; // lundi = 0
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - dayIdx);
  const weekRuns = runs.filter((r) => new Date(r.date) >= monday);
  const weekM = weekRuns.reduce((s, r) => s + r.distanceM, 0);
  document.getElementById("goal-target").textContent = weeklyGoal;
  document.getElementById("stat-week-goal").innerHTML = `${fmtKm(weekM, 1)} / <span id="goal-target">${weeklyGoal}</span> km`;
  document.getElementById("stat-week-runs").textContent = `${weekRuns.length} sortie${weekRuns.length > 1 ? "s" : ""}`;
}

function bestKmSplit() {
  let best = null;
  runs.forEach((r) => (r.splits || []).forEach((s) => {
    if (!best || s.seconds < best.seconds) best = s;
  }));
  return best;
}
function bestKmSplitSeconds() {
  const b = bestKmSplit();
  return b ? b.seconds : null;
}

// mark PR flags once at load (fastest split anywhere in the run == global best)
function markPRs() {
  const bestSec = bestKmSplitSeconds();
  runs.forEach((r) => {
    r.isPR = bestSec != null && (r.splits || []).some((s) => s.seconds === bestSec);
  });
}

// ============================================================
// RUN DETAIL
// ============================================================
let detailMap = null;
function shareUrlFor(run) {
  const base = window.location.href.replace(/index\.html.*$/, "").replace(/\/[^\/]*$/, "/");
  return `${base}share.html?id=${encodeURIComponent(run.id)}&t=${run.shareToken}`;
}
function openDetail(id) {
  const r = runs.find((x) => x.id === id);
  if (!r) return;
  document.getElementById("detail-date").textContent = fmtDateFull(r.date);
  document.getElementById("detail-dist").textContent = `${fmtKm(r.distanceM)} km`;
  document.getElementById("detail-duration").textContent = fmtClock(r.durationSec);
  document.getElementById("detail-pace").textContent = `${fmtPace(r.avgPaceSecPerKm)} /km`;

  const splitsEl = document.getElementById("detail-splits");
  splitsEl.innerHTML = "";
  const maxPace = Math.max(...(r.splits || []).map((s) => s.seconds), 1);
  const minPace = Math.min(...(r.splits || []).map((s) => s.seconds), maxPace);
  (r.splits || []).forEach((s) => {
    const range = Math.max(maxPace - minPace, 1);
    const pct = 35 + (65 * (maxPace - s.seconds)) / range; // faster => longer bar
    const row = document.createElement("div");
    row.className = "split-row";
    row.innerHTML = `
      <div class="km-idx">${s.km}</div>
      <div class="split-bar-track"><div class="split-bar-fill" style="width:${pct}%"></div></div>
      <div class="pace-val">${fmtPace(s.seconds)}</div>
    `;
    splitsEl.appendChild(row);
  });
  if (!r.splits || r.splits.length === 0) {
    splitsEl.innerHTML = `<div class="empty-state">Course trop courte pour des splits au km.</div>`;
  }

  showScreen("screen-detail");

  setTimeout(() => {
    const mapEl = document.getElementById("detail-map");
    if (detailMap) { detailMap.remove(); detailMap = null; }
    if (r.path && r.path.length > 1) {
      detailMap = L.map(mapEl, { zoomControl: false, attributionControl: false }).setView([r.path[0].lat, r.path[0].lng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(detailMap);
      const latlngs = r.path.map((p) => [p.lat, p.lng]);
      const line = L.polyline(latlngs, { color: "#d6432e", weight: 4 }).addTo(detailMap);
      detailMap.fitBounds(line.getBounds(), { padding: [16, 16] });
    } else {
      mapEl.innerHTML = `<div class="empty-state" style="border:none;">Pas de tracé GPS pour cette course.</div>`;
    }
  }, 50);

  // ---------- partage ----------
  const shareBtn = document.getElementById("btn-share-run");
  const sharePanel = document.getElementById("share-panel");
  const shareLinkText = document.getElementById("share-link-text");

  function refreshShareUI() {
    if (r.shareToken) {
      sharePanel.style.display = "flex";
      shareLinkText.textContent = shareUrlFor(r);
      shareBtn.textContent = "Course partagée";
    } else {
      sharePanel.style.display = "none";
      shareBtn.textContent = "Partager cette course";
    }
  }
  refreshShareUI();

  shareBtn.onclick = async () => {
    if (!r.shareToken) {
      r.shareToken = crypto.randomUUID();
      r.updatedAt = new Date().toISOString();
      saveRuns();
      await pushRun(r);
    }
    refreshShareUI();
    const url = shareUrlFor(r);
    if (navigator.share) {
      navigator.share({ title: "Ma course sur Splits", url }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(url).then(() => toast("Lien copié"));
    }
  };
  document.getElementById("btn-copy-share").onclick = () => {
    navigator.clipboard.writeText(shareUrlFor(r)).then(() => toast("Lien copié"));
  };
  document.getElementById("btn-revoke-share").onclick = async () => {
    r.shareToken = null;
    r.updatedAt = new Date().toISOString();
    saveRuns();
    await pushRun(r);
    refreshShareUI();
    toast("Partage désactivé");
  };

  document.getElementById("btn-delete-run").onclick = () => {
    if (confirm("Supprimer définitivement cette course ?")) {
      runs = runs.filter((x) => x.id !== id);
      saveRuns();
      markPRs();
      pushDelete(id);
      showScreen("screen-history");
      renderHistory();
      toast("Course supprimée");
    }
  };
}

// ============================================================
// TRACKING
// ============================================================
document.getElementById("btn-start-run").addEventListener("click", startRun);
document.getElementById("btn-pause").addEventListener("click", togglePause);
document.getElementById("btn-stop").addEventListener("click", stopRun);

function setGpsStatus(state, text) {
  const el = document.getElementById("gps-status");
  el.className = "gps-status " + state;
  document.getElementById("gps-status-text").textContent = text;
  document.getElementById("track-gps-mini").textContent = "GPS " + (state === "ok" ? "OK" : state === "searching" ? "…" : "?");
}

function startRun() {
  if (!("geolocation" in navigator)) {
    toast("La géolocalisation n'est pas disponible sur cet appareil.");
    return;
  }
  tracking = {
    active: true,
    paused: false,
    watchId: null,
    startTime: Date.now(),
    elapsedBeforePause: 0,
    path: [],
    distanceM: 0,
    splits: [],
    lastSplitDistanceM: 0,
    lastSplitTime: Date.now(),
    clockInterval: null,
    map: null,
    polyline: null,
    marker: null,
    wakeLock: null,
    screenLocked: false,
  };
  showScreen("screen-track");
  document.getElementById("lock-overlay").classList.remove("show");
  document.getElementById("btn-lock-fab").style.display = "flex";
  document.getElementById("btn-pause").textContent = "Pause";
  document.getElementById("btn-pause").className = "ctrl-btn pause";
  updateTrackUI();
  setGpsStatus("searching", "Recherche du signal…");

  tracking.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });

  tracking.clockInterval = setInterval(updateTrackUI, 1000);
  requestWakeLock();

  setTimeout(() => {
    const mapEl = document.getElementById("track-map");
    tracking.map = L.map(mapEl, { zoomControl: false, attributionControl: false }).setView([48.8566, 2.3522], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(tracking.map);
    tracking.polyline = L.polyline([], { color: "#d6432e", weight: 4 }).addTo(tracking.map);
  }, 100);
}

function onPositionError(err) {
  setGpsStatus("searching", "Signal GPS faible…");
}

function onPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  setGpsStatus("ok", "Signal GPS acquis");

  if (accuracy && accuracy > MIN_ACCURACY_M) return; // point trop imprécis, ignoré

  const point = { lat: latitude, lng: longitude, t: Date.now(), accuracy };

  if (tracking.path.length > 0 && !tracking.paused) {
    const prev = tracking.path[tracking.path.length - 1];
    const stepM = haversineM(prev, point);
    if (stepM >= MIN_STEP_M) {
      tracking.distanceM += stepM;
      tracking.path.push(point);
      updateMapLine();
      checkSplit();
    }
  } else if (tracking.path.length === 0) {
    tracking.path.push(point);
    if (tracking.map) tracking.map.setView([latitude, longitude], 17);
  }
}

function checkSplit() {
  const kmDoneNow = Math.floor(tracking.distanceM / 1000);
  const kmDoneBefore = Math.floor(tracking.lastSplitDistanceM / 1000);
  if (kmDoneNow > kmDoneBefore) {
    const now = Date.now();
    const splitSec = (now - tracking.lastSplitTime) / 1000;
    tracking.splits.push({ km: kmDoneNow, seconds: splitSec });
    tracking.lastSplitTime = now;
    tracking.lastSplitDistanceM = tracking.distanceM;
    toast(`Km ${kmDoneNow} — ${fmtPace(splitSec)}`);
  }
}

function updateMapLine() {
  if (!tracking.polyline) return;
  const latlngs = tracking.path.map((p) => [p.lat, p.lng]);
  tracking.polyline.setLatLngs(latlngs);
  if (tracking.map) tracking.map.panTo(latlngs[latlngs.length - 1]);
}

function currentElapsedSec() {
  if (!tracking.active) return 0;
  if (tracking.paused) return tracking.elapsedBeforePause;
  return tracking.elapsedBeforePause + (Date.now() - tracking.startTime) / 1000;
}

function updateTrackUI() {
  const elapsed = currentElapsedSec();
  const clockStr = fmtClock(Math.floor(elapsed));
  document.getElementById("track-clock").innerHTML = clockStr.replace(":", '<span class="blink">:</span>');
  document.getElementById("track-dist").textContent = fmtKm(tracking.distanceM);

  const avgPace = tracking.distanceM > 0 ? elapsed / (tracking.distanceM / 1000) : 0;
  document.getElementById("track-pace-avg").textContent = fmtPace(avgPace);

  // allure "actuelle" : sur le dernier segment depuis le dernier split (ou depuis le départ)
  const sinceSplitM = tracking.distanceM - tracking.lastSplitDistanceM;
  const sinceSplitSec = (Date.now() - tracking.lastSplitTime) / 1000;
  const paceNow = sinceSplitM > 20 ? sinceSplitSec / (sinceSplitM / 1000) : avgPace;
  document.getElementById("track-pace-now").textContent = fmtPace(paceNow);

  // ring: progress within current km
  const progressInKm = (tracking.distanceM % 1000) / 1000;
  const circumference = 326.7;
  const offset = circumference * (1 - progressInKm);
  document.getElementById("lap-ring-fg").style.strokeDashoffset = offset;
}

function togglePause() {
  const btn = document.getElementById("btn-pause");
  if (!tracking.paused) {
    tracking.paused = true;
    tracking.elapsedBeforePause += (Date.now() - tracking.startTime) / 1000;
    btn.textContent = "Reprendre";
    btn.className = "ctrl-btn resume";
    document.getElementById("track-status").textContent = "EN PAUSE";
  } else {
    tracking.paused = false;
    tracking.startTime = Date.now();
    tracking.lastSplitTime = Date.now(); // évite de fausser le split en cours
    btn.textContent = "Pause";
    btn.className = "ctrl-btn pause";
    document.getElementById("track-status").textContent = "EN COURSE";
  }
}

function stopRun() {
  if (tracking.distanceM < 50) {
    if (!confirm("Course très courte (< 50 m). Terminer et l'enregistrer quand même ?")) return;
  }
  clearInterval(tracking.clockInterval);
  if (tracking.watchId != null) navigator.geolocation.clearWatch(tracking.watchId);
  releaseWakeLock();
  setScreenLock(false);
  document.getElementById("btn-lock-fab").style.display = "none";

  const durationSec = Math.round(currentElapsedSec());
  const distanceM = tracking.distanceM;
  const avgPaceSecPerKm = distanceM > 0 ? durationSec / (distanceM / 1000) : 0;

  const run = {
    id: "r_" + Date.now(),
    date: new Date().toISOString(),
    distanceM,
    durationSec,
    avgPaceSecPerKm,
    path: tracking.path.map((p) => ({ lat: p.lat, lng: p.lng })),
    splits: tracking.splits.map((s) => ({ km: s.km, seconds: s.seconds })),
    updatedAt: new Date().toISOString(),
    shareToken: null,
  };

  runs.unshift(run);
  saveRuns();
  markPRs();
  pushRun(run);

  tracking.active = false;
  if (tracking.map) { tracking.map.remove(); tracking.map = null; }

  showScreen("screen-home");
  renderHome();
  toast(`Course enregistrée — ${fmtKm(distanceM)} km`);
}

// ============================================================
// WAKE LOCK — garde l'écran allumé pendant une course
// ============================================================
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    tracking.wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) {
    // refusé (batterie faible, onglet en arrière-plan, etc.) — silencieux
  }
}
function releaseWakeLock() {
  if (tracking.wakeLock) {
    tracking.wakeLock.release().catch(() => {});
    tracking.wakeLock = null;
  }
}
document.addEventListener("visibilitychange", () => {
  if (tracking.active && document.visibilityState === "visible" && !tracking.wakeLock) {
    requestWakeLock();
  }
  if (!tracking.active && document.visibilityState === "visible" && currentUser) {
    syncNow({ silent: true });
  }
});

// ============================================================
// VERROUILLAGE TACTILE — bloque les appuis accidentels (poche, brassard)
// N'empêche PAS l'écran de s'éteindre à lui seul : combiné au Wake Lock ci-dessus.
// ============================================================
const lockOverlay = document.getElementById("lock-overlay");
const lockFab = document.getElementById("btn-lock-fab");
const unlockBtn = document.getElementById("btn-unlock-hold");
const unlockFill = document.getElementById("unlock-fill");
const HOLD_MS = 1400;
let holdTimer = null;
let holdStart = null;
let holdRAF = null;

function setScreenLock(locked) {
  tracking.screenLocked = locked;
  lockOverlay.classList.toggle("show", locked);
  if (locked) updateLockReadout();
}

lockFab.addEventListener("click", () => setScreenLock(true));

function updateLockReadout() {
  if (!tracking.active) return;
  document.getElementById("lock-dist").innerHTML = `${fmtKm(tracking.distanceM)} <span>km</span>`;
  document.getElementById("lock-clock").textContent = fmtClock(Math.floor(currentElapsedSec()));
  const elapsed = currentElapsedSec();
  const avgPace = tracking.distanceM > 0 ? elapsed / (tracking.distanceM / 1000) : 0;
  document.getElementById("lock-pace").textContent = `${fmtPace(avgPace)} /km`;
}

function startHold(e) {
  e.preventDefault();
  holdStart = performance.now();
  const step = () => {
    const pct = Math.min(100, ((performance.now() - holdStart) / HOLD_MS) * 100);
    unlockFill.style.height = pct + "%";
    if (pct >= 100) {
      setScreenLock(false);
      resetHold();
      return;
    }
    holdRAF = requestAnimationFrame(step);
  };
  holdRAF = requestAnimationFrame(step);
}
function resetHold() {
  cancelAnimationFrame(holdRAF);
  holdRAF = null;
  holdStart = null;
  unlockFill.style.height = "0%";
}
unlockBtn.addEventListener("pointerdown", startHold);
unlockBtn.addEventListener("pointerup", resetHold);
unlockBtn.addEventListener("pointerleave", resetHold);
unlockBtn.addEventListener("pointercancel", resetHold);

// rafraîchit l'affichage de l'écran verrouillé en même temps que le reste
setInterval(() => { if (tracking.active && tracking.screenLocked) updateLockReadout(); }, 1000);

// ============================================================
// SUPABASE — auth (magic link) & synchronisation
// ============================================================
function displayNameFor(user) {
  if (!user) return "";
  return (user.user_metadata && user.user_metadata.display_name) || user.email;
}

function runToRemote(r) {
  return {
    id: r.id,
    user_id: currentUser ? currentUser.id : undefined,
    date: r.date,
    distance_m: r.distanceM,
    duration_sec: r.durationSec,
    avg_pace_sec_per_km: r.avgPaceSecPerKm,
    path: r.path,
    splits: r.splits,
    share_token: r.shareToken || null,
    deleted_at: null,
  };
}
function remoteToRun(row) {
  return {
    id: row.id,
    date: row.date,
    distanceM: Number(row.distance_m),
    durationSec: Number(row.duration_sec),
    avgPaceSecPerKm: Number(row.avg_pace_sec_per_km),
    path: row.path || [],
    splits: row.splits || [],
    shareToken: row.share_token || null,
    updatedAt: row.updated_at,
  };
}

async function pushRun(run) {
  if (!currentUser) return;
  try {
    await sb.from("runs").upsert(runToRemote(run));
  } catch (e) {
    // échec silencieux — retenté au prochain syncNow()
  }
}

async function pushDelete(runId) {
  if (!currentUser) return;
  try {
    await sb.from("runs").update({ deleted_at: new Date().toISOString() }).eq("id", runId);
  } catch (e) {}
}

async function syncNow(opts) {
  const silent = opts && opts.silent;
  if (!currentUser || syncing) return;
  syncing = true;
  try {
    const { data, error } = await sb.from("runs").select("*").eq("user_id", currentUser.id);
    if (error) throw error;

    const remoteIds = new Set();
    (data || []).forEach((row) => {
      remoteIds.add(row.id);
      if (row.deleted_at) {
        runs = runs.filter((r) => r.id !== row.id);
        return;
      }
      const local = runs.find((r) => r.id === row.id);
      const remoteRun = remoteToRun(row);
      if (!local) {
        runs.push(remoteRun);
      } else if (new Date(row.updated_at) > new Date(local.updatedAt || 0)) {
        Object.assign(local, remoteRun);
      }
    });

    // pousse les courses locales absentes du serveur (ex : créées hors-ligne)
    const toPush = runs.filter((r) => !remoteIds.has(r.id));
    for (const r of toPush) await pushRun(r);

    runs.sort((a, b) => new Date(b.date) - new Date(a.date));
    saveRuns();
    markPRs();
    renderHome();
    if (document.getElementById("screen-history").classList.contains("active")) renderHistory();

    localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    updateAccountUI();
    if (!silent) toast("Synchronisation terminée");
  } catch (e) {
    if (!silent) toast("Échec de la synchronisation");
  } finally {
    syncing = false;
  }
}

function updateSyncStatus() {
  const el = document.getElementById("sync-status");
  const textEl = document.getElementById("sync-status-text");
  if (currentUser) {
    el.className = "sync-status ok";
    textEl.textContent = `Synchronisé — ${displayNameFor(currentUser)}`;
  } else {
    el.className = "sync-status";
    textEl.textContent = "Non connecté";
  }
}

function updateAccountUI() {
  const loggedOut = document.getElementById("account-logged-out");
  const loggedIn = document.getElementById("account-logged-in");
  if (currentUser) {
    loggedOut.style.display = "none";
    loggedIn.style.display = "block";
    document.getElementById("account-email-display").textContent = currentUser.email;
    document.getElementById("account-name-input").value = (currentUser.user_metadata && currentUser.user_metadata.display_name) || "";
    const last = localStorage.getItem(LAST_SYNC_KEY);
    document.getElementById("account-last-sync").textContent = last ? new Date(last).toLocaleString("fr-FR") : "Jamais";
  } else {
    loggedOut.style.display = "block";
    loggedIn.style.display = "none";
  }
  updateSyncStatus();
}

sb.auth.onAuthStateChange((event, session) => {
  currentUser = session ? session.user : null;
  updateAccountUI();
  if (currentUser) syncNow({ silent: true });
});

document.getElementById("btn-send-magic-link").addEventListener("click", async () => {
  const name = document.getElementById("account-name").value.trim();
  const email = document.getElementById("account-email").value.trim();
  const statusEl = document.getElementById("account-status");
  if (!email) { statusEl.textContent = "Entre une adresse email."; return; }
  statusEl.textContent = "Envoi en cours…";
  try {
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: window.location.origin + window.location.pathname,
        data: name ? { display_name: name } : undefined,
      },
    });
    if (error) throw error;
    statusEl.textContent = "Lien envoyé — vérifie ta boîte mail.";
  } catch (e) {
    statusEl.textContent = "Erreur d'envoi. Réessaie.";
  }
});
document.getElementById("btn-save-name").addEventListener("click", async () => {
  const name = document.getElementById("account-name-input").value.trim();
  if (!name) { toast("Entre un prénom."); return; }
  try {
    const { data, error } = await sb.auth.updateUser({ data: { display_name: name } });
    if (error) throw error;
    currentUser = data.user;
    updateAccountUI();
    toast("Prénom enregistré");
  } catch (e) {
    toast("Erreur lors de l'enregistrement");
  }
});
document.getElementById("btn-sign-out").addEventListener("click", async () => {
  await sb.auth.signOut();
  toast("Déconnecté");
});
document.getElementById("btn-sync-now").addEventListener("click", () => syncNow());

// ============================================================
// init
// ============================================================
markPRs();
renderHome();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

// warm GPS permission state on load (non bloquant)
if ("geolocation" in navigator && "permissions" in navigator) {
  navigator.permissions.query({ name: "geolocation" }).then((res) => {
    if (res.state === "granted") setGpsStatus("ok", "GPS autorisé");
    else if (res.state === "denied") setGpsStatus("", "GPS refusé — active-le dans les réglages");
  }).catch(() => {});
}

sb.auth.getSession().then(({ data }) => {
  currentUser = data.session ? data.session.user : null;
  updateAccountUI();
  if (currentUser) syncNow({ silent: true });
});
