"use strict";

/* ============================================================
   SPLITS — suivi de course personnel (PWA)
   Stockage local : localStorage. Sync optionnelle : Supabase.
   ============================================================ */

const STORAGE_KEY = "splits.runs.v1";
const GOAL_KEY = "splits.weeklyGoalKm.v1";
const LAST_SYNC_KEY = "splits.lastSync.v1";
const HYROX_PACE_FAST_KEY = "splits.hyroxPaceFast.v1";
const HYROX_PACE_SLOW_KEY = "splits.hyroxPaceSlow.v1";
const TRENDS_PERIOD_KEY = "splits.trendsPeriod.v1";
const TRENDS_COUNT_KEY = "splits.trendsCount.v1";
const TRAINING_PLAN_KEY = "splits.trainingPlan.v1";
const TRAINING_DONE_KEY = "splits.trainingDone.v1";
const DEFAULT_GOAL_KM = 20;
const DEFAULT_HYROX_PACE_FAST_SEC = 330; // 5:30 /km
const DEFAULT_HYROX_PACE_SLOW_SEC = 360; // 6:00 /km

const MIN_ACCURACY_M = 30;      // ignore les points trop imprécis
const MIN_STEP_M = 3;           // ignore le bruit GPS sous ce seuil

// zone EF par défaut (7:05–8:16/km), utilisée pour l'échauffement et le retour
// au calme des séances fractionnées quand aucune allure spécifique n'est donnée
const EF_ZONE = { min: 425, max: 496 };

const SUPABASE_URL = "https://fyuvconzpqglvhufixzv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_YFi6gTCa6b6i5APTxMT6vg_x06ofpEr";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ============================================================
// PROGRAMME D'ENTRAÎNEMENT — Bloc 1 (VMA 12,1 km/h), modifiable via l'écran Programme
// ============================================================
const DEFAULT_TRAINING_PLAN = {
  name: "Bloc 1 — VMA 12,1 km/h",
  weeks: [
    { week: 1, label: "S1 · Mise en route", sessions: [
      { id: "s1-1", name: "Endurance", type: "endurance", paceMinSec: 425, paceMaxSec: 496, note: "35' EF en continu" },
      { id: "s1-2", name: "Fractionné court", type: "interval", warmupSec: 900, cooldownSec: 600, sets: 1, restBetweenSetsSec: 0, reps: 5, workSec: 60, workPaceMinSec: 344, workPaceMaxSec: 356, restSec: 60, note: "5×1' à 5:50/km, récup 1' trot" },
    ]},
    { week: 2, label: "S2 · Montée en volume", sessions: [
      { id: "s2-1", name: "Endurance", type: "endurance", paceMinSec: 425, paceMaxSec: 496, note: "40' EF en continu" },
      { id: "s2-2", name: "Fractionné court", type: "interval", warmupSec: 900, cooldownSec: 600, sets: 1, restBetweenSetsSec: 0, reps: 8, workSec: 60, workPaceMinSec: 344, workPaceMaxSec: 356, restSec: 60, note: "8×1' à 5:50/km, récup 1' trot" },
    ]},
    { week: 3, label: "S3 · Choc VMA", sessions: [
      { id: "s3-1", name: "Endurance", type: "endurance", paceMinSec: 425, paceMaxSec: 496, note: "45' EF en continu" },
      { id: "s3-2", name: "30/30", type: "interval", warmupSec: 600, cooldownSec: 600, sets: 2, restBetweenSetsSec: 90, reps: 6, workSec: 30, workPaceMinSec: 283, workPaceMaxSec: 298, restSec: 30, note: "2×(6×30″ à 4:58-4:43/km)" },
    ]},
    { week: 4, label: "S4 · Semaine la plus chargée", sessions: [
      { id: "s4-1", name: "Endurance", type: "endurance", paceMinSec: 425, paceMaxSec: 496, note: "50' EF en continu" },
      { id: "s4-2", name: "Fractionné moyen", type: "interval", warmupSec: 600, cooldownSec: 600, sets: 1, restBetweenSetsSec: 0, reps: 5, workSec: 120, workPaceMinSec: 344, workPaceMaxSec: 356, restSec: 90, note: "5×2' à 5:50/km, récup active" },
      { id: "s4-3", name: "Endurance légère", type: "endurance", paceMinSec: 425, paceMaxSec: 496, note: "30' EF en continu" },
    ]},
    { week: 5, label: "S5 · Consolidation", sessions: [
      { id: "s5-1", name: "Endurance", type: "endurance", paceMinSec: 425, paceMaxSec: 496, note: "55' EF en continu" },
      { id: "s5-2", name: "Fractionné long", type: "interval", warmupSec: 900, cooldownSec: 600, sets: 1, restBetweenSetsSec: 0, reps: 4, workSec: 180, workPaceMinSec: 344, workPaceMaxSec: 356, restSec: 120, note: "4×3' à 5:50/km, récup active" },
    ]},
  ],
};

