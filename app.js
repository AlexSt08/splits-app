"use strict";

/* ============================================================
   SPLITS — suivi de course personnel (PWA)
   Stockage local : localStorage. Sync optionnelle : Supabase.
   ============================================================ */

const STORAGE_KEY = "splits.runs.v1";
const GOAL_KEY = "splits.weeklyGoalKm.v1";
const LAST_SYNC_KEY = "splits.lastSync.v1";
const TRENDS_PERIOD_KEY = "splits.trendsPeriod.v1";
const TRENDS_COUNT_KEY = "splits.trendsCount.v1";
const TRAINING_PLAN_KEY = "splits.trainingPlan.v1";
const TRAINING_DONE_KEY = "splits.trainingDone.v1";
const DEFAULT_GOAL_KM = 20;

const MIN_ACCURACY_M = 30;      // ignore les points trop imprécis
const MIN_STEP_M = 3;           // ignore le bruit GPS sous ce seuil

// zone EF par défaut (7:05–8:16/km) proposée comme valeur de départ dans le
// formulaire d'édition d'une étape "continue"
const EF_ZONE = { min: 425, max: 496 };

// marge automatique appliquée autour de l'allure unique saisie dans le
// formulaire d'étape (±0,3 km/h, convertie en secondes/km à la sauvegarde)
const SPEED_MARGIN_KMH = 0.3;

// fenêtre de lissage FIXE pour le calcul indépendant qui alimente le
// graphique post-course (paceHistory) — jamais affectée par les réglages de
// fenêtre du contrôle d'allure en direct (voir rollingPaceSecPerKm plus bas).
// Volontairement plus large que le direct pour un rendu plus lisse (~Fitbit).
const GRAPH_SMOOTHING_WINDOW_MS = 20000;
const PREP_COUNTDOWN_SEC = 10;
const TRANSITION_COUNTDOWN_SEC = 10;

// Allure moyenne affichée/sauvegardée : en séance programme, ne reflète que
// les blocs "continu" (récup et répétitions exclues) ; en course libre,
// distance/temps totaux comme avant.
function getDisplayAvgPace() {
  if (activeSession) {
    return tracking.continuDistanceM > 0 ? tracking.continuElapsedSec / (tracking.continuDistanceM / 1000) : 0;
  }
  return tracking.distanceM > 0 ? currentElapsedSec() / (tracking.distanceM / 1000) : 0;
}