function loadTrainingPlan() {
  try {
    const raw = localStorage.getItem(TRAINING_PLAN_KEY);
    return raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(DEFAULT_TRAINING_PLAN));
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_TRAINING_PLAN));
  }
}
function saveTrainingPlan(plan) {
  localStorage.setItem(TRAINING_PLAN_KEY, JSON.stringify(plan));
}
function loadTrainingDone() {
  try {
    return JSON.parse(localStorage.getItem(TRAINING_DONE_KEY) || "{}");
  } catch (e) {
    return {};
  }
}
function saveTrainingDone(done) {
  localStorage.setItem(TRAINING_DONE_KEY, JSON.stringify(done));
}
function findSessionById(id) {
  for (const w of trainingPlan.weeks) {
    const found = w.sessions.find((s) => s.id === id);
    if (found) return found;
  }
  return null;
}

// ---------- state ----------
let runs = loadRuns();
let weeklyGoal = Number(localStorage.getItem(GOAL_KEY)) || DEFAULT_GOAL_KM;
let hyroxPaceFast = Number(localStorage.getItem(HYROX_PACE_FAST_KEY)) || DEFAULT_HYROX_PACE_FAST_SEC;
let hyroxPaceSlow = Number(localStorage.getItem(HYROX_PACE_SLOW_KEY)) || DEFAULT_HYROX_PACE_SLOW_SEC;
let trendsPeriod = localStorage.getItem(TRENDS_PERIOD_KEY) || "week";
let trendsCount = Number(localStorage.getItem(TRENDS_COUNT_KEY)) || 10;
let trendsOrigin = "history";
let trainingPlan = loadTrainingPlan();
let trainingDone = loadTrainingDone();
let activeSession = null;   // séance du programme sélectionnée pour la prochaine course
let currentUser = null;
let syncing = false;

// ---------- moteur de phases (séances fractionnées) ----------
let phaseSequence = [];
let phaseIndex = -1;
let paceAlertState = "in"; // "in" | "out" — déclenchement uniquement au changement d'état

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
function pathDistanceM(path) {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += haversineM(path[i - 1], path[i]);
  return d;
}
// Recalcule des splits uniformes après correction/import de tracé : chaque km
// COMPLET reçoit l'allure moyenne recalculée. Le dernier km, s'il est incomplet,
// ne reçoit volontairement aucun split — comme pendant l'enregistrement en direct,
// où checkSplit() n'ajoute jamais de split pour une fin de course à mi-kilomètre.
function recomputeUniformSplits(distanceM, avgPaceSecPerKm) {
  const fullKm = Math.floor(distanceM / 1000);
  const splits = [];
  for (let i = 1; i <= fullKm; i++) {
    splits.push({ km: i, seconds: avgPaceSecPerKm });
  }
  return splits;
}
function parseKmlPath(text) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(text, "application/xml");
  const coordsEl = xml.querySelector("coordinates");
  if (!coordsEl) return null;
  const raw = coordsEl.textContent.trim();
  return raw
    .split(/\s+/)
    .map((triplet) => {
      const parts = triplet.split(",");
      const lng = Number(parts[0]);
      const lat = Number(parts[1]);
      return { lat, lng };
    })
    .filter((p) => isFinite(p.lat) && isFinite(p.lng));
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
// mm:ss "brut" (les minutes peuvent dépasser 59) — utilisé pour le graphique
// Tendances / Durée, dont le titre porte déjà l'unité (min)
function fmtMinSecTotal(totalSec) {
  const totalMinutes = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60);
  return `${totalMinutes}:${String(secs).padStart(2, "0")}`;
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
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    window.speechSynthesis.speak(u);
  } catch (e) {
    // synthèse vocale indisponible — silencieux
  }
}

// ---------- HYROX target helpers ----------
function parseMMSS(str) {
  const m = String(str || "").trim().match(/^(\d{1,2}):([0-5]?\d)$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function formatMMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function updateHyroxTargetDisplays() {
  const label = `${formatMMSS(hyroxPaceFast)}–${formatMMSS(hyroxPaceSlow)} /km`;
  const homeEl = document.getElementById("home-hyrox-target");
  const historyEl = document.getElementById("history-hyrox-target");
  if (homeEl) homeEl.textContent = label;
  if (historyEl) historyEl.textContent = label;
}
function updateHyroxStatus(elId, avgPaceSecPerKm, hasRuns) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!hasRuns) {
    el.textContent = "Pas encore de courses enregistrées.";
    el.className = "hyrox-status";
    return;
  }
  if (avgPaceSecPerKm <= hyroxPaceSlow) {
    el.textContent = `Ton allure moyenne (${fmtPace(avgPaceSecPerKm)}/km) est dans l'objectif.`;
    el.className = "hyrox-status ok";
  } else {
    const diff = Math.round(avgPaceSecPerKm - hyroxPaceSlow);
    el.textContent = `Ton allure moyenne (${fmtPace(avgPaceSecPerKm)}/km) est à ${diff}s/km de l'objectif.`;
    el.className = "hyrox-status warn";
  }
}