const SUPABASE_URL = "https://fyuvconzpqglvhufixzv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_YFi6gTCa6b6i5APTxMT6vg_x06ofpEr";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ============================================================
// GOOGLE HEALTH (Fitbit) — fréquence cardiaque + activité/exercice
// Le Client ID n'est PAS un secret (contrairement au Client Secret, qui
// reste exclusivement dans l'Edge Function Supabase "google-health").
// activity_and_fitness donne accès à metricsSummary (distance, cadence
// estimée, FC moyenne d'un exercice) — suffisant pour l'essentiel de la
// correction post-course. location.readonly est en plus pour le dénivelé
// et le tracé GPS (export TCX) — bonus, jamais bloquant si absent/refusé.
// Un changement de scope invalide la connexion existante — l'utilisateur
// doit se reconnecter une fois après ce déploiement.
// ============================================================
const GOOGLE_HEALTH_CLIENT_ID = "507298607006-icoje3e3fk4upb301sqmmj319mhkkbmj.apps.googleusercontent.com";
const GOOGLE_HEALTH_SCOPE = "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly https://www.googleapis.com/auth/googlehealth.location.readonly";
// Valeur fixe et canonique, indépendante de l'URL exacte utilisée pour
// accéder à la page (avec ou sans "index.html", avec ou sans slash final).
// Google exige une correspondance EXACTE avec l'URI enregistrée dans Google
// Cloud Console — une valeur calculée dynamiquement à partir de
// window.location.pathname provoquait une erreur "redirect_uri_mismatch"
// selon la façon dont l'app avait été ouverte.
function googleHealthRedirectUri() {
  return "https://alexst08.github.io/splits-app/";
}
function buildGoogleHealthAuthUrl() {
  const params = new URLSearchParams({
    client_id: GOOGLE_HEALTH_CLIENT_ID,
    redirect_uri: googleHealthRedirectUri(),
    response_type: "code",
    access_type: "offline",
    scope: GOOGLE_HEALTH_SCOPE,
    prompt: "consent",
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString();
}

// ============================================================
// PROGRAMME D'ENTRAÎNEMENT — Bloc 1 (VMA 12,1 km/h)
// Chaque séance = liste d'étapes ordonnées. Deux types d'étape :
//  - "continu"      : { label, durationSec, paceMinSec, paceMaxSec }
//  - "repetitions"   : { label, sets, reps, workSec, workPaceMinSec,
//                        workPaceMaxSec, restSec, restBetweenSetsSec, restLabel }
// ============================================================
const DEFAULT_TRAINING_PLAN = {
  name: "Bloc 1 — VMA 12,1 km/h",
  weeks: [
    { week: 1, label: "S1 · Mise en route", sessions: [
      { id: "s1-1", name: "Endurance", steps: [
        { type: "continu", label: "Endurance fondamentale", durationSec: 2100, paceMinSec: 425, paceMaxSec: 496 },
      ]},
      { id: "s1-2", name: "Fractionné court", steps: [
        { type: "continu", label: "Échauffement", durationSec: 900, paceMinSec: 425, paceMaxSec: 496 },
        { type: "repetitions", label: "Allure rapide", sets: 1, reps: 5, workSec: 60, workPaceMinSec: 344, workPaceMaxSec: 356, restSec: 60, restBetweenSetsSec: 0, restLabel: "Intra récup" },
        { type: "continu", label: "Retour au calme", durationSec: 600, paceMinSec: 425, paceMaxSec: 496 },
      ]},
    ]},
    { week: 2, label: "S2 · Montée en volume", sessions: [
      { id: "s2-1", name: "Endurance", steps: [
        { type: "continu", label: "Endurance fondamentale", durationSec: 2400, paceMinSec: 425, paceMaxSec: 496 },
      ]},
      { id: "s2-2", name: "Fractionné court", steps: [
        { type: "continu", label: "Échauffement", durationSec: 900, paceMinSec: 425, paceMaxSec: 496 },
        { type: "repetitions", label: "Allure rapide", sets: 1, reps: 8, workSec: 60, workPaceMinSec: 344, workPaceMaxSec: 356, restSec: 60, restBetweenSetsSec: 0, restLabel: "Intra récup" },
        { type: "continu", label: "Retour au calme", durationSec: 600, paceMinSec: 425, paceMaxSec: 496 },
      ]},
    ]},
    { week: 3, label: "S3 · Choc VMA", sessions: [
      { id: "s3-1", name: "Endurance", steps: [
        { type: "continu", label: "Endurance fondamentale", durationSec: 2700, paceMinSec: 425, paceMaxSec: 496 },
      ]},
      { id: "s3-2", name: "30/30", steps: [
        { type: "continu", label: "Échauffement", durationSec: 600, paceMinSec: 425, paceMaxSec: 496 },
        { type: "repetitions", label: "30/30", sets: 2, reps: 6, workSec: 30, workPaceMinSec: 283, workPaceMaxSec: 298, restSec: 30, restBetweenSetsSec: 90, restLabel: "Intra récup" },
        { type: "continu", label: "Retour au calme", durationSec: 600, paceMinSec: 425, paceMaxSec: 496 },
      ]},
    ]},
    { week: 4, label: "S4 · Semaine la plus chargée", sessions: [
      { id: "s4-1", name: "Endurance", steps: [
        { type: "continu", label: "Endurance fondamentale", durationSec: 3000, paceMinSec: 425, paceMaxSec: 496 },
      ]},
      { id: "s4-2", name: "Fractionné moyen", steps: [
        { type: "continu", label: "Échauffement", durationSec: 600, paceMinSec: 425, paceMaxSec: 496 },
        { type: "repetitions", label: "Allure rapide", sets: 1, reps: 5, workSec: 120, workPaceMinSec: 344, workPaceMaxSec: 356, restSec: 90, restBetweenSetsSec: 0, restLabel: "Intra récup" },
        { type: "continu", label: "Retour au calme", durationSec: 600, paceMinSec: 425, paceMaxSec: 496 },
      ]},
      { id: "s4-3", name: "Endurance légère", steps: [
        { type: "continu", label: "Endurance légère", durationSec: 1800, paceMinSec: 425, paceMaxSec: 496 },
      ]},
    ]},
    { week: 5, label: "S5 · Consolidation", sessions: [
      { id: "s5-1", name: "Endurance", steps: [
        { type: "continu", label: "Endurance fondamentale", durationSec: 3300, paceMinSec: 425, paceMaxSec: 496 },
      ]},
      { id: "s5-2", name: "Fractionné long", steps: [
        { type: "continu", label: "Échauffement", durationSec: 900, paceMinSec: 425, paceMaxSec: 496 },
        { type: "repetitions", label: "Allure rapide", sets: 1, reps: 4, workSec: 180, workPaceMinSec: 344, workPaceMaxSec: 356, restSec: 120, restBetweenSetsSec: 0, restLabel: "Intra récup" },
        { type: "continu", label: "Retour au calme", durationSec: 600, paceMinSec: 425, paceMaxSec: 496 },
      ]},
    ]},
  ],
};

function loadTrainingPlan() {
  try {
    const raw = localStorage.getItem(TRAINING_PLAN_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_TRAINING_PLAN));
    const parsed = JSON.parse(raw);
    const isOldFormat = !parsed.weeks || parsed.weeks.some((w) => w.sessions.some((s) => !s.steps));
    if (isOldFormat) {
      // Plan enregistré avant la refonte en étapes : on repart du Bloc 1 à jour.
      // trainingDone (coches "fait") est stocké séparément par id de séance,
      // donc il reste valable puisque les id ne changent pas.
      return JSON.parse(JSON.stringify(DEFAULT_TRAINING_PLAN));
    }
    return parsed;
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
let trendsPeriod = localStorage.getItem(TRENDS_PERIOD_KEY) || "week";
let trendsCount = Number(localStorage.getItem(TRENDS_COUNT_KEY)) || 10;
let trendsOrigin = "history";
let trainingPlan = loadTrainingPlan();
let trainingDone = loadTrainingDone();
let activeSession = null;   // séance du programme sélectionnée pour la prochaine course
let editingSessionId = null; // séance en cours d'édition sur l'écran Programme
let editingSteps = null;     // copie de travail des étapes pendant l'édition
let collapsedWeeks = null;   // Set d'index de semaines repliées (null = pas encore initialisé)
const SETTINGS_KEY = "splits.settings.v1";
const DEFAULT_SETTINGS = {
  paceAlertsEnabled: true,    // interrupteur global : alertes vocales "Accélère"/"Ralentis" (n'affecte pas les alertes de temps)
  paceCheckContinuSec: 5,     // fréquence du contrôle d'allure vocal, bloc continu
  paceCheckWorkSec: 5,        // fréquence du contrôle d'allure vocal, bloc répétitions
  paceWindowContinuSec: 10,   // fenêtre de lissage du contrôle d'allure EN DIRECT, bloc continu
  paceWindowWorkSec: 10,      // fenêtre de lissage du contrôle d'allure EN DIRECT, bloc répétitions
  timeAlertContinuSec: 600,   // intervalle des annonces "X minutes restantes" (continu), hors les 5 dernières minutes (fixe, toutes les minutes)
  timeAlertWorkSec: 10,       // intervalle des annonces "X secondes" (travail/récup)
};
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
let settings = loadSettings();

let currentUser = null;
let syncing = false;

// ---------- moteur de phases (séances du programme) ----------
let phaseSequence = [];
let phaseIndex = -1;

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
  recentSamples: [],  // {t, distanceM} — pour l'allure lissée sur 10s
  uiTicks: 0,
  paceHistory: [],     // {t: secondes écoulées, pace: sec/km} — courbe d'allure
  phaseLog: [],         // {kind, label, t, distanceM, rep, ...} — un par début de phase
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
// Heure CIVILE locale (celle du téléphone, sans fuseau) au format
// "YYYY-MM-DDTHH:mm:ss" — nécessaire pour le filtre civil_start_time de
// Google Health, qui attend l'heure telle qu'affichée sur la montre, pas
// l'heure UTC (toISOString() serait décalée de l'offset du fuseau local).
function toCivilString(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

// ---------- format mm:ss (durées/allures dans le programme) ----------
function parseMMSS(str) {
  const m = String(str || "").trim().match(/^(\d{1,3}):([0-5]?\d)$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function formatMMSS(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
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

// ============================================================
// PROGRAMME : rendu, édition inline (formulaire) et JSON
// ============================================================
function updateActiveSessionBadge() {
  const badge = document.getElementById("active-session-badge");
  if (activeSession) {
    badge.style.display = "flex";
    document.getElementById("active-session-text").textContent = `Séance : ${activeSession.name}`;
  } else {
    badge.style.display = "none";
  }
}

// Une seule allure est saisie dans le formulaire ; min/max sont dérivés en
// appliquant ±0,3 km/h autour de cette valeur centrale, convertis en sec/km.
function paceZoneFromCenter(centerPaceSec) {
  const base = centerPaceSec && centerPaceSec > 0 ? centerPaceSec : Math.round((EF_ZONE.min + EF_ZONE.max) / 2);
  const speedKmh = 3600 / base;
  const speedSlow = Math.max(0.1, speedKmh - SPEED_MARGIN_KMH);
  const speedFast = speedKmh + SPEED_MARGIN_KMH;
  return {
    min: Math.round(3600 / speedFast), // borne rapide (vitesse la plus haute)
    max: Math.round(3600 / speedSlow), // borne lente (vitesse la plus basse)
  };
}
// Reconstruit l'allure centrale à afficher dans le champ à partir d'une
// zone min/max déjà enregistrée (édition d'une étape existante).
function centerPaceFromZone(minSec, maxSec) {
  if (minSec == null || maxSec == null) return Math.round((EF_ZONE.min + EF_ZONE.max) / 2);
  return Math.round((minSec + maxSec) / 2);
}

// ---- affichage lecture seule d'une étape : libellé et paramètres alignés
// en colonnes (grille) sur toutes les étapes d'une séance ----
function stepDisplayHTML(step) {
  if (step.type === "continu") {
    const center = centerPaceFromZone(step.paceMinSec, step.paceMaxSec);
    return `
      <div class="program-step-row">
        <div class="program-step-label">${step.label || "Continue"}</div>
        <div class="program-step-meta">
          <span class="meta-chip"><span class="field-icon">Δt</span>${formatMMSS(step.durationSec || 0)}</span>
          <span class="meta-chip"><span class="field-icon field-icon-v">v</span>${formatMMSS(center)}</span>
        </div>
      </div>
    `;
  }
  const center = centerPaceFromZone(step.workPaceMinSec, step.workPaceMaxSec);
  const setsPrefix = (step.sets || 1) > 1 ? `${step.sets} <span class="field-times">×</span> ` : "";
  return `
    <div class="program-step-row">
      <div class="program-step-label">${step.label || "Répétitions"}</div>
      <div class="program-step-meta">
        <span class="meta-chip">${setsPrefix}${step.reps} <span class="field-times">×</span> <span class="field-icon">Δt</span>${formatMMSS(step.workSec || 0)}</span>
        <span class="meta-chip"><span class="field-icon field-icon-v">v</span>${formatMMSS(center)}</span>
      </div>
      <div class="program-step-recup">
        <span>Intra récup ${formatMMSS(step.restSec || 0)}</span>
        ${(step.sets || 1) > 1 ? `<span>Extra récup ${formatMMSS(step.restBetweenSetsSec || 0)}</span>` : ""}
      </div>
    </div>
  `;
}

function stepEditorRowHTML(step, i) {
  const isRep = step.type === "repetitions";
  return `
    <div class="step-edit-row">
      <div class="step-edit-head">
        <select class="step-type account-input" data-i="${i}">
          <option value="continu" ${!isRep ? "selected" : ""}>Continue</option>
          <option value="repetitions" ${isRep ? "selected" : ""}>Répétitions</option>
        </select>
        <div class="step-edit-arrows">
          <button type="button" data-action="step-up" data-i="${i}" title="Monter">↑</button>
          <button type="button" data-action="step-down" data-i="${i}" title="Descendre">↓</button>
          <button type="button" data-action="del-step" data-i="${i}" title="Supprimer">✕</button>
        </div>
      </div>
      <input class="step-label account-input" data-i="${i}" placeholder="Libellé (ex. Échauffement)" value="${(step.label || "").replace(/"/g, "&quot;")}" />
      ${!isRep ? `
        <div class="step-fields-row step-fields-continu">
          <div class="field-with-icon">
            <span class="field-icon">Δt</span>
            <input class="step-duration mmss-input account-input" data-i="${i}" inputmode="numeric" pattern="[0-9:]*" placeholder="mm:ss" value="${formatMMSS(step.durationSec || 0)}" />
          </div>
          <div class="field-with-icon">
            <span class="field-icon field-icon-v">v</span>
            <input class="step-pace mmss-input account-input" data-i="${i}" inputmode="numeric" pattern="[0-9:]*" placeholder="mm:ss" value="${formatMMSS(centerPaceFromZone(step.paceMinSec, step.paceMaxSec))}" />
          </div>
        </div>
      ` : `
        <input class="step-sets account-input step-sets-input" data-i="${i}" type="number" inputmode="numeric" min="1" placeholder="Séries" value="${step.sets || 1}" />
        <div class="step-fields-row step-fields-rep">
          <input class="step-reps account-input step-reps-input" data-i="${i}" type="number" inputmode="numeric" min="1" placeholder="Rép." value="${step.reps || 1}" />
          <span class="field-times">×</span>
          <div class="field-with-icon">
            <span class="field-icon">Δt</span>
            <input class="step-worksec mmss-input account-input" data-i="${i}" inputmode="numeric" pattern="[0-9:]*" placeholder="mm:ss" value="${formatMMSS(step.workSec || 60)}" />
          </div>
          <div class="field-with-icon">
            <span class="field-icon field-icon-v">v</span>
            <input class="step-pace mmss-input account-input" data-i="${i}" inputmode="numeric" pattern="[0-9:]*" placeholder="mm:ss" value="${formatMMSS(centerPaceFromZone(step.workPaceMinSec, step.workPaceMaxSec))}" />
          </div>
        </div>
        <div class="step-fields-row">
          <div class="field-with-label">
            <span class="field-label-text">Intra récup</span>
            <input class="step-restsec mmss-input account-input" data-i="${i}" inputmode="numeric" pattern="[0-9:]*" placeholder="mm:ss" value="${formatMMSS(step.restSec || 60)}" />
          </div>
          <div class="field-with-label">
            <span class="field-label-text">Extra récup</span>
            <input class="step-restbetween mmss-input account-input" data-i="${i}" inputmode="numeric" pattern="[0-9:]*" placeholder="mm:ss" value="${formatMMSS(step.restBetweenSetsSec || 0)}" />
          </div>
        </div>
      `}
    </div>
  `;
}

function collectStepsFromForm() {
  const rows = document.querySelectorAll(".step-edit-row");
  return Array.from(rows).map((row) => {
    const type = row.querySelector(".step-type").value;
    const label = row.querySelector(".step-label").value.trim();
    if (type === "continu") {
      const center = parseMMSS(row.querySelector(".step-pace").value);
      const zone = paceZoneFromCenter(center);
      return {
        type: "continu",
        label,
        durationSec: parseMMSS(row.querySelector(".step-duration").value) || 0,
        paceMinSec: zone.min,
        paceMaxSec: zone.max,
      };
    }
    const center = parseMMSS(row.querySelector(".step-pace").value);
    const zone = paceZoneFromCenter(center);
    return {
      type: "repetitions",
      label,
      sets: Math.max(1, parseInt(row.querySelector(".step-sets").value, 10) || 1),
      reps: Math.max(1, parseInt(row.querySelector(".step-reps").value, 10) || 1),
      workSec: parseMMSS(row.querySelector(".step-worksec").value) || 60,
      workPaceMinSec: zone.min,
      workPaceMaxSec: zone.max,
      restSec: parseMMSS(row.querySelector(".step-restsec").value) || 60,
      restBetweenSetsSec: parseMMSS(row.querySelector(".step-restbetween").value) || 0,
      restLabel: "Intra récup",
    };
  });
}

function startEditSession(id) {
  const session = findSessionById(id);
  if (!session) return;
  editingSessionId = id;
  editingSteps = JSON.parse(JSON.stringify(session.steps || []));
  renderProgram();
}

// Détermine l'état plié/déplié initial : tout plié, sauf la première semaine
// où au moins une séance n'est pas encore marquée "fait". Si tout est fait,
// tout reste plié.
function initCollapsedWeeksIfNeeded() {
  if (collapsedWeeks !== null) return;
  collapsedWeeks = new Set();
  let targetIdx = -1;
  trainingPlan.weeks.forEach((w, i) => {
    if (targetIdx !== -1) return;
    const doneCount = w.sessions.filter((s) => trainingDone[s.id]).length;
    if (doneCount < w.sessions.length) targetIdx = i;
  });
  trainingPlan.weeks.forEach((w, i) => {
    if (i !== targetIdx) collapsedWeeks.add(i);
  });
}

function renderProgram() {
  document.getElementById("program-block-name").textContent = trainingPlan.name || "Programme";
  const list = document.getElementById("program-list");
  list.innerHTML = "";
  initCollapsedWeeksIfNeeded();

  trainingPlan.weeks.forEach((w, wIdx) => {
    const weekEl = document.createElement("div");
    weekEl.className = "program-week";
    const doneCount = w.sessions.filter((s) => trainingDone[s.id]).length;
    const isCollapsed = collapsedWeeks.has(wIdx);

    const headerBtn = document.createElement("button");
    headerBtn.type = "button";
    headerBtn.className = "program-week-label";
    headerBtn.dataset.action = "toggle-week";
    headerBtn.dataset.week = String(wIdx);
    headerBtn.innerHTML = `<span class="week-chevron">${isCollapsed ? "▸" : "▾"}</span> ${w.label} · ${doneCount}/${w.sessions.length}`;
    weekEl.appendChild(headerBtn);

    const body = document.createElement("div");
    body.className = "program-week-body";
    body.style.display = isCollapsed ? "none" : "flex";

    w.sessions.forEach((s) => {
      const card = document.createElement("div");
      card.className = "program-session" + (trainingDone[s.id] ? " done" : "");

      if (s.id === editingSessionId) {
        card.innerHTML = `
          <div class="program-session-top">
            <div class="program-session-name">${s.name}</div>
          </div>
          ${editingSteps.map((st, i) => stepEditorRowHTML(st, i)).join("")}
          <button type="button" class="fix-btn" data-action="add-step">+ Ajouter une étape</button>
          <div class="program-session-actions">
            <button type="button" class="program-start" data-action="save-session-edit">Enregistrer</button>
            <button type="button" class="fix-btn" data-action="cancel-session-edit">Annuler</button>
          </div>
        `;
      } else {
        card.innerHTML = `
          <div class="program-session-top">
            <div class="program-session-name">${s.name}</div>
            <button class="program-check" data-action="check" data-id="${s.id}">${trainingDone[s.id] ? "✓ Fait" : "Marquer fait"}</button>
          </div>
          <div class="program-steps">
            ${(s.steps || []).map((st) => stepDisplayHTML(st)).join("")}
          </div>
          <div class="program-session-actions">
            <button class="program-start" data-action="start" data-id="${s.id}">Démarrer</button>
            <button class="fix-btn" data-action="edit-session" data-id="${s.id}">Modifier</button>
          </div>
        `;
      }
      body.appendChild(card);
    });

    weekEl.appendChild(body);
    list.appendChild(weekEl);
  });
}

document.getElementById("program-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;

  if (action === "toggle-week") {
    const idx = Number(btn.dataset.week);
    if (collapsedWeeks.has(idx)) collapsedWeeks.delete(idx);
    else collapsedWeeks.add(idx);
    renderProgram();
  } else if (action === "check") {
    const id = btn.dataset.id;
    if (trainingDone[id]) delete trainingDone[id];
    else trainingDone[id] = new Date().toISOString();
    saveTrainingDone(trainingDone);
    renderProgram();
  } else if (action === "start") {
    const session = findSessionById(btn.dataset.id);
    if (!session) return;
    activeSession = session;
    updateActiveSessionBadge();
    showScreen("screen-home");
    toast(`Séance "${session.name}" sélectionnée — appuie sur Démarrer`);
  } else if (action === "edit-session") {
    startEditSession(btn.dataset.id);
  } else if (action === "cancel-session-edit") {
    editingSessionId = null;
    editingSteps = null;
    renderProgram();
  } else if (action === "save-session-edit") {
    const steps = collectStepsFromForm();
    if (steps.length === 0) { toast("Ajoute au moins une étape."); return; }
    const session = findSessionById(editingSessionId);
    if (session) {
      session.steps = steps;
      saveTrainingPlan(trainingPlan);
      toast("Séance mise à jour");
    }
    editingSessionId = null;
    editingSteps = null;
    renderProgram();
  } else if (action === "add-step") {
    editingSteps.push({ type: "continu", label: "", durationSec: 600, paceMinSec: EF_ZONE.min, paceMaxSec: EF_ZONE.max });
    renderProgram();
  } else if (action === "del-step") {
    editingSteps.splice(Number(btn.dataset.i), 1);
    renderProgram();
  } else if (action === "step-up") {
    const i = Number(btn.dataset.i);
    if (i > 0) {
      [editingSteps[i - 1], editingSteps[i]] = [editingSteps[i], editingSteps[i - 1]];
      renderProgram();
    }
  } else if (action === "step-down") {
    const i = Number(btn.dataset.i);
    if (i < editingSteps.length - 1) {
      [editingSteps[i + 1], editingSteps[i]] = [editingSteps[i], editingSteps[i + 1]];
      renderProgram();
    }
  }
});
document.getElementById("program-list").addEventListener("change", (e) => {
  if (!e.target.classList.contains("step-type")) return;
  const i = Number(e.target.dataset.i);
  const label = editingSteps[i].label;
  editingSteps[i] = e.target.value === "continu"
    ? { type: "continu", label, durationSec: 600, paceMinSec: EF_ZONE.min, paceMaxSec: EF_ZONE.max }
    : { type: "repetitions", label, sets: 1, reps: 5, workSec: 60, workPaceMinSec: 340, workPaceMaxSec: 360, restSec: 60, restBetweenSetsSec: 0, restLabel: "Intra récup" };
  renderProgram();
});
// saisie guidée mm:ss : insère automatiquement les deux-points pendant la frappe
document.getElementById("program-list").addEventListener("input", (e) => {
  if (!e.target.classList.contains("mmss-input")) return;
  const digits = e.target.value.replace(/[^\d]/g, "").slice(0, 5);
  e.target.value = digits.length > 2 ? `${digits.slice(0, digits.length - 2)}:${digits.slice(-2)}` : digits;
});

// ============================================================
// PHASE ENGINE (déroulé d'une séance) & alerte d'allure
// ============================================================
function buildPhasesForStep(step) {
  const phases = [];
  if (step.type === "continu") {
    if (step.durationSec > 0) {
      phases.push({
        kind: "continu",
        label: step.label || "Continu",
        durationSec: step.durationSec,
        paceMinSec: step.paceMinSec,
        paceMaxSec: step.paceMaxSec,
      });
    }
  } else if (step.type === "repetitions") {
    const sets = step.sets || 1;
    for (let set = 1; set <= sets; set++) {
      for (let rep = 1; rep <= step.reps; rep++) {
        phases.push({
          kind: "work",
          label: step.label || "Allure rapide",
          durationSec: step.workSec,
          paceMinSec: step.workPaceMinSec,
          paceMaxSec: step.workPaceMaxSec,
          rep, totalReps: step.reps, set, totalSets: sets,
        });
        const isLastRepOfSet = rep === step.reps;
        const isLastSet = set === sets;
        if (!(isLastRepOfSet && isLastSet)) {
          if (isLastRepOfSet && !isLastSet) {
            phases.push({ kind: "restSet", label: "Extra récup", durationSec: step.restBetweenSetsSec || 0 });
          } else {
            phases.push({ kind: "rest", label: step.restLabel || "Intra récup", durationSec: step.restSec });
          }
        }
      }
    }
  }
  return phases;
}

// Insère une phase "transition" (décompte de 10s annoncé) uniquement au
// passage d'un type de bloc à un autre (continu <-> répétitions), jamais
// entre deux répétitions ni entre travail/récup d'un même bloc.
function buildPhaseSequence(session) {
  const steps = session.steps || [];
  const phases = [];
  steps.forEach((step, i) => {
    if (i > 0 && steps[i - 1].type !== step.type) {
      phases.push({
        kind: "transition",
        label: `Changement de bloc dans ${TRANSITION_COUNTDOWN_SEC} secondes`,
        durationSec: TRANSITION_COUNTDOWN_SEC,
      });
    }
    phases.push(...buildPhasesForStep(step));
  });
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
  updatePhaseUI();
  if (activeSession) {
    tracking.phaseLog.push({
      kind: phase.kind,
      label: phase.label,
      t: Math.round(currentElapsedSec()),
      distanceM: tracking.distanceM,
      rep: phase.rep || null,
      totalReps: phase.totalReps || null,
      set: phase.set || null,
      totalSets: phase.totalSets || null,
    });
  }
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

// Décomptes vocaux pendant une phase en cours (pas au changement de phase,
// déjà annoncé par advancePhase). Structure fixe, intervalles réglables
// dans Compte & réglages :
//  - continue (EF, échauffement, retour au calme) : toutes les
//    settings.timeAlertContinuSec, puis toutes les minutes sur les 5
//    dernières minutes (comportement fixe, non réglable)
//  - travail / récupération (intra ou extra) : toutes les
//    settings.timeAlertWorkSec
function announcePhaseCountdown(phase) {
  const r = phase.remainingSec;
  if (phase.kind === "continu") {
    const interval = settings.timeAlertContinuSec;
    if (r > 300 && interval > 0 && r % interval === 0) {
      const mins = Math.round(r / 60);
      speak(`${mins} minutes restantes`);
    } else if (r <= 300 && r % 60 === 0) {
      const mins = Math.round(r / 60);
      speak(`${mins} minute${mins > 1 ? "s" : ""} restante${mins > 1 ? "s" : ""}`);
    }
  } else if (phase.kind === "transition") {
    if (r <= 5 && r >= 1) speak(String(r));
  } else if ((phase.kind === "work" || phase.kind === "rest" || phase.kind === "restSet") && settings.timeAlertWorkSec > 0 && r % settings.timeAlertWorkSec === 0) {
    speak(`${r} secondes`);
  }
}

function tickPhase() {
  if (phaseIndex < 0 || phaseIndex >= phaseSequence.length) return;
  const phase = phaseSequence[phaseIndex];
  phase.remainingSec -= 1;
  if (phase.remainingSec <= 0) {
    advancePhase();
    return;
  }
  updatePhaseUI();
  announcePhaseCountdown(phase);
}

// Zone d'allure de la phase en cours — chaque étape (continue ou répétitions)
// porte sa propre allure (dérivée d'une valeur unique ±0,3 km/h à la saisie).
function getCurrentTargetZone() {
  if (phaseIndex < 0 || phaseIndex >= phaseSequence.length) return null;
  const phase = phaseSequence[phaseIndex];
  if ((phase.kind === "continu" || phase.kind === "work") && phase.paceMinSec != null && phase.paceMaxSec != null) {
    return { min: phase.paceMinSec, max: phase.paceMaxSec };
  }
  return null;
}

// Allure lissée sur une fenêtre donnée (en ms), à partir des points GPS
// enregistrés, plutôt que l'allure instantanée point-à-point. La fenêtre est
// un paramètre : le contrôle d'allure en direct et le graphique post-course
// utilisent chacun leur propre fenêtre, totalement indépendantes l'une de
// l'autre (voir getPaceWindowMs / GRAPH_SMOOTHING_WINDOW_MS).
function rollingPaceSecPerKm(windowMs) {
  const samples = tracking.recentSamples;
  if (samples.length < 2) return null;
  const now = Date.now();
  let ref = null;
  for (const s of samples) {
    if (now - s.t <= windowMs) { ref = s; break; }
  }
  // Aucun échantillon dans la fenêtre (arrêt réel, mouvement sous le seuil
  // de 3 m/tick, ou signal perdu) : pas de repli sur le plus ancien
  // échantillon disponible, qui pourrait dater de bien plus que la fenêtre
  // et gonfler artificiellement le temps écoulé sans borne.
  if (!ref) return null;
  const distM = tracking.distanceM - ref.distanceM;
  const timeSec = (now - ref.t) / 1000;
  if (distM < 5 || timeSec < 2) return null; // pas assez de signal pour une estimation fiable
  return timeSec / (distM / 1000);
}

// Intervalle (en secondes) du contrôle d'allure vocal — réglable par type de
// bloc dans Compte & réglages. Hors continu/répétitions (récup, transition,
// course libre), l'alerte est de toute façon désactivée par getCurrentTargetZone.
function getPaceCheckIntervalSec() {
  if (phaseIndex >= 0 && phaseIndex < phaseSequence.length && phaseSequence[phaseIndex].kind === "work") {
    return settings.paceCheckWorkSec;
  }
  return settings.paceCheckContinuSec;
}

// Fenêtre de lissage (en ms) du contrôle d'allure EN DIRECT — réglable par
// type de bloc. N'a aucune incidence sur le graphique post-course, qui
// utilise sa propre fenêtre fixe (GRAPH_SMOOTHING_WINDOW_MS).
function getPaceWindowMs() {
  if (phaseIndex >= 0 && phaseIndex < phaseSequence.length && phaseSequence[phaseIndex].kind === "work") {
    return settings.paceWindowWorkSec * 1000;
  }
  return settings.paceWindowContinuSec * 1000;
}

// Taille du tampon de points GPS récents à conserver — doit couvrir la plus
// large des fenêtres actives (direct réglable + graphique fixe), sans quoi
// le calcul le plus long manquerait de données.
function getRecentSamplesRetentionMs() {
  return Math.max(settings.paceWindowContinuSec, settings.paceWindowWorkSec, GRAPH_SMOOTHING_WINDOW_MS / 1000) * 1000 + 5000;
}

// Répète l'alerte tant que l'allure lissée reste hors de la fourchette
// cible ; silencieux dès le retour dans la zone. Ne fait rien si l'utilisateur
// a désactivé les alertes de vitesse dans Compte & réglages — n'affecte pas
// les alertes de temps (announcePhaseCountdown), qui restent indépendantes.
function checkPaceAlert(currentPaceSecPerKm) {
  if (!settings.paceAlertsEnabled) return;
  const zone = getCurrentTargetZone();
  if (!zone || !isFinite(currentPaceSecPerKm) || currentPaceSecPerKm <= 0) return;
  const inZone = currentPaceSecPerKm >= zone.min && currentPaceSecPerKm <= zone.max;
  if (!inZone) {
    const mins = Math.floor(currentPaceSecPerKm / 60);
    const secs = String(Math.round(currentPaceSecPerKm % 60)).padStart(2, "0");
    const directive = currentPaceSecPerKm < zone.min ? "Ralentir" : "Accélérer";
    speak(`${directive}, allure ${mins} ${secs}`);
  }
}

// ============================================================
// HISTORIQUE D'ALLURE PAR COURSE — deux templates
//  - courbe continue (courses libres / séances sans répétitions)
//  - barres par répétition réelle (séances contenant des répétitions)
// ============================================================
function computePhaseAvgPace(phaseLog, finalElapsedSec, finalDistanceM) {
  const entries = [];
  for (let i = 0; i < phaseLog.length; i++) {
    const cur = phaseLog[i];
    const next = phaseLog[i + 1];
    const endT = next ? next.t : finalElapsedSec;
    const endDist = next ? next.distanceM : finalDistanceM;
    const durSec = Math.max(1, endT - cur.t);
    const distM = Math.max(0, endDist - cur.distanceM);
    const avgPaceSecPerKm = distM > 5 ? durSec / (distM / 1000) : null;
    entries.push({ ...cur, durationSec: durSec, avgPaceSecPerKm });
  }
  return entries;
}

// Isole, à partir du journal de phases, les échantillons d'allure (pace_history)
// qui tombent dans chaque bloc "continu" (ex. échauffement, retour au calme).
function buildContinuSegments(phaseLog, paceHistory, finalElapsedSec) {
  if (!phaseLog || !phaseLog.length || !paceHistory || !paceHistory.length) return [];
  const segments = [];
  for (let i = 0; i < phaseLog.length; i++) {
    if (phaseLog[i].kind !== "continu") continue;
    const startT = phaseLog[i].t;
    const endT = i + 1 < phaseLog.length ? phaseLog[i + 1].t : finalElapsedSec;
    const samples = paceHistory.filter((p) => p.t >= startT && p.t < endT);
    if (samples.length > 1) segments.push(samples);
  }
  return segments;
}
// Recolle plusieurs blocs continus bout à bout sur un axe temporel relatif —
// ignore l'écart réel entre les blocs (ex. le bloc répétitions entre
// échauffement et retour au calme) pour éviter un grand vide au milieu.
// Retourne aussi les positions (en secondes relatives) où placer un
// séparateur visuel entre deux blocs recollés.
function concatSegments(segments) {
  const combined = [];
  const boundaries = [];
  let offset = 0;
  segments.forEach((seg) => {
    const segStart = seg[0].t;
    seg.forEach((p) => combined.push({ t: offset + (p.t - segStart), pace: p.pace }));
    const segDuration = seg[seg.length - 1].t - segStart;
    offset += segDuration + 1;
    boundaries.push(offset - 0.5);
  });
  boundaries.pop(); // pas de séparateur après le tout dernier bloc
  return { combined, boundaries };
}

// Filtre robuste anti-bruit GPS : élimine les échantillons trop éloignés de
// la médiane (méthode MAD — Median Absolute Deviation), plutôt qu'un seuil
// fixe, pour s'adapter à n'importe quelle allure cible (EF lente ou tempo
// rapide). Les sauts de signal GPS produisent des pics d'allure irréalistes
// (ex. 4'57 ou 107 min/km sur une même course EF à ~7-8 min/km) qui
// faussaient le range affiché et l'échelle de la courbe.
function filterPaceOutliers(samples) {
  if (samples.length < 5) return samples;
  const sortedPaces = samples.map((s) => s.pace).sort((a, b) => a - b);
  const mid = Math.floor(sortedPaces.length / 2);
  const median = sortedPaces.length % 2 ? sortedPaces[mid] : (sortedPaces[mid - 1] + sortedPaces[mid]) / 2;
  const deviations = sortedPaces.map((p) => Math.abs(p - median)).sort((a, b) => a - b);
  const madMid = Math.floor(deviations.length / 2);
  const mad = deviations.length % 2 ? deviations[madMid] : (deviations[madMid - 1] + deviations[madMid]) / 2;
  const scaledMad = mad * 1.4826 || median * 0.1 || 1; // équivalent écart-type ; garde-fou si MAD=0
  const threshold = Math.max(scaledMad * 2.5, median * 0.25); // tolère au moins ±25% du médian
  return samples.filter((s) => Math.abs(s.pace - median) <= threshold);
}

// Réduit le nombre de points affichés en moyennant l'allure par intervalle
// de temps régulier — lisse mécaniquement le bruit résiduel et allège le
// tracé avant de générer la courbe.
function resamplePaceSeries(samples, maxPoints) {
  if (samples.length <= maxPoints) return samples;
  const minT = samples[0].t;
  const maxT = samples[samples.length - 1].t;
  const span = Math.max(maxT - minT, 1);
  const buckets = Array.from({ length: maxPoints }, () => []);
  samples.forEach((p) => {
    const idx = Math.min(maxPoints - 1, Math.floor(((p.t - minT) / span) * maxPoints));
    buckets[idx].push(p);
  });
  return buckets
    .filter((b) => b.length > 0)
    .map((b) => ({
      t: b.reduce((a, p) => a + p.t, 0) / b.length,
      pace: b.reduce((a, p) => a + p.pace, 0) / b.length,
    }));
}

// Convertit une liste de points {x, y} en un chemin SVG lissé (Catmull-Rom
// converti en courbes de Bézier cubiques) — donne le rendu arrondi "façon
// Fitbit" plutôt que des segments droits point à point.
function smoothSvgPath(points) {
  if (points.length < 3) {
    return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  }
  let d = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

function renderPaceLineChart(el, paceHistory, boundaries, avgOverride) {
  if (!paceHistory || paceHistory.length < 2) return false;
  const maxT = Math.max(paceHistory[paceHistory.length - 1].t, 1); // échelle temporelle sur les données brutes, avant filtrage
  const filtered = filterPaceOutliers(paceHistory);
  if (filtered.length < 2) return false;
  const paces = filtered.map((p) => p.pace);
  const minPace = Math.min(...paces);
  const maxPace = Math.max(...paces);
  // Moyenne affichée = celle du résumé (distance/temps réels), pas une
  // moyenne arithmétique des échantillons instantanés : la moyenne d'une
  // série d'allures (sec/km) ne correspond pas au vrai ratio distance/temps
  // dès que l'allure varie (moyenne harmonique ≠ arithmétique) — recalculer
  // ici produisait un chiffre différent (jusqu'à ~20s d'écart) de celui du
  // résumé en haut de page pour la même course.
  const avgPace = avgOverride != null && avgOverride > 0
    ? avgOverride
    : paces.reduce((a, b) => a + b, 0) / paces.length;
  const range = Math.max(maxPace - minPace, 1);
  const W = 300, H = 90, pad = 4;
  const yFor = (pace) => {
    const yNorm = (maxPace - pace) / range; // plus rapide (allure basse) => plus haut
    return pad + (1 - yNorm) * (H - 2 * pad);
  };
  const resampled = resamplePaceSeries(filtered, 40);
  const curvePoints = resampled.map((p) => ({
    x: pad + (p.t / maxT) * (W - 2 * pad),
    y: yFor(p.pace),
  }));
  const pathD = smoothSvgPath(curvePoints);
  const separators = (boundaries || []).map((t) => {
    const x = pad + (t / maxT) * (W - 2 * pad);
    return `<line x1="${x.toFixed(1)}" y1="${pad}" x2="${x.toFixed(1)}" y2="${H - pad}" stroke="#6d7880" stroke-width="1" stroke-dasharray="3,3" vector-effect="non-scaling-stroke" />`;
  }).join("");
  const avgY = yFor(avgPace);
  const avgLine = `<line x1="${pad}" y1="${avgY.toFixed(1)}" x2="${W - pad}" y2="${avgY.toFixed(1)}" stroke="#d9a73b" stroke-width="1" stroke-dasharray="4,3" vector-effect="non-scaling-stroke" />`;
  el.innerHTML = `
    <div class="pace-chart-label">Allure dans le temps <span class="pace-chart-avg">— moy. ${fmtPace(avgPace)}/km</span></div>
    <div class="pace-chart-range-top"><span>${fmtPace(minPace)}/km</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="pace-chart-svg" preserveAspectRatio="none">
      ${separators}
      ${avgLine}
      <path d="${pathD}" fill="none" stroke="#d6432e" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="pace-chart-range-bottom"><span>${fmtPace(maxPace)}/km</span></div>
  `;
  return true;
}

function renderRepsBarChart(el, entries) {
  const workEntries = entries.filter((e) => e.kind === "work" && e.avgPaceSecPerKm);
  if (workEntries.length === 0) return false;
  const paces = workEntries.map((e) => e.avgPaceSecPerKm);
  const maxPace = Math.max(...paces);
  const minPace = Math.min(...paces);
  const range = Math.max(maxPace - minPace, 1);
  el.innerHTML = `<div class="pace-chart-label">Allure par répétition</div><div class="trends-bars reps-bars"></div>`;
  const barsEl = el.querySelector(".reps-bars");
  workEntries.forEach((e) => {
    const pct = Math.max(4, 35 + (65 * (maxPace - e.avgPaceSecPerKm)) / range);
    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.innerHTML = `
      <div class="trend-bar-val">${fmtPace(e.avgPaceSecPerKm)}</div>
      <div class="trend-bar-track"><div class="trend-bar-fill" style="height:${pct}%"></div></div>
      <div class="trend-bar-label">${e.rep || ""}${e.totalSets > 1 ? ` S${e.set}` : ""}</div>
    `;
    barsEl.appendChild(bar);
  });
  return true;
}

// Empile, dans le même bloc : barres par répétition (si présentes) PUIS
// courbe continue recollée des blocs "continu" (si présents) — les deux
// peuvent coexister pour une séance programme mixte.
function renderRunPaceHistory(r) {
  const stack = document.getElementById("detail-pace-history");
  stack.innerHTML = "";
  let shown = false;

  if (r.hasRepetitions && r.phaseLog && r.phaseLog.length > 0) {
    const entries = computePhaseAvgPace(r.phaseLog, r.durationSec, r.distanceM);
    const repsEl = document.createElement("div");
    repsEl.className = "pace-history-block";
    if (renderRepsBarChart(repsEl, entries)) { stack.appendChild(repsEl); shown = true; }

    const segments = buildContinuSegments(r.phaseLog, r.paceHistory, r.durationSec);
    if (segments.length > 0) {
      const { combined, boundaries } = concatSegments(segments);
      const continuEl = document.createElement("div");
      continuEl.className = "pace-history-block";
      if (renderPaceLineChart(continuEl, combined, boundaries, r.avgPaceSecPerKm)) { stack.appendChild(continuEl); shown = true; }
    }
  } else if (r.paceHistory && r.paceHistory.length > 1) {
    const el = document.createElement("div");
    el.className = "pace-history-block";
    if (renderPaceLineChart(el, r.paceHistory, [], r.avgPaceSecPerKm)) { stack.appendChild(el); shown = true; }
  }

  stack.classList.toggle("show", shown);
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
      editingSessionId = null;
      editingSteps = null;
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
    collapsedWeeks = null; // recalculé au prochain rendu, le plan a pu changer de structure
    document.getElementById("program-editor").style.display = "none";
    renderProgram();
    saveTrainingPlan(trainingPlan);
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
  showScreen("screen-account");
  updateAccountUI();
  updateGoogleHealthStatus();
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

  renderRunPaceHistory(r);
  tryShowRunHeartRate(r);
  refreshElevCell(r);
  setupFitbitCompare(r);

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

  // ---------- bottom sheet du tracé GPS : carte créée uniquement à l'ouverture ----------
  function openMapSheet() {
    document.getElementById("map-sheet-backdrop").classList.add("show");
    document.getElementById("map-sheet").classList.add("show");
    const legendEl = document.getElementById("map-legend");
    setTimeout(() => {
      const mapEl = document.getElementById("detail-map");
      if (detailMap) { detailMap.remove(); detailMap = null; detailLine = null; }
      if (r.path && r.path.length > 1) {
        detailMap = L.map(mapEl, { zoomControl: false, attributionControl: false }).setView([r.path[0].lat, r.path[0].lng], 15);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(detailMap);
        const latlngs = r.path.map((p) => [p.lat, p.lng]);
        detailLine = L.polyline(latlngs, { color: "#d6432e", weight: 4 }).addTo(detailMap);
        let bounds = detailLine.getBounds();

        // tracé Fitbit (montre) superposé, s'il a été récupéré via
        // "Comparer avec la montre Fitbit" — couleur distincte + légende.
        const hasFitbitTrack = r.fitbitTrackpoints && r.fitbitTrackpoints.length > 1;
        if (hasFitbitTrack) {
          const fitbitLatlngs = r.fitbitTrackpoints.map((p) => [p.lat, p.lng]);
          const fitbitLine = L.polyline(fitbitLatlngs, { color: "#d9a73b", weight: 3, dashArray: "6,4" }).addTo(detailMap);
          bounds = bounds.extend(fitbitLine.getBounds());
        }
        legendEl.style.display = hasFitbitTrack ? "flex" : "none";

        detailMap.fitBounds(bounds, { padding: [16, 16] });
      } else {
        mapEl.innerHTML = `<div class="empty-state" style="border:none;">Pas de tracé GPS pour cette course.</div>`;
        legendEl.style.display = "none";
      }
      if (detailMap) detailMap.invalidateSize();
    }, 260); // laisse l'animation du bottom sheet se terminer avant d'initialiser Leaflet
  }
  function closeMapSheet() {
    document.getElementById("map-sheet-backdrop").classList.remove("show");
    document.getElementById("map-sheet").classList.remove("show");
    editingPath = null;
    clearEditMarkers();
    document.getElementById("track-edit-bar").style.display = "none";
    document.getElementById("track-fix-actions").style.display = "flex";
    if (detailMap) { detailMap.remove(); detailMap = null; detailLine = null; }
  }
  document.getElementById("btn-open-map").onclick = openMapSheet;
  document.getElementById("btn-close-map").onclick = closeMapSheet;
  document.getElementById("map-sheet-backdrop").onclick = closeMapSheet;

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
document.getElementById("btn-lock-fab").addEventListener("click", () => setScreenLock(true));

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
    recentSamples: [],
    uiTicks: 0,
    paceHistory: [],
    phaseLog: [],
    prepping: true,
    continuDistanceM: 0,
    continuElapsedSec: 0,
    repDistanceM: 0,
    repElapsedSec: 0,
  };
  showScreen("screen-track");
  document.getElementById("lock-overlay").classList.remove("show");
  document.getElementById("btn-pause").textContent = "Pause";
  document.getElementById("btn-pause").className = "ctrl-btn pause";
  document.getElementById("track-status").textContent = "PRÉPARATION";
  updateTrackUI();
  setGpsStatus("searching", "Recherche du signal…");

  const hasRepBlocks = !!(activeSession && activeSession.steps && activeSession.steps.some((s) => s.type === "repetitions"));
  document.getElementById("track-pace-rep-cell").style.display = hasRepBlocks ? "" : "none";
  document.getElementById("track-pace-rep").textContent = "—'—\"";

  // GPS démarré tout de suite (pour avoir un fix prêt) mais rien n'est
  // comptabilisé tant que tracking.prepping reste vrai (cf. onPosition).
  tracking.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });

  requestWakeLock();

  setTimeout(() => {
    const mapEl = document.getElementById("track-map");
    tracking.map = L.map(mapEl, { zoomControl: false, attributionControl: false }).setView([48.8566, 2.3522], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(tracking.map);
    tracking.polyline = L.polyline([], { color: "#d6432e", weight: 4 }).addTo(tracking.map);
  }, 100);

  runPrepCountdown();
}

// Décompte vocal de préparation avant le vrai départ (pas de rendu visuel
// dédié) : rien n'est enregistré dans les statistiques durant ce délai.
function runPrepCountdown() {
  speak(`Départ dans ${PREP_COUNTDOWN_SEC} secondes`);
  let remaining = PREP_COUNTDOWN_SEC;
  const tick = () => {
    remaining -= 1;
    if (remaining <= 5 && remaining >= 1) speak(String(remaining));
    if (remaining <= 0) {
      speak("C'est parti");
      activateRun();
      return;
    }
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 1000);
}

// Active réellement le suivi (chrono, moteur de phases) une fois le décompte
// de préparation terminé.
function activateRun() {
  if (!tracking.active) return; // course arrêtée pendant le décompte
  tracking.prepping = false;
  tracking.startTime = Date.now();
  tracking.runStartedAt = tracking.startTime; // fixe, jamais modifié par pause/reprise — sert de vrai "début" pour les requêtes Fitbit
  tracking.lastSplitTime = Date.now();
  document.getElementById("track-status").textContent = "EN COURSE";

  phaseSequence = activeSession ? buildPhaseSequence(activeSession) : [];
  phaseIndex = -1;
  if (phaseSequence.length > 0) {
    document.getElementById("phase-bar").style.display = "flex";
    advancePhase();
  } else {
    document.getElementById("phase-bar").style.display = "none";
  }

  tracking.clockInterval = setInterval(updateTrackUI, 1000);
}

function onPositionError(err) {
  setGpsStatus("searching", "Signal GPS faible…");
}

function onPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  setGpsStatus("ok", "Signal GPS acquis");

  if (accuracy && accuracy > MIN_ACCURACY_M) return; // point trop imprécis, ignoré

  const point = { lat: latitude, lng: longitude, t: Date.now(), accuracy };

  // Préparation ou transition entre blocs : signal GPS capté mais rien
  // n'est comptabilisé (ni distance totale, ni allure).
  if (tracking.prepping) return;

  if (tracking.path.length > 0 && !tracking.paused) {
    const prev = tracking.path[tracking.path.length - 1];
    const stepM = haversineM(prev, point);
    if (stepM >= MIN_STEP_M) {
      const stepSec = (point.t - prev.t) / 1000;
      tracking.distanceM += stepM;
      tracking.path.push(point);
      updateMapLine();
      checkSplit();

      const phase = (phaseIndex >= 0 && phaseIndex < phaseSequence.length) ? phaseSequence[phaseIndex] : null;
      if (phase && phase.kind === "continu") {
        tracking.continuDistanceM += stepM;
        tracking.continuElapsedSec += stepSec;
      } else if (phase && phase.kind === "work") {
        tracking.repDistanceM += stepM;
        tracking.repElapsedSec += stepSec;
      }
      // phases "rest" / "restSet" / "transition" : comptées dans la distance
      // totale ci-dessus, mais exclues des deux moyennes d'allure.

      const now = Date.now();
      tracking.recentSamples.push({ t: now, distanceM: tracking.distanceM });
      tracking.recentSamples = tracking.recentSamples.filter((s) => now - s.t <= getRecentSamplesRetentionMs());
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

  const avgPace = getDisplayAvgPace();
  document.getElementById("track-pace-avg").textContent = fmtPace(avgPace);

  const hasRepBlocks = !!(activeSession && activeSession.steps && activeSession.steps.some((s) => s.type === "repetitions"));
  if (hasRepBlocks) {
    const repPace = tracking.repDistanceM > 0 ? tracking.repElapsedSec / (tracking.repDistanceM / 1000) : null;
    document.getElementById("track-pace-rep").textContent = repPace != null ? fmtPace(repPace) : "—'—\"";
  }

  // allure "actuelle" affichée à l'écran : sur le dernier segment depuis le
  // dernier split (ou depuis le départ) — distincte de l'allure lissée 10s
  // utilisée pour l'alerte vocale et l'historique (rollingPaceSecPerKm)
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
    tracking.uiTicks = (tracking.uiTicks || 0) + 1;
    if (tracking.uiTicks % 2 === 0) {
      // Fenêtre fixe et indépendante du réglage "direct" — le graphique
      // post-course ne doit jamais varier selon ce réglage.
      const graphPace = rollingPaceSecPerKm(GRAPH_SMOOTHING_WINDOW_MS);
      if (graphPace != null) {
        tracking.paceHistory.push({ t: Math.round(elapsed), pace: Math.round(graphPace) });
      }
    }
    const paceCheckSec = getPaceCheckIntervalSec();
    if (paceCheckSec > 0 && tracking.uiTicks % paceCheckSec === 0) {
      const livePace = rollingPaceSecPerKm(getPaceWindowMs());
      if (livePace != null) checkPaceAlert(livePace);
    }
  }

  if (tracking.screenLocked) updateLockReadout();
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

// ---------- verrou d'écran pendant une course ----------
const UNLOCK_HOLD_MS = 800;
let unlockHoldRAF = null;
let unlockHoldStart = null;

function setScreenLock(locked) {
  tracking.screenLocked = locked;
  const overlay = document.getElementById("lock-overlay");
  if (locked) {
    updateLockReadout();
    overlay.classList.add("show");
  } else {
    overlay.classList.remove("show");
    cancelUnlockHold();
  }
}

function updateLockReadout() {
  if (!tracking.active) return;
  document.getElementById("lock-dist").innerHTML = fmtKm(tracking.distanceM) + ' <span>km</span>';
  document.getElementById("lock-clock").textContent = fmtClock(Math.floor(currentElapsedSec()));
  document.getElementById("lock-pace").textContent = fmtPace(getDisplayAvgPace()) + " /km";
}

function startUnlockHold() {
  cancelUnlockHold();
  const fill = document.getElementById("unlock-fill");
  fill.style.transition = "none";
  unlockHoldStart = performance.now();
  const step = (now) => {
    const pct = Math.min(100, ((now - unlockHoldStart) / UNLOCK_HOLD_MS) * 100);
    fill.style.height = pct + "%";
    if (pct >= 100) {
      unlockHoldRAF = null;
      setScreenLock(false);
      return;
    }
    unlockHoldRAF = requestAnimationFrame(step);
  };
  unlockHoldRAF = requestAnimationFrame(step);
}

function cancelUnlockHold() {
  if (unlockHoldRAF != null) {
    cancelAnimationFrame(unlockHoldRAF);
    unlockHoldRAF = null;
  }
  unlockHoldStart = null;
  const fill = document.getElementById("unlock-fill");
  if (fill) {
    fill.style.transition = "height 0.2s ease";
    fill.style.height = "0%";
  }
}

const unlockHoldBtn = document.getElementById("btn-unlock-hold");
unlockHoldBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  startUnlockHold();
});
unlockHoldBtn.addEventListener("pointerup", cancelUnlockHold);
unlockHoldBtn.addEventListener("pointerleave", cancelUnlockHold);
unlockHoldBtn.addEventListener("pointercancel", cancelUnlockHold);

function stopRun() {
  if (tracking.distanceM < 50) {
    if (!confirm("Course très courte (< 50 m). Terminer et l'enregistrer quand même ?")) return;
  }
  clearInterval(tracking.clockInterval);
  if (tracking.watchId != null) navigator.geolocation.clearWatch(tracking.watchId);
  releaseWakeLock();
  setScreenLock(false);
  document.getElementById("phase-bar").style.display = "none";
  document.getElementById("track-pace-rep-cell").style.display = "none";
  phaseSequence = [];
  phaseIndex = -1;

  const durationSec = Math.round(currentElapsedSec());
  const distanceM = tracking.distanceM;
  const avgPaceSecPerKm = getDisplayAvgPace();
  const hasRepetitions = !!(activeSession && activeSession.steps && activeSession.steps.some((s) => s.type === "repetitions"));

  const run = {
    id: "r_" + Date.now(),
    date: new Date().toISOString(),
    startedAt: tracking.runStartedAt ? new Date(tracking.runStartedAt).toISOString() : null,
    distanceM,
    durationSec,
    avgPaceSecPerKm,
    path: tracking.path.map((p) => ({ lat: p.lat, lng: p.lng })),
    splits: tracking.splits.map((s) => ({ km: s.km, seconds: s.seconds })),
    updatedAt: new Date().toISOString(),
    shareToken: null,
    paceHistory: tracking.paceHistory.slice(),
    phaseLog: hasRepetitions ? tracking.phaseLog.slice() : [],
    hasRepetitions,
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
    started_at: r.startedAt || null,
    distance_m: r.distanceM,
    duration_sec: r.durationSec,
    avg_pace_sec_per_km: r.avgPaceSecPerKm,
    path: r.path,
    splits: r.splits,
    share_token: r.shareToken || null,
    deleted_at: null,
    pace_history: r.paceHistory || [],
    phase_log: r.phaseLog || [],
    has_repetitions: !!r.hasRepetitions,
    elevation_gain_m: r.elevationGainM ?? null,
  };
}
function remoteToRun(row) {
  return {
    id: row.id,
    date: row.date,
    startedAt: row.started_at || null,
    distanceM: Number(row.distance_m),
    durationSec: Number(row.duration_sec),
    avgPaceSecPerKm: Number(row.avg_pace_sec_per_km),
    path: row.path || [],
    splits: row.splits || [],
    shareToken: row.share_token || null,
    updatedAt: row.updated_at,
    paceHistory: row.pace_history || [],
    phaseLog: row.phase_log || [],
    hasRepetitions: !!row.has_repetitions,
    elevationGainM: row.elevation_gain_m != null ? Number(row.elevation_gain_m) : null,
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
  const dot = document.getElementById("account-icon-dot");
  if (currentUser) {
    el.style.display = "none";
    if (dot) dot.classList.add("ok");
  } else {
    el.className = "sync-status";
    el.style.display = "flex";
    textEl.textContent = "Non connecté";
    if (dot) dot.classList.remove("ok");
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
// GOOGLE HEALTH (Fitbit) — connexion, statut, lecture fréquence cardiaque
// ============================================================
async function callGoogleHealth(action, extra) {
  const { data: sessionData } = await sb.auth.getSession();
  if (!sessionData.session) return { error: "not_logged_in" };
  const res = await fetch(`${SUPABASE_URL}/functions/v1/google-health`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sessionData.session.access_token}`,
    },
    body: JSON.stringify({ action, ...extra }),
  });
  return res.json().catch(() => ({ error: "bad_response" }));
}

async function updateGoogleHealthStatus() {
  const statusEl = document.getElementById("gh-status");
  const connectBtn = document.getElementById("btn-gh-connect");
  const disconnectBtn = document.getElementById("btn-gh-disconnect");
  if (!currentUser) {
    statusEl.textContent = "Connecte-toi d'abord à ton compte Splits";
    statusEl.classList.remove("ok");
    connectBtn.style.display = "none";
    disconnectBtn.style.display = "none";
    return;
  }
  const result = await callGoogleHealth("status");
  const connected = !!result.connected;
  statusEl.textContent = connected ? "Connecté" : "Non connecté";
  statusEl.classList.toggle("ok", connected);
  connectBtn.style.display = connected ? "none" : "block";
  disconnectBtn.style.display = connected ? "block" : "none";
}

document.getElementById("btn-gh-connect").addEventListener("click", () => {
  if (!currentUser) { toast("Connecte-toi d'abord à ton compte Splits."); return; }
  window.location.href = buildGoogleHealthAuthUrl();
});
document.getElementById("btn-gh-disconnect").addEventListener("click", async () => {
  await callGoogleHealth("disconnect");
  toast("Fitbit déconnecté");
  updateGoogleHealthStatus();
});

// Au chargement : si l'URL contient ?code=... (retour de Google), on échange
// le code contre des tokens via l'Edge Function, puis on nettoie l'URL.
async function handleGoogleHealthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  if (!code) return;
  window.history.replaceState({}, "", window.location.pathname);
  const result = await callGoogleHealth("exchange", { code, redirect_uri: googleHealthRedirectUri() });
  if (result.connected) {
    toast("Fitbit connecté");
  } else {
    toast("Échec de la connexion Fitbit");
  }
  showScreen("screen-account");
  updateAccountUI();
  updateGoogleHealthStatus();
}

// Instant de départ RÉEL d'une course, pour les requêtes Fitbit (FC, exercice).
// r.date est l'heure d'ENREGISTREMENT (fin de course), pas le départ — un
// bug historique confondait les deux, pointant les requêtes Fitbit vers une
// fenêtre entièrement APRÈS la course. r.startedAt (ajouté depuis) porte le
// vrai départ ; à défaut (courses enregistrées avant ce correctif), on
// retranche la durée à r.date en repli (suppose l'absence de pause).
function runRealStart(r) {
  if (r.startedAt) return new Date(r.startedAt);
  return new Date(new Date(r.date).getTime() - r.durationSec * 1000);
}

// Récupère la FC moyenne sur la fenêtre temporelle d'une course et l'affiche
// dans le détail, si l'utilisateur est connecté et que des données existent.
// Échoue silencieusement dans tous les autres cas (pas de compte connecté,
// pas de données pour cette période, etc.) — la cellule reste simplement masquée.
async function tryShowRunHeartRate(r) {
  const cell = document.getElementById("detail-hr-cell");
  cell.style.display = "none";
  if (!currentUser) return;
  const start = runRealStart(r);
  const end = new Date(start.getTime() + r.durationSec * 1000);
  const result = await callGoogleHealth("heart_rate", { start: start.toISOString(), end: end.toISOString() });
  const points = result.dataPoints;
  if (!Array.isArray(points) || points.length === 0) return;
  const bpms = points
    .map((p) => {
      const v = p?.heartRate?.beatsPerMinute;
      return v != null ? Number(v) : null;
    })
    .filter((v) => typeof v === "number" && v > 0);
  if (bpms.length === 0) return;
  const avgBpm = Math.round(bpms.reduce((a, b) => a + b, 0) / bpms.length);
  document.getElementById("detail-hr").textContent = `${avgBpm} bpm`;
  cell.style.display = "";
}

// ============================================================
// FITBIT — comparaison post-course (dénivelé, distance, cadence)
// Recoupement manuel uniquement : rien n'est appliqué sans clic explicite
// sur "Appliquer" (cf. préférence de l'utilisateur pour la correction
// manuelle du tracé GPS, même principe ici pour le dénivelé).
// ============================================================
function refreshElevCell(r) {
  const cell = document.getElementById("detail-elev-cell");
  if (r.elevationGainM != null) {
    document.getElementById("detail-elev").textContent = `+${Math.round(r.elevationGainM)} m`;
    cell.style.display = "";
  } else {
    cell.style.display = "none";
  }
}

function fmtPctDiff(phoneM, fitbitM) {
  if (!phoneM || !fitbitM) return null;
  return Math.round(((fitbitM - phoneM) / phoneM) * 100);
}

// Formate l'heure civile ("YYYY-MM-DDTHH:mm:ss") renvoyée par l'API pour
// affichage dans la liste de sélection manuelle — extraction texte simple,
// sans passer par Date() pour ne jamais réinterpréter cette heure comme UTC.
function fmtCivilTimeShort(civil) {
  if (!civil) return "—";
  const m = String(civil).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return civil;
  return `${m[3]}/${m[2]} ${m[4]}:${m[5]}`;
}

// Affiche le résultat d'un exercice (auto-détecté ou choisi manuellement)
// dans le panneau — mêmes lignes, même bouton "Appliquer" pour le dénivelé.
function renderFitbitResult(r, panel, result) {
  if (result.error === "not_connected") {
    panel.innerHTML = `<div class="fitbit-empty">Fitbit non connecté — va dans Compte pour te connecter.</div>`;
    return;
  }
  if (!result.hasTrack) {
    panel.innerHTML = `<div class="fitbit-empty">Exercice trouvé, mais sans tracé exploitable.</div>`;
    return;
  }

  // Stocké en mémoire (non persisté) sur l'objet course déjà référencé par
  // openDetail/openMapSheet : si l'utilisateur ouvre ensuite le bottom sheet
  // du tracé GPS, il verra le tracé Fitbit superposé. Nécessite le scope
  // location (voir Edge Function) — absent si non reconnecté, auquel cas
  // result.trackpoints est simplement vide et rien n'est superposé.
  if (result.trackpoints && result.trackpoints.length > 1) {
    r.fitbitTrackpoints = result.trackpoints.map((p) => ({ lat: p.lat, lng: p.lon }));
  }

  const rows = [];

  if (result.distanceM) {
    const pct = fmtPctDiff(r.distanceM, result.distanceM);
    const warn = pct != null && Math.abs(pct) >= 3;
    const distAlreadyApplied = Math.round(r.distanceM) === Math.round(result.distanceM);
    rows.push(`
      <div class="fitbit-row">
        <span class="fitbit-label">Distance téléphone / Fitbit</span>
        <span class="fitbit-value${warn ? " warn" : ""}">${fmtKm(r.distanceM)} / ${fmtKm(result.distanceM)} km${pct != null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""}</span>
        <button class="fitbit-apply-btn" id="btn-apply-dist" ${distAlreadyApplied ? "disabled" : ""}>${distAlreadyApplied ? "Appliqué ✓" : "Appliquer"}</button>
      </div>
    `);
  }

  if (result.elevationGainM != null) {
    const alreadyApplied = r.elevationGainM === result.elevationGainM;
    rows.push(`
      <div class="fitbit-row">
        <span class="fitbit-label">Dénivelé (altimètre Fitbit)</span>
        <span class="fitbit-value">+${result.elevationGainM} m</span>
        <button class="fitbit-apply-btn" id="btn-apply-elev" ${alreadyApplied ? "disabled" : ""}>${alreadyApplied ? "Appliqué ✓" : "Appliquer"}</button>
      </div>
    `);
  }

  if (result.avgCadence != null) {
    rows.push(`
      <div class="fitbit-row">
        <span class="fitbit-label">Cadence moyenne</span>
        <span class="fitbit-value">${result.avgCadence} spm</span>
      </div>
    `);
  }

  if (result.avgHeartRateBpm != null) {
    rows.push(`
      <div class="fitbit-row">
        <span class="fitbit-label">FC moyenne (Fitbit)</span>
        <span class="fitbit-value">${result.avgHeartRateBpm} bpm</span>
      </div>
    `);
  }

  if (result.fitbitSplits && result.fitbitSplits.length) {
    rows.push(`
      <div class="fitbit-row">
        <span class="fitbit-label">Splits par km (Fitbit, ${result.fitbitSplits.length} km)</span>
        <button class="fitbit-apply-btn" id="btn-apply-splits">Appliquer</button>
      </div>
    `);
  }

  panel.innerHTML = rows.length ? rows.join("") : `<div class="fitbit-empty">Pas de donnée exploitable pour cette course.</div>`;

  const applyDistBtn = document.getElementById("btn-apply-dist");
  if (applyDistBtn) {
    applyDistBtn.onclick = async () => {
      r.distanceM = result.distanceM;
      r.avgPaceSecPerKm = r.distanceM > 0 ? r.durationSec / (r.distanceM / 1000) : 0;
      r.splits = recomputeUniformSplits(r.distanceM, r.avgPaceSecPerKm);
      r.updatedAt = new Date().toISOString();
      saveRuns();
      markPRs();
      await pushRun(r);
      toast("Distance Fitbit appliquée — allure et splits recalculés");
      openDetail(r.id);
    };
  }

  const applyBtn = document.getElementById("btn-apply-elev");
  if (applyBtn) {
    applyBtn.onclick = async () => {
      r.elevationGainM = result.elevationGainM;
      r.updatedAt = new Date().toISOString();
      saveRuns();
      await pushRun(r);
      refreshElevCell(r);
      applyBtn.disabled = true;
      applyBtn.textContent = "Appliqué ✓";
      toast("Dénivelé Fitbit appliqué");
    };
  }

  const applySplitsBtn = document.getElementById("btn-apply-splits");
  if (applySplitsBtn) {
    applySplitsBtn.onclick = async () => {
      r.splits = result.fitbitSplits.map((s) => ({ km: s.km, seconds: s.seconds }));
      r.updatedAt = new Date().toISOString();
      saveRuns();
      markPRs();
      await pushRun(r);
      toast("Splits Fitbit appliqués");
      openDetail(r.id);
    };
  }
}

// Repli quand l'auto-détection ne trouve rien : liste tous les exercices
// Fitbit de la journée (00:00–24:00 heure locale) pour choix manuel.
async function showManualExercisePicker(r, panel) {
  panel.innerHTML = `<div class="fitbit-empty">Recherche des exercices de la journée…</div>`;
  const dayStart = runRealStart(r);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const listResult = await callGoogleHealth("list_exercises", {
    civilStart: toCivilString(dayStart),
    civilEnd: toCivilString(dayEnd),
  });

  if (listResult.error === "not_connected") {
    panel.innerHTML = `<div class="fitbit-empty">Fitbit non connecté — va dans Compte pour te connecter.</div>`;
    return;
  }
  const exercises = listResult.exercises || [];
  if (exercises.length === 0) {
    panel.innerHTML = `<div class="fitbit-empty">Aucun exercice Fitbit trouvé pour cette journée — vérifie que la montre a bien synchronisé.</div>`;
    return;
  }

  panel.innerHTML = `
    <div class="fitbit-empty">Aucune correspondance automatique — choisis l'exercice sur la montre :</div>
    <div class="fitbit-picker"></div>
  `;
  const pickerEl = panel.querySelector(".fitbit-picker");
  exercises.forEach((ex) => {
    const btn = document.createElement("button");
    btn.className = "fitbit-pick-btn";
    const distLabel = ex.distanceMeters ? ` · ${fmtKm(ex.distanceMeters)} km` : "";
    btn.textContent = `${fmtCivilTimeShort(ex.civilStartTime)}${ex.activityType ? " · " + ex.activityType : ""}${distLabel}`;
    btn.onclick = async () => {
      panel.innerHTML = `<div class="fitbit-empty">Chargement du tracé…</div>`;
      const result = await callGoogleHealth("exercise_track_by_name", { name: ex.name });
      renderFitbitResult(r, panel, result);
    };
    pickerEl.appendChild(btn);
  });
}

function setupFitbitCompare(r) {
  const btn = document.getElementById("btn-fitbit-compare");
  const panel = document.getElementById("fitbit-compare-panel");
  panel.style.display = "none";
  panel.innerHTML = "";

  if (!currentUser) { btn.style.display = "none"; return; }
  btn.style.display = "flex";

  btn.onclick = async () => {
    btn.querySelector("span").textContent = "Recherche en cours…";
    btn.disabled = true;
    const start = runRealStart(r);
    const end = new Date(start.getTime() + r.durationSec * 1000);
    const result = await callGoogleHealth("exercise_track", { civilStart: toCivilString(start), civilEnd: toCivilString(end) });
    btn.disabled = false;
    btn.querySelector("span").textContent = "Comparer avec la montre Fitbit";
    btn.style.display = "none";
    panel.style.display = "flex";

    if (result.error === "not_connected") {
      panel.innerHTML = `<div class="fitbit-empty">Fitbit non connecté — va dans Compte pour te connecter.</div>`;
      return;
    }
    if (!result.found) {
      await showManualExercisePicker(r, panel);
      return;
    }
    renderFitbitResult(r, panel, result);
  };
}

// ============================================================
// RÉGLAGES — fréquence des alertes vocales, par type de bloc
// ============================================================
function bindSettingSlider(rangeId, valId, key) {
  const range = document.getElementById(rangeId);
  const val = document.getElementById(valId);
  range.value = settings[key];
  val.textContent = settings[key] + "s";
  range.addEventListener("input", () => {
    settings[key] = Number(range.value);
    val.textContent = settings[key] + "s";
    saveSettings();
  });
}
bindSettingSlider("set-pace-continu", "set-pace-continu-val", "paceCheckContinuSec");
bindSettingSlider("set-pace-work", "set-pace-work-val", "paceCheckWorkSec");
bindSettingSlider("set-window-continu", "set-window-continu-val", "paceWindowContinuSec");
bindSettingSlider("set-window-work", "set-window-work-val", "paceWindowWorkSec");
bindSettingSlider("set-time-continu", "set-time-continu-val", "timeAlertContinuSec");
bindSettingSlider("set-time-work", "set-time-work-val", "timeAlertWorkSec");

// Interrupteur global : coupe les annonces vocales "Accélère"/"Ralentis"
// (checkPaceAlert) sans toucher aux alertes de temps, qui restent
// indépendantes. Grise les réglages de vitesse (contrôle d'allure + fenêtre
// de lissage) pour signaler visuellement qu'ils sont sans effet tant que
// l'interrupteur est éteint.
function updatePaceDependentRowsUI() {
  document.querySelectorAll(".pace-dependent-row").forEach((row) => {
    row.classList.toggle("disabled", !settings.paceAlertsEnabled);
  });
}
const paceAlertsToggle = document.getElementById("set-pace-alerts-enabled");
paceAlertsToggle.checked = settings.paceAlertsEnabled;
updatePaceDependentRowsUI();
paceAlertsToggle.addEventListener("change", () => {
  settings.paceAlertsEnabled = paceAlertsToggle.checked;
  saveSettings();
  updatePaceDependentRowsUI();
});

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
  handleGoogleHealthCallback();
});