// ---------- TENDANCES : agrégation par semaine / mois ----------
function periodKeyFor(dateIso, period) {
  const d = new Date(dateIso);
  if (period === "month") {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  const dayIdx = (d.getDay() + 6) % 7; // lundi = 0
  const monday = new Date(d);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(d.getDate() - dayIdx);
  return monday.toISOString().slice(0, 10);
}
function periodLabelFor(key, period) {
  if (period === "month") {
    const [y, m] = key.split("-");
    const d = new Date(Number(y), Number(m) - 1, 1);
    return d.toLocaleDateString("fr-FR", { month: "short" }).replace(".", "");
  }
  const d = new Date(key);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}
function buildTrendPeriods(period, count) {
  const now = new Date();
  const keys = [];
  if (period === "month") {
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    }
  } else {
    const dayIdx = (now.getDay() + 6) % 7;
    const thisMonday = new Date(now);
    thisMonday.setHours(0, 0, 0, 0);
    thisMonday.setDate(now.getDate() - dayIdx);
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(thisMonday);
      d.setDate(thisMonday.getDate() - i * 7);
      keys.push(d.toISOString().slice(0, 10));
    }
  }
  return keys;
}
function aggregateByPeriod(period) {
  const map = {};
  runs.forEach((r) => {
    const key = periodKeyFor(r.date, period);
    if (!map[key]) map[key] = { distanceM: 0, durationSec: 0, count: 0 };
    map[key].distanceM += r.distanceM;
    map[key].durationSec += r.durationSec;
    map[key].count += 1;
  });
  return map;
}
function renderTrendBars(containerId, values) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  const max = Math.max(...values.map((v) => v.value), 0.0001);
  values.forEach((v) => {
    const pct = v.value > 0 ? Math.max(4, (v.value / max) * 100) : 2;
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.innerHTML = `
      <div class="trend-bar-val">${v.display}</div>
      <div class="trend-bar-track"><div class="trend-bar-fill" style="height:${pct}%"></div></div>
      <div class="trend-bar-label">${v.label}</div>
    `;
    container.appendChild(bar);
  });
}
function renderTrends() {
  document.getElementById("trends-count-label").textContent = trendsCount;
  document.querySelectorAll(".trends-toggle-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.period === trendsPeriod);
  });

  const map = aggregateByPeriod(trendsPeriod);
  const keys = buildTrendPeriods(trendsPeriod, trendsCount);

  const distanceValues = keys.map((k) => {
    const agg = map[k];
    return {
      label: periodLabelFor(k, trendsPeriod),
      value: agg ? agg.distanceM / 1000 : 0,
      display: agg ? fmtKm(agg.distanceM, 1) : "0",
    };
  });
  renderTrendBars("trends-bars-distance", distanceValues);

  const durationValues = keys.map((k) => {
    const agg = map[k];
    return {
      label: periodLabelFor(k, trendsPeriod),
      value: agg ? agg.durationSec / 3600 : 0,
      display: agg ? fmtMinSecTotal(agg.durationSec) : "0:00",
    };
  });
  renderTrendBars("trends-bars-duration", durationValues);

  // allure : on charte la vitesse (km/h) pour que "plus rapide" = barre plus haute,
  // tout en affichant le libellé d'allure familier (mm:ss /km)
  const paceValues = keys.map((k) => {
    const agg = map[k];
    if (!agg || agg.distanceM <= 0) {
      return { label: periodLabelFor(k, trendsPeriod), value: 0, display: "—" };
    }
    const paceSecPerKm = agg.durationSec / (agg.distanceM / 1000);
    const speedKmh = 3600 / paceSecPerKm;
    return { label: periodLabelFor(k, trendsPeriod), value: speedKmh, display: fmtPace(paceSecPerKm) };
  });
  renderTrendBars("trends-bars-pace", paceValues);
}

// ---------- PROGRAMME : rendu et édition ----------
function updateActiveSessionBadge() {
  const badge = document.getElementById("active-session-badge");
  if (activeSession) {
    badge.style.display = "flex";
    document.getElementById("active-session-text").textContent = `Séance : ${activeSession.name}`;
  } else {
    badge.style.display = "none";
  }
}
function renderProgram() {
  document.getElementById("program-block-name").textContent = trainingPlan.name || "Programme";
  const list = document.getElementById("program-list");
  list.innerHTML = "";
  trainingPlan.weeks.forEach((w) => {
    const weekEl = document.createElement("div");
    weekEl.className = "program-week";
    const doneCount = w.sessions.filter((s) => trainingDone[s.id]).length;
    const header = document.createElement("div");
    header.className = "program-week-label";
    header.textContent = `${w.label} · ${doneCount}/${w.sessions.length}`;
    weekEl.appendChild(header);
    w.sessions.forEach((s) => {
      const card = document.createElement("div");
      card.className = "program-session" + (trainingDone[s.id] ? " done" : "");
      const paceLabel = s.type === "endurance"
        ? `${fmtPace(s.paceMinSec)}–${fmtPace(s.paceMaxSec)} /km`
        : `${fmtPace(s.workPaceMinSec)}–${fmtPace(s.workPaceMaxSec)} /km`;
      card.innerHTML = `
        <div class="program-session-top">
          <div class="program-session-name">${s.name}</div>
          <button class="program-check" data-id="${s.id}">${trainingDone[s.id] ? "✓ Fait" : "Marquer fait"}</button>
        </div>
        <div class="program-session-note">${s.note || ""}</div>
        <div class="program-session-pace">${paceLabel}</div>
        <button class="program-start" data-id="${s.id}">Démarrer cette séance</button>
      `;
      weekEl.appendChild(card);
    });
    list.appendChild(weekEl);
  });
  list.querySelectorAll(".program-check").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (trainingDone[id]) delete trainingDone[id];
      else trainingDone[id] = new Date().toISOString();
      saveTrainingDone(trainingDone);
      renderProgram();
    });
  });
  list.querySelectorAll(".program-start").forEach((btn) => {
    btn.addEventListener("click", () => {
      const session = findSessionById(btn.dataset.id);
      if (!session) return;
      activeSession = session;
      updateActiveSessionBadge();
      showScreen("screen-home");
      toast(`Séance "${session.name}" sélectionnée — appuie sur Démarrer`);
    });
  });
}

// ============================================================
// PHASE ENGINE (séances fractionnées) & alerte d'allure
// ============================================================
function buildPhaseSequence(session) {
  const phases = [];
  if (session.warmupSec) phases.push({ kind: "warmup", label: "Échauffement", durationSec: session.warmupSec });
  const sets = session.sets || 1;
  for (let set = 1; set <= sets; set++) {
    for (let rep = 1; rep <= session.reps; rep++) {
      phases.push({
        kind: "work", label: "Allure rapide", durationSec: session.workSec,
        paceMinSec: session.workPaceMinSec, paceMaxSec: session.workPaceMaxSec,
        rep, totalReps: session.reps, set, totalSets: sets,
      });
      const isLastRepOfSet = rep === session.reps;
      const isLastSet = set === sets;
      if (!(isLastRepOfSet && isLastSet)) {
        if (isLastRepOfSet && !isLastSet) {
          phases.push({ kind: "restSet", label: "Récup entre séries", durationSec: session.restBetweenSetsSec || 0 });
        } else {
          phases.push({ kind: "rest", label: "Récupération", durationSec: session.restSec });
        }
      }
    }
  }
  if (session.cooldownSec) phases.push({ kind: "cooldown", label: "Retour au calme", durationSec: session.cooldownSec });
  return phases.filter((p) => p.durationSec > 0);
}

function advancePhase() {
  phaseIndex++;
  if (phaseIndex >= phaseSequence.length) {
    speak("Séance terminée, bravo");
    document.getElementById("phase-bar").style.display = "none";
    phaseSequence = [];
    phaseIndex = -1;
    return;
  }
  const phase = phaseSequence[phaseIndex];
  phase.remainingSec = phase.durationSec;
  const repInfo = phase.kind === "work" ? `, répétition ${phase.rep} sur ${phase.totalReps}` : "";
  speak(`${phase.label}${repInfo}`);
  paceAlertState = "in"; // on redonne une chance à chaque nouvelle phase avant de réalerter
  updatePhaseUI();
}

function updatePhaseUI() {
  if (phaseIndex < 0 || phaseIndex >= phaseSequence.length) return;
  const phase = phaseSequence[phaseIndex];
  document.getElementById("phase-name").textContent = phase.label;
  document.getElementById("phase-timer").textContent = fmtClock(phase.remainingSec);
  document.getElementById("phase-rep").textContent = phase.totalReps
    ? `Rép. ${phase.rep}/${phase.totalReps}${phase.totalSets > 1 ? ` · série ${phase.set}/${phase.totalSets}` : ""}`
    : "";
}

function tickPhase() {
  if (phaseIndex < 0 || phaseIndex >= phaseSequence.length) return;
  const phase = phaseSequence[phaseIndex];
  phase.remainingSec -= 1;
  if (phase.remainingSec <= 0) {
    advancePhase();
  } else {
    updatePhaseUI();
  }
}

function getCurrentTargetZone() {
  if (!activeSession) return null;
  if (activeSession.type === "endurance") {
    return { min: activeSession.paceMinSec, max: activeSession.paceMaxSec };
  }
  if (activeSession.type === "interval" && phaseIndex >= 0 && phaseIndex < phaseSequence.length) {
    const phase = phaseSequence[phaseIndex];
    if (phase.kind === "work") return { min: phase.paceMinSec, max: phase.paceMaxSec };
    if (phase.kind === "warmup" || phase.kind === "cooldown") return EF_ZONE;
  }
  return null;
}

function checkPaceAlert(currentPaceSecPerKm) {
  const zone = getCurrentTargetZone();
  if (!zone || !isFinite(currentPaceSecPerKm) || currentPaceSecPerKm <= 0) return;
  const inZone = currentPaceSecPerKm >= zone.min && currentPaceSecPerKm <= zone.max;
  if (!inZone && paceAlertState !== "out") {
    paceAlertState = "out";
    if (currentPaceSecPerKm < zone.min) speak("Trop rapide, ralentis");
    else speak("Trop lent, accélère");
  } else if (inZone) {
    paceAlertState = "in";
  }
}

// ---------- navigation ----------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.remove("active"));
  if (id === "screen-home") document.querySelector(".tab-home").classList.add("active");
  if (id === "screen-history") document.querySelector(".tab-history").classList.add("active");
  if (id === "screen-program") document.querySelector(".tab-program").classList.add("active");
}

document.querySelectorAll(".tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (tracking.active) return; // pas de navigation pendant une course
    const tab = btn.dataset.tab;
    if (tab === "home") {
      showScreen("screen-home");
      renderHome();
    } else if (tab === "history") {
      showScreen("screen-history");
      renderHistory();
    } else if (tab === "program") {
      showScreen("screen-program");
      document.getElementById("program-editor").style.display = "none";
      renderProgram();
    }
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
  renderHistory();
  showScreen("screen-history");
});
document.getElementById("btn-open-trends").addEventListener("click", () => {
  trendsOrigin = "history";
  showScreen("screen-trends");
  renderTrends();
});
document.getElementById("btn-open-trends-home").addEventListener("click", () => {
  trendsOrigin = "home";
  showScreen("screen-trends");
  renderTrends();
});
document.getElementById("btn-back-from-trends").addEventListener("click", () => {
  if (trendsOrigin === "home") {
    showScreen("screen-home");
    renderHome();
  } else {
    showScreen("screen-history");
    renderHistory();
  }
});
document.querySelectorAll(".trends-toggle-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    trendsPeriod = btn.dataset.period;
    localStorage.setItem(TRENDS_PERIOD_KEY, trendsPeriod);
    renderTrends();
  });
});
document.getElementById("trends-step-minus").addEventListener("click", () => {
  trendsCount = Math.max(1, trendsCount - 1);
  localStorage.setItem(TRENDS_COUNT_KEY, String(trendsCount));
  renderTrends();
});
document.getElementById("trends-step-plus").addEventListener("click", () => {
  trendsCount = Math.min(52, trendsCount + 1);
  localStorage.setItem(TRENDS_COUNT_KEY, String(trendsCount));
  renderTrends();
});
document.getElementById("btn-back-from-program").addEventListener("click", () => {
  showScreen("screen-home");
  renderHome();
});
document.getElementById("btn-edit-program").addEventListener("click", () => {
  document.getElementById("program-json").value = JSON.stringify(trainingPlan, null, 2);
  document.getElementById("program-editor").style.display = "flex";
});
document.getElementById("btn-cancel-program-json").addEventListener("click", () => {
  document.getElementById("program-editor").style.display = "none";
});
document.getElementById("btn-save-program-json").addEventListener("click", () => {
  try {
    const parsed = JSON.parse(document.getElementById("program-json").value);
    if (!parsed.weeks || !Array.isArray(parsed.weeks)) throw new Error("format invalide");
    trainingPlan = parsed;
    saveTrainingPlan(trainingPlan);
    document.getElementById("program-editor").style.display = "none";
    renderProgram();
    toast("Programme mis à jour");
  } catch (e) {
    toast("JSON invalide — vérifie la syntaxe");
  }
});
document.getElementById("btn-clear-session").addEventListener("click", () => {
  activeSession = null;
  updateActiveSessionBadge();
});
document.getElementById("btn-account").addEventListener("click", () => {
  if (tracking.active) return;
  document.getElementById("hyrox-pace-fast").value = formatMMSS(hyroxPaceFast);
  document.getElementById("hyrox-pace-slow").value = formatMMSS(hyroxPaceSlow);
  showScreen("screen-account");
  updateAccountUI();
});
document.getElementById("btn-back-from-account").addEventListener("click", () => {
  showScreen("screen-home");
  renderHome();
});
document.getElementById("btn-save-hyrox-goal").addEventListener("click", () => {
  const fastVal = parseMMSS(document.getElementById("hyrox-pace-fast").value);
  const slowVal = parseMMSS(document.getElementById("hyrox-pace-slow").value);
  if (fastVal == null || slowVal == null) {
    toast("Format attendu : mm:ss (ex. 5:30)");
    return;
  }
  if (fastVal > slowVal) {
    toast("L'allure rapide doit être plus rapide que l'allure lente.");
    return;
  }
  hyroxPaceFast = fastVal;
  hyroxPaceSlow = slowVal;
  localStorage.setItem(HYROX_PACE_FAST_KEY, String(fastVal));
  localStorage.setItem(HYROX_PACE_SLOW_KEY, String(slowVal));
  updateHyroxTargetDisplays();
  renderHome();
  toast("Objectif enregistré");
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

  updateHyroxTargetDisplays();
  updateActiveSessionBadge();

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

  // objectif HYROX : allure moyenne sur l'ensemble des courses
  const totalM = runs.reduce((s, r) => s + r.distanceM, 0);
  const totalSec = runs.reduce((s, r) => s + r.durationSec, 0);
  const avgPaceAll = totalM > 0 ? totalSec / (totalM / 1000) : 0;
  updateHyroxTargetDisplays();
  updateHyroxStatus("history-hyrox-status", avgPaceAll, runs.length > 0);
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
let detailLine = null;
let editingPath = null;
let editMarkers = [];

function shareUrlFor(run) {
  const base = window.location.href.replace(/index\.html.*$/, "").replace(/\/[^\/]*$/, "/");
  return `${base}share.html?id=${encodeURIComponent(run.id)}&t=${run.shareToken}`;
}

function clearEditMarkers() {
  editMarkers.forEach((m) => { if (detailMap) detailMap.removeLayer(m); });
  editMarkers = [];
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

  // reset édition tracé (au cas où on arrive d'un autre détail resté en cours d'édition)
  editingPath = null;
  clearEditMarkers();
  document.getElementById("track-edit-bar").style.display = "none";
  document.getElementById("track-fix-actions").style.display = "flex";

  setTimeout(() => {
    const mapEl = document.getElementById("detail-map");
    if (detailMap) { detailMap.remove(); detailMap = null; detailLine = null; }
    if (r.path && r.path.length > 1) {
      detailMap = L.map(mapEl, { zoomControl: false, attributionControl: false }).setView([r.path[0].lat, r.path[0].lng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(detailMap);
      const latlngs = r.path.map((p) => [p.lat, p.lng]);
      detailLine = L.polyline(latlngs, { color: "#d6432e", weight: 4 }).addTo(detailMap);
      detailMap.fitBounds(detailLine.getBounds(), { padding: [16, 16] });
    } else {
      mapEl.innerHTML = `<div class="empty-state" style="border:none;">Pas de tracé GPS pour cette course.</div>`;
    }
  }, 50);

  // ---------- correction du tracé (édition sur carte + import KML) ----------
  // Note : distance, allure moyenne ET splits sont recalculés (splits uniformes,
  // un par km complet, aucun split pour un dernier km incomplet — cf. recomputeUniformSplits).
  function applyPathUpdate(newPath) {
    r.path = newPath.map((p) => ({ lat: p.lat, lng: p.lng }));
    r.distanceM = pathDistanceM(newPath);
    r.avgPaceSecPerKm = r.distanceM > 0 ? r.durationSec / (r.distanceM / 1000) : 0;
    r.splits = recomputeUniformSplits(r.distanceM, r.avgPaceSecPerKm);
    r.updatedAt = new Date().toISOString();
    saveRuns();
    markPRs();
    pushRun(r);
    openDetail(r.id); // ré-affiche avec les nouvelles valeurs
    toast("Tracé mis à jour — distance et splits recalculés");
  }

  function renderEditMarkers() {
    clearEditMarkers();
    editingPath.forEach((p, idx) => {
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: 5, color: "#d6432e", weight: 2, fillColor: "#d6432e", fillOpacity: 0.9,
      });
      marker.on("click", () => {
        if (editingPath.length <= 2) { toast("Il faut garder au moins 2 points."); return; }
        editingPath.splice(idx, 1);
        if (detailLine) detailLine.setLatLngs(editingPath.map((p2) => [p2.lat, p2.lng]));
        renderEditMarkers();
      });
      marker.addTo(detailMap);
      editMarkers.push(marker);
    });
    document.getElementById("track-edit-count").textContent = `${editingPath.length} points`;
  }

  document.getElementById("btn-edit-track").onclick = () => {
    if (!r.path || r.path.length < 2) { toast("Pas de tracé GPS à corriger."); return; }
    if (!detailMap) { toast("Carte pas encore prête, réessaie."); return; }
    editingPath = r.path.map((p) => ({ ...p }));
    document.getElementById("track-edit-bar").style.display = "flex";
    document.getElementById("track-fix-actions").style.display = "none";
    renderEditMarkers();
  };

  document.getElementById("btn-finish-edit").onclick = () => {
    if (!editingPath) return;
    const finalPath = editingPath;
    document.getElementById("track-edit-bar").style.display = "none";
    document.getElementById("track-fix-actions").style.display = "flex";
    clearEditMarkers();
    editingPath = null;
    applyPathUpdate(finalPath);
  };

  document.getElementById("btn-import-track").onclick = () => {
    document.getElementById("import-kml-input").click();
  };
  document.getElementById("import-kml-input").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const path = parseKmlPath(text);
      if (!path || path.length < 2) { toast("KML illisible ou vide."); return; }
      applyPathUpdate(path);
    } catch (err) {
      toast("Erreur d'import du fichier KML");
    }
  };

  // ---------- partage ----------
  const shareBtn = document.getElementById("btn-share-run");
  const sharePanel = document.getElementById("share-panel");

  function refreshShareUI() {
    if (r.shareToken) {
      shareBtn.style.display = "none";
      sharePanel.style.display = "flex";
    } else {
      shareBtn.style.display = "block";
      sharePanel.style.display = "none";
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
      renderHistory();
      showScreen("screen-history");
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

  paceAlertState = "in";
  if (activeSession && activeSession.type === "interval") {
    phaseSequence = buildPhaseSequence(activeSession);
    phaseIndex = -1;
    document.getElementById("phase-bar").style.display = "flex";
    advancePhase();
  } else {
    phaseSequence = [];
    phaseIndex = -1;
    document.getElementById("phase-bar").style.display = "none";
    if (activeSession) speak(`Séance ${activeSession.name} démarrée`);
  }

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

  if (!tracking.paused) {
    tickPhase();
    checkPaceAlert(paceNow);
  }
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
  document.getElementById("phase-bar").style.display = "none";
  phaseSequence = [];
  phaseIndex = -1;

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

  activeSession = null;
  updateActiveSessionBadge();

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
// BOUTON RETOUR (matériel/virtuel Android) — piégé dans l'app :
// ne fait rien pendant une course active, renvoie à l'accueil sinon.
// ============================================================
history.pushState({ splitsApp: true }, "");
window.addEventListener("popstate", () => {
  history.pushState({ splitsApp: true }, "");
  if (tracking.active) return;
  showScreen("screen-home");
  renderHome();
});

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
