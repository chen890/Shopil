/* Shopil – cheapest grocery cart near you (Israel price-transparency data). */
"use strict";

const DATA = "data/";
const MAX_STORES = 40;
const META_CHECK_MS = 60_000;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);
const CLUB_LABEL = { 1: "מועדון", 2: "כרטיס אשראי" };

/* ------------------------------------------------------------ state */
const KEY = "shopil.v1";
function loadState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch (_) { /* private mode */ }
  s = s || {};
  if (!Array.isArray(s.lists) || !s.lists.length) s.lists = [{ id: uid(), name: "קנייה שבועית", items: [] }];
  if (!s.lists.some((l) => l.id === s.active)) s.active = s.lists[0].id;
  s.clubs = s.clubs || {};
  s.fee = s.fee ?? 30;
  s.mode = s.mode || "all";
  s.radius = s.radius || 5;
  s.cats ||= null;        // user's category list [{id, label}], seeded from CATEGORIES
  s.catMap ||= {};        // product code -> category id the user chose (learned)
  s.catStats ||= {};      // category id -> {sum, n}: average position in past trips
  s.trip ||= [];          // category ids in the order items were collected this trip
  s.autoSort ??= true;
  s.cards ||= {};         // affinity cards the user holds: {hever: true, ...}
  s.cardPct ||= {};       // user overrides: {"hever:carrefour-city": 6}
  s.rlMonthly ??= false;  // Rami Levy cashback condition (>= ₪500 / month)
  return s;
}
let pushTimer = null;
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
  // live-shared lists: send changes to the other devices
  if (typeof Sync !== "undefined" && state.lists.some((l) => l.sync)) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => state.lists.filter((l) => l.sync).forEach((l) => Sync.push(l).catch(() => {})), 300);
  }
}
function uid() { return Math.random().toString(36).slice(2, 9); }
const state = loadState();
const activeList = () => state.lists.find((l) => l.id === state.active);

/* ------------------------------------------------------------ data */
let meta = null, stores = [], catalog = null, catalogPromise = null, lastMetaCheck = 0;
const storeCache = new Map();

async function getJSON(path, opts) {
  const r = await fetch(DATA + path, opts);
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

async function refreshMeta(force) {
  if (!force && meta && Date.now() - lastMetaCheck < META_CHECK_MS) return false;
  lastMetaCheck = Date.now();
  let m;
  try { m = await getJSON("meta.json", { cache: "no-store" }); } catch (e) { return false; }
  const changed = !meta || m.generated !== meta.generated;
  if (changed) {
    const first = !meta;
    meta = m;
    storeCache.clear();
    catalog = null; catalogPromise = null;
    stores = await getJSON("stores.json?v=" + encodeURIComponent(meta.generated));
    renderMeta();
    fillCities();
    renderClubs();
    if (!first) toast("המחירים עודכנו");
  }
  return changed;
}

function loadCatalog() {
  if (catalog) return Promise.resolve(catalog);
  if (!catalogPromise) {
    catalogPromise = getJSON("catalog.json?v=" + encodeURIComponent(meta?.generated || "")).then((c) => {
      catalog = c;
      catalogIndex = Object.entries(c).map(([code, v]) => [code, norm(v[0] + " " + v[1] + " " + (v[5] || "")), v[4] || 0]);
      return c;
    });
  }
  return catalogPromise;
}

async function loadStore(id) {
  if (storeCache.has(id)) return storeCache.get(id);
  const p = getJSON("s/" + id + ".json?v=" + encodeURIComponent(meta.generated)).catch(() => null);
  storeCache.set(id, p);
  return p;
}

/* ------------------------------------------------------------ search */
let catalogIndex = [];
const norm = (s) => String(s).toLowerCase().replace(/["'׳״`]/g, "").replace(/\s+/g, " ");

async function doSearch(q) {
  const box = $("#results");
  q = q.trim();
  if (q.length < 2) { box.innerHTML = ""; return; }
  if (!catalog) box.innerHTML = '<div class="result"><span class="name">טוען מוצרים…</span></div>';
  await loadCatalog();
  if ($("#search").value.trim() !== q) return; // stale
  let hits;
  if (/^\d{5,}$/.test(q)) {
    const c = q.replace(/^0+/, "");
    hits = catalogIndex.filter(([code]) => code.startsWith(c)).slice(0, 30);
  } else {
    const words = norm(q).split(" ").filter(Boolean);
    hits = [];
    for (const row of catalogIndex) {
      if (words.every((w) => row[1].includes(w))) hits.push(row);
    }
    hits.sort((a, b) => b[2] - a[2]);
    hits = hits.slice(0, 30);
  }
  if (!hits.length) { box.innerHTML = '<div class="result"><span class="name">לא נמצאו מוצרים. נסו מילה אחרת או ברקוד.</span></div>'; return; }
  box.innerHTML = hits.map(([code]) => {
    const [name, maker, size, , pop] = catalog[code];
    return `<div class="result" data-code="${code}" role="button" tabindex="0">
      <div class="name">${esc(name)}<div class="meta">${esc([cleanMaker(maker), size].filter(Boolean).join(" · "))} · ${pop} סניפים</div></div>
      <span class="add" aria-hidden="true">+</span></div>`;
  }).join("");
}

const cleanMaker = (m) => (/^(לא ידוע|כללי|unknown|-|0)?$/i.test((m || "").trim()) ? "" : m);

/* ------------------------------------------------------------ list */
function addItem(code, qty = 1) {
  const list = activeList();
  const existing = list.items.find((i) => i.c === code);
  const info = catalog?.[code];
  if (existing) existing.q += qty;
  else {
    const n = info ? info[0] : code;
    list.items.push({ c: code, n, s: info ? info[2] : "", w: info ? info[3] : 0, q: info?.[3] ? Math.max(qty, 1) : qty, k: categoryOf(code, n) });
  }
  save(); renderList(); scheduleCompute();
}
function setQty(code, q) {
  const list = activeList();
  const it = list.items.find((i) => i.c === code);
  if (!it) return;
  if (q <= 0) list.items = list.items.filter((i) => i.c !== code);
  else it.q = Math.round(q * 100) / 100;
  save(); renderList(); scheduleCompute();
}

function renderListsBar() {
  $("#listsBar").innerHTML =
    state.lists.map((l) => `<button class="chip ${l.id === state.active ? "on" : ""}" data-list="${l.id}">${l.sync ? "🔗 " : ""}${esc(l.name)} <small>(${l.items.length})</small></button>`).join("") +
    '<button class="chip" data-list="__new">+ רשימה חדשה</button>';
}

/* ------------------------------------------------------------ categories */
const CATEGORIES = [
  ["fruit", "🍎 פירות"], ["veg", "🥕 ירקות"], ["dairy", "🧀 מוצרי חלב וביצים"], ["bakery", "🍞 לחם ומאפים"],
  ["meat", "🍗 בשר, עוף ודגים"], ["pantry", "🥫 מזווה ובישול"], ["snacks", "🍫 חטיפים וממתקים"], ["drinks", "🥤 משקאות"],
  ["frozen", "🧊 קפואים"], ["baby", "🍼 תינוקות"], ["cleaning", "🧽 ניקיון ובית"], ["care", "🧴 טיפוח והיגיינה"],
  ["pets", "🐾 בעלי חיים"], ["other", "🛒 אחר"],
];
const FRUIT_KEYS = new Set(["lemon", "avocado", "banana", "apple", "pear", "orange", "clementine", "grapefruit", "grapes",
  "watermelon", "melon", "peach", "plum", "strawberry", "mango", "kiwi", "pomegranate", "persimmon"]);
const PROCESSED_CAT = /מרוסק|חתוכ|כבוש|מוחמצ|חמוצ|במלח|בחומץ|מיובש|רסק|רוטב|ממרח|מחית|שימורים|בשמן|מטוגן|ציפס|מיץ|נקטר|ריבה/;
// [category, regex]; checked against the first word first, then the whole name
const CAT_RULES = [
  ["baby", /טיטול|חיתול|האגיס|פמפרס|מטרנה|סימילאק|נוטרילון|תמ"ל|תמל|מוצץ|לתינוק|תינוקות|בייבי|גרבר|דייסת|נוטרישה/],
  ["pets", /לכלב|לחתול|חול לחתול|פדיגרי|ויסקס|פריסקיז|מזון לחיות/],
  ["frozen", /קפוא|גלידה|ארטיק|שלגון|קרטיב|מוקפא/],
  ["cleaning", /אקונומיקה|נוזל כלים|כביסה|מרכך כביסה|ניקוי|מנקה|מטליות|ספוג|שקיות אשפה|שקית אשפה|נייר טואלט|מגבות נייר|מגבת נייר|טישו|ממחטות|נייר סופג|רדיד|ניילון נצמד|תבניות|מפיות|חד פעמי|סבון כלים|מבריק|מסיר אבנית|מטהר|פיירי|סנו |קלין|וניש|טבליות למדיח/],
  ["care", /שמפו|מרכך שיער|סבון|תחליב|דאודורנט|משחת שיניים|מברשת שיניים|קרם|תחבושות|טמפון|גילוח|ג'ל רחצה|ג׳ל רחצה|קולגייט|אולוויז|ספריי לשיער|מי פה|צמר גפן|פלסטר|מגבונים|קוטקס|לק |בושם/],
  ["drinks", /^מים|מים מינרל|סודה|קולה|ספרייט|פנטה|שוופס|מיץ|נקטר|משקה|בירה|יין|וודקה|ויסקי|ערק|ליקר|שתייה|פריגת|ספרינג|תפוזינה|נביעות|נסטי|אייס טי|אנרגיה/],
  ["dairy", /^חלב|^גבינ|^גבינה|קוטג|יוגורט|^לבן|לבנה|שמנת|חמאה|מעדן|^ביצים|ביצי|אשל|^גיל |דנונה|מילקי|פודינג|בולגרית|צפתית|מוצרלה|פרמזן|ריקוטה|טופו|משקה סויה|חלב שקדים|^אקטיביה|יופלה|פרילי/],
  ["bakery", /^לחם|לחמני|^פיתה|^פיתות|באגט|^חלה|טורטיה|לאפה|קרואסון|^עוגת|^עוגה|מאפה|בורקס|רוגלך|לחמניה|פרוסות|טוסט|קרקר לחם|פריכיות/],
  ["meat", /^עוף|^בשר|בקר|^הודו|שניצל|קציצ|נקניק|סלמון|^דג|^דגי|פילה|כרעיים|חזה עוף|כבד|המבורגר|קבב|פסטרמה|סלמי|כנפיים|שוקיים|טחון|אמנון|מוסר|לוקוס|בורי|^טונה טרי/],
  ["snacks", /שוקולד|חטיף|במבה|ביסלי|צ'יפס|צ׳יפס|דוריטוס|עוגיות|עוגיה|וופל|ופל|סוכרי|מסטיק|פופקורן|בייגלה|קרקר|ממתק|תפוצ'יפס|אפרופו|קליק|פסק זמן|כיף כף|מרשמלו|גומי|לקקן|ביסקוויט|חטיפי/],
  ["pantry", /אורז|פסטה|ספגטי|^קמח|^סוכר|^מלח|^שמן|רוטב|קטשופ|מיונז|חומוס|טחינה|שימורים|טונה|תירס|אפונה|קוסקוס|פתיתים|דגני|קורנפלקס|ריבה|דבש|תבלין|פפריקה|כמון|פלפל שחור|^מרק|אבקת|שקדים|אגוז|^קפה|^תה|קקאו|עדשים|שעועית|ממרח|חומץ|שמרים|אטריות|נודלס|זיתים|מלפפונים חמוצים|רסק|פירורי לחם|גרנולה|שיבולת שועל|קינואה|בורגול|ציר|אבקה|סילאן|נס קפה|נמס/],
  ["veg", /^(עגבני|מלפפו|חסה|גזר|בצל|שום|פטריות|שמפיניון|תפו"א|תפוח אדמה|תפוחי אדמה|כרוב|ברוקולי|כרובית|פלפל|גמבה|קישוא|חציל|עלי |נענע|פטרוזיליה|כוסברה|שמיר|סלרי|סלק|בטטה|תרד|צנונית|קולורבי|דלעת|ארטישוק|אספרגוס|נבטים|ג'ינג'ר|ג׳ינג׳ר|לוביה|במיה)/],
  ["fruit", /^(תפוח(?! אדמה)|תפוחי עץ|בננ|תפוז|קלמנטינ|מנדרינ|אבוקדו|לימון|ענב|אבטיח|מלון|תות|אגס|מנגו|קיווי|רימון|אפרסק|נקטרינ|שזיף|אננס|דובדבן|אוכמני|פטל|תמר|אפרסמון|אשכולי|פומלה|ליים|פסיפלורה|פפאיה|ליצ'י)/],
];
function categoryOf(code, name) {
  const learned = state.catMap[code];
  if (learned && cats().some((c) => c.id === learned)) return learned;
  if (String(code).startsWith("P:")) return FRUIT_KEYS.has(code.slice(2)) ? "fruit" : "veg";
  const n = norm(name || "");
  const first = n.split(" ")[0] || "";
  for (const [cat, rx] of CAT_RULES) {
    if ((cat === "veg" || cat === "fruit") && PROCESSED_CAT.test(n)) continue;
    if (rx.test(first)) return cat;
  }
  for (const [cat, rx] of CAT_RULES) {
    if ((cat === "veg" || cat === "fruit") && PROCESSED_CAT.test(n)) continue;
    if (rx.test(n)) return cat;
  }
  return "other";
}

/* ------------------------------------------------------------ dynamic categories */
function cats() {
  if (!state.cats) state.cats = CATEGORIES.map(([id, label]) => ({ id, label }));
  return state.cats;
}
const catLabel = (id) => cats().find((c) => c.id === id)?.label || "🛒 אחר";
/** Category order: learned from past trips (auto) or the user's manual order. */
function orderedCats() {
  const list = cats().slice();
  if (!state.autoSort) return list;
  const known = list.filter((c) => state.catStats[c.id]?.n);
  if (known.length < 2) return list;
  const avg = (c) => state.catStats[c.id]?.n ? state.catStats[c.id].sum / state.catStats[c.id].n : null;
  // categories never collected keep their manual position relative to each other, after learned ones
  return list
    .map((c, i) => ({ c, i, a: avg(c) }))
    .sort((x, y) => (x.a ?? 2 + x.i / 100) - (y.a ?? 2 + y.i / 100))
    .map((x) => x.c);
}
function noteCollected(catId) {
  if (!state.trip.includes(catId)) state.trip.push(catId);
}
/** Fold this trip's aisle order into the learned averages. */
function commitTrip() {
  const t = state.trip;
  if (t.length >= 2) {
    t.forEach((id, i) => {
      const st = (state.catStats[id] ||= { sum: 0, n: 0 });
      st.sum += i / (t.length - 1); st.n += 1;
    });
  }
  state.trip = [];
}

/* ------------------------------------------------------------ list rendering */
const STATUS_ORDER = { undefined: 0, missing: 1, done: 2 };
function renderList() {
  renderListsBar();
  const list = activeList();
  const ul = $("#items");
  $("#emptyList").hidden = list.items.length > 0;
  $("#countBadge").textContent = list.items.filter((i) => i.st !== "done").length || "";
  const done = list.items.filter((i) => i.st === "done").length;
  const missing = list.items.filter((i) => i.st === "missing").length;
  $("#progress").hidden = !(done || missing);
  $("#progress").innerHTML = `<span>✓ נאספו ${done} מתוך ${list.items.length}${missing ? ` · ${missing} חסרים` : ""}</span>
    <button class="btn small ghost" id="resetStatus">קנייה חדשה</button>`;
  const order = orderedCats();
  const groups = new Map(order.map((c) => [c.id, []]));
  if (!groups.has("other")) groups.set("other", []);
  for (const it of list.items) {
    if (!it.k || !groups.has(it.k)) it.k = categoryOf(it.c, it.n);
    (groups.get(it.k) || groups.get("other")).push(it);
  }
  const shown = order.map((c) => [c.id, c.label]);
  if (!order.some((c) => c.id === "other")) shown.push(["other", "🛒 אחר"]);
  ul.innerHTML = shown.filter(([k]) => groups.get(k)?.length).map(([k, label]) => {
    const items = groups.get(k).slice().sort((a, b) => STATUS_ORDER[a.st] - STATUS_ORDER[b.st]);
    const left = items.filter((i) => i.st !== "done").length;
    return `<li class="cat"><h3>${label} <small>${left ? left : "✓"}</small></h3><ul>${items.map((it) => {
      const step = it.w ? 0.5 : 1;
      const meta = [it.s || (it.c.startsWith("P:") ? "המחיר הזול לק״ג בכל סניף" : ""), it.note ? `📝 ${it.note}` : ""].filter(Boolean).join(" · ");
      return `<li class="item ${it.st || ""}" data-code="${esc(it.c)}">
      <div class="row1">
        <button class="check" data-act="done" aria-label="${it.st === "done" ? "בטל סימון" : "סמן שנאסף"}">${it.st === "done" ? "✓" : ""}</button>
        <div class="name" data-act="edit">${esc(it.n)}${it.st === "missing" ? ' <span class="badge missing">חסר</span>' : ""}<div class="meta">${esc(meta)}</div></div>
        <div class="qty"><button data-dq="${-step}" aria-label="הפחתה">−</button><span>${it.q}${it.w ? "<small> ק״ג</small>" : ""}</span><button data-dq="${step}" aria-label="הוספה">+</button></div>
        <button class="more" data-act="edit" aria-label="עריכה">⋯</button>
      </div></li>`;
    }).join("")}</ul></li>`;
  }).join("");
  $("#findBtn").hidden = !list.items.length;
}

function editItem(code) {
  const it = activeList().items.find((i) => i.c === code);
  if (!it) return;
  const step = it.w ? 0.5 : 1;
  openDialog(`<h2>${esc(it.n)}</h2>
    <div class="edit-grid">
      <label>כמות${it.w ? " (ק״ג)" : ""} <input id="eQty" type="number" min="0" step="${step}" value="${it.q}" inputmode="decimal"></label>
      <label>הערה <input id="eNote" value="${esc(it.note || "")}" placeholder="למשל: הכי בשל, בלי לקטוז"></label>
      <label>קטגוריה <select id="eCat">${cats().map((c) => `<option value="${c.id}" ${c.id === it.k ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select></label>
    </div>
    <div class="status-row">
      <button class="btn ${it.st === "done" ? "primary" : ""}" data-st="done">✓ נאסף</button>
      <button class="btn ${it.st === "missing" ? "warn" : ""}" data-st="missing">✗ חסר בחנות</button>
      <button class="btn ghost" data-st="">ללא סימון</button>
    </div>
    <div class="list-actions">
      <button class="btn primary" id="eSave">שמירה</button>
      <button class="btn" id="eReplace">🔄 החלפת מוצר</button>
      <button class="btn ghost" id="eDelete">🗑️ מחיקה</button>
    </div>`);
  let st = it.st || "";
  const dlg = $("#dialog");
  dlg.querySelectorAll("[data-st]").forEach((b) => (b.onclick = () => {
    st = b.dataset.st;
    dlg.querySelectorAll("[data-st]").forEach((x) => x.classList.remove("primary", "warn"));
    if (st) b.classList.add(st === "done" ? "primary" : "warn");
  }));
  $("#eSave").onclick = () => {
    const q = Number($("#eQty").value);
    it.note = $("#eNote").value.trim() || undefined;
    if ($("#eCat").value !== it.k) {
      it.k = $("#eCat").value;
      state.catMap[it.c] = it.k; // remember for next time
    }
    if (st === "done" && it.st !== "done") noteCollected(it.k);
    it.st = st || undefined;
    dlg.close();
    if (q > 0 && q !== it.q) setQty(code, q); else if (q <= 0) setQty(code, 0); else { save(); renderList(); }
  };
  $("#eDelete").onclick = () => { dlg.close(); setQty(code, 0); toast("נמחק מהרשימה"); };
  $("#eReplace").onclick = () => {
    dlg.close();
    replacing = code;
    showTab("list");
    const s = $("#search");
    s.placeholder = `חפשו מוצר במקום: ${it.n}`;
    s.value = tokens(it.n).slice(0, 2).join(" ");
    s.focus(); doSearch(s.value);
  };
}
let replacing = null;
function replaceItem(oldCode, newCode) {
  const list = activeList();
  const it = list.items.find((i) => i.c === oldCode);
  const info = catalog?.[newCode];
  if (!it || !info) return;
  const dup = list.items.find((i) => i.c === newCode && i !== it);
  if (dup) { dup.q += it.q; list.items = list.items.filter((i) => i !== it); }
  else Object.assign(it, { c: newCode, n: info[0], s: info[2], w: info[3], k: categoryOf(newCode, info[0]), ok: undefined, sub: undefined });
  save(); renderList(); scheduleCompute();
  toast("המוצר הוחלף");
}

/* ------------------------------------------------------------ location */
const toRad = (d) => (d * Math.PI) / 180;
function distKm(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
let cityCenters = {};
function fillCities() {
  const acc = {};
  for (const s of stores) {
    if (!s.city || s.lat == null) continue;
    const a = (acc[s.city] ||= { lat: 0, lon: 0, n: 0 });
    a.lat += s.lat; a.lon += s.lon; a.n++;
  }
  cityCenters = {};
  for (const [c, a] of Object.entries(acc)) cityCenters[c] = { lat: a.lat / a.n, lon: a.lon / a.n };
  $("#cities").innerHTML = Object.keys(cityCenters).sort((a, b) => a.localeCompare(b, "he")).map((c) => `<option value="${esc(c)}">`).join("");
}
function setLocation(loc) {
  state.loc = loc; save();
  $("#locText").textContent = "📍 " + loc.label;
  scheduleCompute();
}
function useGPS() {
  if (!navigator.geolocation) { toast("הדפדפן לא תומך במיקום. בחרו עיר."); return; }
  $("#locText").textContent = "מאתר מיקום…";
  navigator.geolocation.getCurrentPosition(
    (p) => setLocation({ lat: p.coords.latitude, lon: p.coords.longitude, label: "המיקום הנוכחי שלי" }),
    () => { $("#locText").textContent = "לא הצלחנו לאתר מיקום. בחרו עיר."; },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

/* ------------------------------------------------------------ affinity cards */
// Discounts from affinity/credit cards that are NOT in the chains' price files.
// Defaults from public reports (Nov 2026); the user can edit each percentage.
const CARDS = [
  {
    id: "hever", name: "חבר (כרטיס אשראי חבר)",
    note: "קרפור: הנחה בקופה. רמי לוי: 5% החזר לכרטיס הנטען בקנייה חודשית מעל ₪500 בכרטיס חבר. שופרסל הפסיקה את ההטבה ב־11/2024.",
    rules: [
      { key: "carrefour-city", label: "קרפור סיטי", chain: "carrefour", match: /סיטי|city/i, pct: 6 },
      { key: "carrefour-market", label: "קרפור מרקט", chain: "carrefour", match: /מרקט|market/i, pct: 7 },
      { key: "carrefour-online", label: "קרפור אונליין", chain: "carrefour", online: true, pct: 5 },
      { key: "carrefour-other", label: "קרפור (היפר ואחר)", chain: "carrefour", pct: 0 },
      { key: "ramilevy", label: "רמי לוי (החזר)", chain: "ramilevy", pct: 5, cashback: true },
    ],
  },
  {
    id: "beyachad", name: "ביחד בשבילך",
    note: "לא נמצאה כרגע הנחה פעילה ברשתות המזון. אם יש לכם הטבה, הזינו את האחוז ידנית.",
    rules: [
      { key: "shufersal", label: "שופרסל", chain: "shufersal", pct: 0 },
      { key: "ramilevy", label: "רמי לוי", chain: "ramilevy", pct: 0 },
      { key: "carrefour", label: "קרפור", chain: "carrefour", pct: 0 },
      { key: "yohananof", label: "יוחננוף", chain: "yohananof", pct: 0 },
      { key: "osherad", label: "אושר עד", chain: "osherad", pct: 0 },
      { key: "tivtaam", label: "טיב טעם", chain: "tivtaam", pct: 0 },
      { key: "hazihinam", label: "חצי חינם", chain: "hazihinam", pct: 0 },
    ],
  },
];
const rulePct = (card, rule) => state.cardPct[card.id + ":" + rule.key] ?? rule.pct;
/** Best affinity-card discount for a store: {pct, label} or null. */
function cardDiscount(store) {
  let best = null;
  for (const card of CARDS) {
    if (!state.cards[card.id]) continue;
    const rule = card.rules.find((r) => r.chain === store.chain &&
      (r.online === undefined ? true : r.online === !!store.online) &&
      (!r.match || r.match.test(store.name)) );
    if (!rule) continue;
    if (rule.cashback && !state.rlMonthly) continue;
    const pct = rulePct(card, rule);
    if (pct > 0 && (!best || pct > best.pct)) best = { pct, label: `${pct}% ${rule.cashback ? "החזר" : "הנחת"} ${card.name.split(" ")[0]}` };
  }
  return best;
}

/* ------------------------------------------------------------ pricing */
function eligible(chain, club) {
  if (club === 0) return true;
  const c = state.clubs[chain] || {};
  return club === 1 ? !!c.club : club === 2 ? !!c.card : false;
}

/** Cost of q units of `code` at a store, using the best eligible deal.
 *  Deal: [minQty, totalForMinQty, club, descIdx, maxUnits?]. */
function itemCost(data, chain, code, q) {
  const p = data.p[code];
  if (p == null) return null;
  const deals = (data.d?.[code] || []).filter((d) => eligible(chain, d[2]));
  // single-unit price deals, possibly limited ("מוגבל ל־3")
  const unitCost = (n) => {
    let best = { cost: n * p, deal: null };
    for (const d of deals) {
      if (d[0] !== 1 || d[1] >= p) continue;
      const lim = d[4] ?? Infinity;
      const cost = Math.min(n, lim) * d[1] + Math.max(0, n - lim) * p;
      if (cost < best.cost - 0.001) best = { cost, deal: d };
    }
    return best;
  };
  let best = unitCost(q);
  if (Number.isInteger(q)) {
    for (const d of deals) {
      if (d[0] <= 1) continue;
      const kMax = d[4] ? Math.floor(d[4] / d[0]) : Infinity;
      const k = Math.min(Math.floor(q / d[0]), kMax);
      if (!k) continue;
      const rest = unitCost(q - k * d[0]);
      const cost = k * d[1] + rest.cost;
      if (cost < best.cost - 0.001) best = { cost, deal: d };
    }
  }
  const unit = q > 0 ? unitCost(1).cost : p;
  return { cost: best.cost, regular: q * p, deal: best.deal ? data.t[best.deal[3]] : null, unit, deals };
}

/** Quantity tips for multi-buy deals: add units to complete a deal, or drop
 *  units that fall outside the deal and are charged full price. */
function suggestion(data, chain, code, q, current) {
  if (!Number.isInteger(q)) return [];
  let add = null, remove = null;
  for (const d of current.deals) {
    const n = d[0];
    if (n <= 1) continue;
    const rem = q % n;
    if (!rem) continue;
    const desc = data.t[d[3]];
    const extra = n - rem;
    if (extra <= 5) {
      const added = itemCost(data, chain, code, q + extra).cost - current.cost;
      const saving = extra * current.unit - added;
      if (saving >= 0.5 && (!add || saving > add.saving)) add = { code, kind: "add", delta: extra, added, saving, desc };
    }
    if (q > n) {
      const removed = current.cost - itemCost(data, chain, code, q - rem).cost;
      if (removed >= 0.5 && (!remove || removed > remove.saving)) remove = { code, kind: "remove", delta: -rem, saving: removed, desc };
    }
  }
  return [add, remove].filter(Boolean);
}

function candidateStores() {
  const out = [];
  if (state.mode !== "online" && state.loc) {
    stores
      .filter((s) => !s.online && s.lat != null)
      .map((s) => ({ s, km: distKm(state.loc, s) }))
      .filter((x) => x.km <= state.radius)
      .sort((a, b) => a.km - b.km)
      .slice(0, MAX_STORES)
      .forEach((x) => out.push(x));
  }
  if (state.mode !== "store") stores.filter((s) => s.online).forEach((s) => out.push({ s, km: null }));
  return out;
}

let computeTimer = null, computeSeq = 0, lastResult = null;
let compared = false; // prices are shown only after the user asks for the cheapest cart
function scheduleCompute() { if (!compared) return; clearTimeout(computeTimer); computeTimer = setTimeout(compute, 350); }

/* ------------------------------------------------------------ similar products */
const STOP = new Set(["גרם", "גר", "ג", "ליטר", "ל", "מל", "מ\"ל", "יח", "יחידות", "קג", "ק\"ג", "של", "עם", "מארז", "אריזה",
  "בטעם", "במבצע", "חדש", "מבצע", "x", "לק\"ג", "לקג", "פירות", "וירקות"]);
const tokens = (name) => norm(name).replace(/[()\[\]+*\/,.\-–_]/g, " ").replace(/\d+(\.\d+)?%?/g, " ")
  .split(" ").filter((w) => w.length > 1 && !STOP.has(w));
function sizeOf(text) {
  const m = String(text || "").match(/([\d.]+)\s*(\S+)/);
  if (!m) return null;
  let q = parseFloat(m[1]); const u = m[2];
  if (!q) return null;
  if (/ליטר/.test(u) && !/מיליליטר/.test(u)) return { q: q * 1000, u: "ml" };
  if (/מיליליטר|מ"ל/.test(u)) return { q, u: "ml" };
  if (/קילו|ק"ג/.test(u)) return { q: q * 1000, u: "g" };
  if (/גרם|גר/.test(u)) return { q, u: "g" };
  if (/יח/.test(u)) return { q, u: "u" };
  return null;
}
const similarCache = new Map(), similarScore = new Map();
const PROCESSED = /מרוסק|קוביות|חתוכ|קצוצ|כבוש|מוחמצ|חמוצ|במלח|בחומץ|מיובש|רסק|רוטב|ממרח|מחית|קפוא|שימורים|בשמן|מבושל|קלוי|מטוגן|ציפס|מיץ|נקטר|סלט|ממולא|קורנישונ/;
/** Catalog products that look like the same thing (same type words, similar size). */
function similarCodes(it) {
  if (similarCache.has(it.c)) return similarCache.get(it.c);
  const info = catalog?.[it.c];
  const name = info ? info[0] : it.n;
  const t = tokens(name);
  const out = [];
  if (t.length) {
    const size = sizeOf(info ? info[2] : it.s) || sizeOf(name);
    const first = t[0];
    const tset = new Set(t);
    const processed = PROCESSED.test(norm(name));
    for (const [code, text, pop] of catalogIndex) {
      if (code === it.c || !text.includes(first)) continue;
      const v = catalog[code];
      const ct = tokens(v[0]);
      // same product type: first word matches (generic produce also matches by alias)
      const sameType = ct[0] === first || (code.startsWith("P:") && text.includes(first));
      if (!sameType) continue;
      const inter = ct.filter((w) => tset.has(w)).length;
      let score = inter / new Set([...t, ...ct]).size;
      if (code.startsWith("P:")) score += 0.5; // generic produce is the best match for produce
      const cs = sizeOf(v[2]) || sizeOf(v[0]);
      if (size && cs && size.u === cs.u) {
        const r = cs.q / size.q;
        score += r > 0.8 && r < 1.25 ? 0.2 : -0.4;
      } else if (size && cs) score -= 0.4;
      if (!processed && PROCESSED.test(text)) score -= 0.6; // fresh ≠ crushed / pickled
      if (score >= 0.35) out.push({ code, score, pop });
    }
  }
  out.sort((a, b) => b.score - a.score || b.pop - a.pop);
  const res = out.slice(0, 25).map((x) => x.code);
  for (const x of out.slice(0, 25)) similarScore.set(it.c + ">" + x.code, x.score);
  similarCache.set(it.c, res);
  return res;
}

/** Cheapest similar product available in this store, as a substitute. */
function substitute(data, chain, it) {
  let best = null;
  for (const code of similarCodes(it)) {
    if (data.p[code] == null) continue;
    const r = itemCost(data, chain, code, it.q);
    if (!best || r.cost < best.r.cost) best = { code, r };
  }
  return best;
}

/** Ask "did you mean…?" for items most nearby stores don't carry. Returns true if the list changed. */
async function resolveRareItems(list, datas) {
  const live = datas.filter(Boolean);
  if (!live.length) return false;
  const rare = list.items.filter((it) => !it.ok && live.filter((d) => d.p[it.c] != null).length < live.length / 2);
  if (!rare.length) return false;
  const blocks = rare.map((it, idx) => {
    const have = live.filter((d) => d.p[it.c] != null).length;
    const opts = similarCodes(it)
      .map((code) => {
        const prices = live.map((d) => d.p[code]).filter((x) => x != null);
        return { code, n: prices.length, min: prices.length ? Math.min(...prices) : 0 };
      })
      .filter((o) => o.n > 0)
      .map((o) => ({ ...o, score: similarScore.get(it.c + ">" + o.code) || 0 }))
      .sort((a, b) => b.score - a.score || b.n - a.n)
      .slice(0, 4);
    // pre-select a suggestion only when it is clearly the same thing
    const strong = opts.length && (opts[0].code.startsWith("P:") || opts[0].score >= 0.8) && opts[0].n >= live.length / 2;
    const radio = (val, label, checked) =>
      `<label class="opt"><input type="radio" name="r${idx}" value="${esc(val)}" ${checked ? "checked" : ""}> <span>${label}</span></label>`;
    return `<div class="resolve"><p><b>${esc(it.n)}</b><br><span class="meta">נמכר רק ב־${have} מתוך ${live.length} החנויות שנבדקו. האם הכוונה ל:</span></p>
      ${opts.map((o, k) => radio(o.code, `${esc(catalog[o.code][0])} <span class="meta">${esc(catalog[o.code][2] || "")} · ב־${o.n} חנויות · מ־₪${money(o.min)}</span>`, k === 0 && strong)).join("")}
      ${radio("__auto", 'מוצר דומה בכל חנות שאין בה את המוצר <span class="meta">(מסומן בתוצאות)</span>', !strong)}
      ${radio("__keep", "להשאיר בדיוק את המוצר הזה", false)}</div>`;
  });
  openDialog(`<h2>כמה מוצרים לא נמכרים ברוב החנויות</h2><p class="hint">כדי שהמחיר יהיה מלא בכל חנות, בחרו מה לחפש במקומם.</p>
    ${blocks.join("")}<div class="list-actions"><button class="btn primary" id="resolveOk">המשך לחישוב</button></div>`);
  const dlg = $("#dialog");
  dlg.querySelector("form").hidden = true;
  await new Promise((resolve) => {
    $("#resolveOk").onclick = () => {
      rare.forEach((it, idx) => {
        const v = dlg.querySelector(`input[name="r${idx}"]:checked`)?.value || "__auto";
        it.ok = 1;
        if (v === "__keep") it.sub = 0;
        else if (v === "__auto") it.sub = 1;
        else {
          const info = catalog[v];
          const dup = list.items.find((x) => x.c === v && x !== it);
          if (dup) { dup.q += it.q; it.q = 0; }
          else Object.assign(it, { c: v, n: info[0], s: info[2], w: info[3], sub: 1 });
        }
      });
      list.items = list.items.filter((x) => x.q > 0);
      save(); renderList(); dlg.close();
    };
    dlg.onclose = () => { dlg.onclose = null; rare.forEach((it) => { it.ok = 1; it.sub ??= 1; }); save(); resolve(); };
  });
  return true;
}

let resolving = false;
async function compute() {
  if (resolving) return;
  const seq = ++computeSeq;
  const list = activeList();
  const status = $("#compareStatus");
  await refreshMeta(false);
  if (!list.items.length) { lastResult = null; renderCompare(); return; }
  const cands = candidateStores();
  if (!cands.length) {
    lastResult = null;
    status.textContent = state.mode === "online" ? "אין חנויות אונליין בנתונים." :
      state.loc ? "אין סניפים בטווח שנבחר. נסו להגדיל את המרחק." : "בחרו מיקום כדי להשוות גם סניפים קרובים.";
    renderCompare(); renderList();
    return;
  }
  status.textContent = `בודק מחירים ב־${cands.length} חנויות…`;
  const [datas] = await Promise.all([Promise.all(cands.map((c) => loadStore(c.s.id))), loadCatalog()]);
  if (seq !== computeSeq) return;
  resolving = true;
  try { await resolveRareItems(list, datas); } finally { resolving = false; }
  if (seq !== computeSeq) return;
  const deliveryFee = Number(state.fee) || 0;
  const ranked = [];
  cands.forEach((c, i) => {
    const data = datas[i];
    if (!data) return;
    let total = 0, regular = 0, missing = 0, subs = 0;
    const lines = [], suggestions = [];
    for (const it of list.items) {
      let r = itemCost(data, c.s.chain, it.c, it.q), sub = null;
      if (!r && it.sub !== 0) {
        const alt = substitute(data, c.s.chain, it);
        if (alt) { r = alt.r; sub = catalog[alt.code][0]; subs++; }
      }
      if (!r) { missing++; lines.push({ code: it.c, name: it.n, q: it.q, cost: null }); continue; }
      total += r.cost; regular += r.regular;
      lines.push({ code: it.c, name: it.n, q: it.q, cost: r.cost, regular: r.regular, deal: r.deal, match: sub ? null : data.n?.[it.c], sub });
      if (!sub) suggestions.push(...suggestion(data, c.s.chain, it.c, it.q, r));
    }
    const fee = c.s.online ? deliveryFee : 0;
    const card = cardDiscount(c.s);
    const cardOff = card ? total * card.pct / 100 : 0;
    ranked.push({ store: c.s, km: c.km, total: total - cardOff + fee, fee, saved: regular - total, card, cardOff, missing, subs, lines, suggestions });
  });
  // A chain may publish several online stores (by region); keep its cheapest one.
  const seenOnline = new Map();
  for (const r of ranked) {
    if (!r.store.online) continue;
    const prev = seenOnline.get(r.store.chain);
    if (!prev || r.missing < prev.missing || (r.missing === prev.missing && r.total < prev.total)) seenOnline.set(r.store.chain, r);
  }
  for (let k = ranked.length - 1; k >= 0; k--) {
    if (ranked[k].store.online && seenOnline.get(ranked[k].store.chain) !== ranked[k]) ranked.splice(k, 1);
  }
  ranked.sort((a, b) => a.missing - b.missing || a.total - b.total || a.subs - b.subs || (a.km ?? 0) - (b.km ?? 0));
  lastResult = { listId: list.id, ranked, count: list.items.length };
  const nStore = ranked.filter((r) => !r.store.online).length;
  status.textContent = `נבדקו ${nStore} סניפים${ranked.length - nStore ? ` ו־${ranked.length - nStore} חנויות אונליין` : ""} · מחירים מ־${meta.generated}`;
  renderCompare(); renderList();
}

/* ------------------------------------------------------------ render compare */
const chainName = (c) => meta?.chains?.[c]?.name || c;
function storeTitle(s) { return `${chainName(s.chain)} – ${s.name}`; }
function navLinks(s) {
  if (s.lat == null) return "";
  return `<a href="https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes" target="_blank" rel="noopener">🚗 Waze</a>
    <a href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}" target="_blank" rel="noopener">🗺️ מפות</a>`;
}

function renderCompare() {
  const box = $("#compare");
  const bar = $("#cheapestBar");
  if (!lastResult || !lastResult.ranked.length) {
    $("#summary").innerHTML = "";
    box.innerHTML = activeList().items.length ? "" : '<div class="empty"><p>הוסיפו מוצרים לרשימה כדי להשוות.</p></div>';
    bar.hidden = true;
    return;
  }
  const { ranked, count } = lastResult;
  renderSummary(ranked);
  box.innerHTML = ranked.slice(0, 15).map((r, i) => {
    const s = r.store;
    const where = [s.address, s.city].filter(Boolean).join(", ");
    const badges = (i === 0 ? '<span class="badge best">הכי זול</span>' : "") +
      (s.online ? '<span class="badge online">אונליין</span>' : "") +
      (r.subs ? `<span class="badge sub">${r.subs} מוצרים דומים</span>` : "") +
      (r.missing ? `<span class="badge missing">חסרים ${r.missing}</span>` : "") +
      (r.saved > 0.5 ? `<span class="badge saved">חיסכון ₪${money(r.saved)} במבצעים</span>` : "") +
      (r.card ? `<span class="badge saved">כולל ${esc(r.card.label)} (₪${money(r.cardOff)})</span>` : "");
    return `<article class="store ${i === 0 ? "best" : ""}" data-idx="${i}">
      <div class="head"><div class="title">${esc(storeTitle(s))}${badges}</div><div class="total">₪${money(r.total)}</div></div>
      <div class="sub">${esc(where)}${r.km != null ? ` · ${s.approx ? "~" : ""}${r.km.toFixed(1)} ק״מ${s.approx ? " (מיקום משוער)" : ""}` : ""} · ${count - r.missing}/${count} מוצרים${r.fee ? ` · כולל משלוח ₪${money(r.fee)}` : ""}</div>
      ${i === 0 ? tipsHtml(r) : ""}
      <div class="actions">${navLinks(s)}
        <button data-share="${i}">💬 שיתוף בוואטסאפ</button>
        <button data-detail="${i}">🧾 פירוט</button></div>
    </article>`;
  }).join("");
  const b = ranked[0];
  bar.hidden = currentTab === "compare";
  bar.innerHTML = `<span>הכי זול: <b>${esc(storeTitle(b.store))}</b>${b.missing ? ` (חסרים ${b.missing})` : ""}</span><b>₪${money(b.total)}</b>`;
}

function renderSummary(ranked) {
  const box = $("#summary");
  const best = (online) => ranked.find((r) => !!r.store.online === online);
  const st = best(false), on = best(true);
  if (!st || !on || state.mode !== "all") { box.innerHTML = ""; return; }
  const line = (r, label) => `<div class="sum-col ${r === ranked[0] ? "win" : ""}"><div class="sum-label">${label}</div>
    <div class="sum-total">₪${money(r.total)}</div><div class="sum-store">${esc(storeTitle(r.store))}</div>
    <div class="sum-note">${r.missing ? `חסרים ${r.missing} · ` : ""}${r.fee ? `כולל משלוח ₪${money(r.fee)}` : r.km != null ? `${r.km.toFixed(1)} ק״מ` : ""}</div></div>`;
  let verdict;
  if (st.missing !== on.missing) verdict = st.missing < on.missing ? "בחנות יש יותר מהמוצרים ברשימה" : "באונליין יש יותר מהמוצרים ברשימה";
  else {
    const diff = Math.abs(st.total - on.total);
    verdict = diff < 0.5 ? "המחיר כמעט זהה" : st.total < on.total ? `בחנות זול יותר ב־₪${money(diff)}` : `אונליין זול יותר ב־₪${money(diff)}, כולל משלוח`;
  }
  box.innerHTML = `<div class="summary"><div class="sum-cols">${line(st, "🏬 הכי זול בחנות")}${line(on, "🚚 הכי זול אונליין")}</div>
    <div class="sum-verdict">${verdict}</div></div>`;
}

function tipsHtml(r) {
  if (!r.suggestions.length) return "";
  const name = (code) => activeList().items.find((x) => x.c === code)?.n || code;
  return `<div class="tips"><b>💡 הצעות לחיסכון בסניף הזה</b>${r.suggestions.map((t) => t.kind === "add"
    ? `<div class="deal"><span>${esc(name(t.code))}: מבצע "${esc(t.desc)}". הוסיפו עוד ${t.delta} ב־₪${money(t.added)} בלבד (חיסכון ₪${money(t.saving)})</span>
       <button data-apply="${t.code}" data-delta="${t.delta}">+${t.delta}</button></div>`
    : `<div class="deal tip-remove"><span>${esc(name(t.code))}: ${-t.delta} יח׳ מעבר למבצע "${esc(t.desc)}" במחיר מלא. אפשר להוריד ${-t.delta} ולחסוך ₪${money(t.saving)}</span>
       <button data-apply="${t.code}" data-delta="${t.delta}">${t.delta}</button></div>`).join("")}</div>`;
}

function showDetail(i) {
  const r = lastResult.ranked[i];
  const rows = r.lines.map((l) => l.cost == null
    ? `<tr><td>${esc(l.name)} ×${l.q}</td><td class="n miss">לא נמכר בסניף</td></tr>`
    : `<tr><td>${esc(l.name)} ×${l.q}${l.match ? `<div class="meta">בסניף: ${esc(l.match)}</div>` : ""}${l.sub ? `<div class="subtxt">↔ מוצר דומה: ${esc(l.sub)}</div>` : ""}${l.deal ? `<div class="dealtxt">🏷️ ${esc(l.deal)}</div>` : ""}</td>
       <td class="n">₪${money(l.cost)}${l.deal ? `<div class="dealtxt"><s>₪${money(l.regular)}</s></div>` : ""}</td></tr>`).join("");
  openDialog(`<h2>${esc(storeTitle(r.store))}</h2>
    <div class="hint">${esc([r.store.address, r.store.city].filter(Boolean).join(", "))}</div>
    <table class="breakdown">${rows}
      ${r.cardOff ? `<tr><td>${esc(r.card.label)}</td><td class="n">−₪${money(r.cardOff)}</td></tr>` : ""}
      ${r.fee ? `<tr><td>משלוח (משוער)</td><td class="n">₪${money(r.fee)}</td></tr>` : ""}
      <tr><td><b>סה״כ</b></td><td class="n"><b>₪${money(r.total)}</b></td></tr></table>`);
}

/* ------------------------------------------------------------ share */
function listLink(list) {
  const payload = { n: list.name, i: list.items.map((i) => [i.c, i.q, i.n.slice(0, 40)]) };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return location.origin + location.pathname + "#l=" + b64;
}
function whatsapp(text) { window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener"); }
function shareList() {
  const list = activeList();
  if (!list.items.length) { toast("הרשימה ריקה"); return; }
  const lines = list.items.map((i) => `• ${i.n}${i.q !== 1 ? ` ×${i.q}` : ""}`).join("\n");
  whatsapp(`🛒 ${list.name}\n${lines}\n\nלפתיחת הרשימה ב־Shopil:\n${listLink(list)}`);
}
function shareStore(i) {
  const r = lastResult.ranked[i], s = r.store, list = activeList();
  const where = [s.address, s.city].filter(Boolean).join(", ");
  let text = `🛒 הסל הכי זול לרשימה "${list.name}":\n${storeTitle(s)}${where ? `\n📍 ${where}` : ""}\n💰 ₪${money(r.total)} (${lastResult.count - r.missing}/${lastResult.count} מוצרים)`;
  if (s.lat != null) text += `\n🚗 ניווט: https://waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes`;
  text += `\n\n${list.items.map((x) => `• ${x.n}${x.q !== 1 ? ` ×${x.q}` : ""}`).join("\n")}\n\nהרשימה ב־Shopil: ${listLink(list)}`;
  whatsapp(text);
}
function watchList(list) {
  Sync.subscribe(list, (items, name) => {
    list.items = items;
    if (name) list.name = name;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
    if (list.id === state.active) { renderList(); scheduleCompute(); } else renderListsBar();
  });
}
async function liveShare() {
  const list = activeList();
  if (!Sync.enabled()) {
    openDialog(`<h2>שיתוף חי</h2><p>שיתוף חי מסנכרן את הרשימה בין כמה טלפונים בזמן אמת: מה שמוסיפים או מסמנים ב־✓ בטלפון אחד מופיע מיד בשני.</p>
      <p class="hint">הסנכרון עוד לא הוגדר באתר הזה. בינתיים אפשר לשתף עותק של הרשימה בוואטסאפ.</p>`);
    return;
  }
  if (!(await Sync.init())) { toast("לא ניתן להתחבר לשרת הסנכרון"); return; }
  if (!list.sync) {
    list.sync = Sync.newId();
    save();
    await Sync.push(list);
    watchList(list);
  }
  const link = location.origin + location.pathname + "#sync=" + list.sync;
  whatsapp(`🛒 בואו נעשה קניות ביחד: "${list.name}"\nהרשימה מתעדכנת אצל כולם בזמן אמת:\n${link}`);
}

function importFromHash() {
  const sm = location.hash.match(/#sync=([a-z0-9]{20,40})/);
  if (sm) {
    let list = state.lists.find((l) => l.sync === sm[1]);
    if (!list) {
      list = { id: uid(), name: "רשימה משותפת", items: [], sync: sm[1] };
      state.lists.push(list);
      toast("הצטרפתם לרשימה משותפת");
    }
    state.active = list.id; save();
    history.replaceState(null, "", location.pathname);
    return;
  }
  const m = location.hash.match(/#l=([\w-]+)/);
  if (!m) return;
  try {
    const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))));
    const p = JSON.parse(json);
    const list = { id: uid(), name: (p.n || "רשימה משותפת") + " (שותפה)", items: p.i.map(([c, q, n]) => ({ c, q, n, w: String(c).startsWith("P:") ? 1 : 0 })) };
    state.lists.push(list); state.active = list.id; save();
    toast("הרשימה המשותפת נוספה");
  } catch (_) { toast("קישור הרשימה לא תקין"); }
  history.replaceState(null, "", location.pathname);
}

/* ------------------------------------------------------------ settings */
function renderClubs() {
  if (!meta) return;
  $("#clubs").innerHTML = Object.entries(meta.chains).map(([key, c]) => {
    const v = state.clubs[key] || {};
    return `<div class="club"><b>${esc(c.name)}</b>
      <label><input type="checkbox" data-chain="${key}" data-kind="club" ${v.club ? "checked" : ""}> חבר/ה במועדון</label>
      <label><input type="checkbox" data-chain="${key}" data-kind="card" ${v.card ? "checked" : ""}> כרטיס האשראי של הרשת</label></div>`;
  }).join("");
  $("#chainsInfo").innerHTML = "רשתות: " + Object.values(meta.chains).map((c) => `${esc(c.name)} (${c.stores} סניפים, עודכן ${esc(c.updated)})`).join(" · ");
}
function renderCardsSettings() {
  $("#cards").innerHTML = CARDS.map((card) => `<div class="club card-box">
    <label class="card-title"><input type="checkbox" data-card="${card.id}" ${state.cards[card.id] ? "checked" : ""}> <b>${esc(card.name)}</b></label>
    <div class="hint">${esc(card.note)}</div>
    ${state.cards[card.id] ? `<div class="card-rules">${card.rules.map((r) => `<label>${esc(r.label)}
      <span><input type="number" min="0" max="30" step="0.5" data-pct="${card.id}:${r.key}" value="${rulePct(card, r)}" inputmode="decimal">%</span></label>`).join("")}
      ${card.id === "hever" ? `<label class="rl"><input type="checkbox" id="rlMonthly" ${state.rlMonthly ? "checked" : ""}> אני קונה ברמי לוי מעל ₪500 בחודש בכרטיס חבר (לחישוב ההחזר)</label>` : ""}</div>` : ""}
  </div>`).join("");
}

function renderCatsSettings() {
  $("#autoSort").checked = !!state.autoSort;
  $("#catsList").innerHTML = cats().map((c, i) => `<li data-id="${esc(c.id)}">
      <input class="cat-name" value="${esc(c.label)}" aria-label="שם הקטגוריה">
      <button data-move="-1" ${i === 0 ? "disabled" : ""} aria-label="הזזה למעלה">▲</button>
      <button data-move="1" ${i === cats().length - 1 ? "disabled" : ""} aria-label="הזזה למטה">▼</button>
      ${c.id === "other" ? "" : '<button data-del aria-label="מחיקה">✕</button>'}</li>`).join("");
}

function renderMeta() { $("#updated").textContent = meta ? `מחירים: ${meta.generated}` : ""; }

/* ------------------------------------------------------------ barcode scan */
async function scanBarcode() {
  let stream;
  try {
    const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    openDialog('<video class="scan" playsinline muted></video><p class="hint">כוונו את המצלמה לברקוד</p>');
    const video = $("#dialogBody video");
    video.srcObject = stream; await video.play();
    const dlg = $("#dialog");
    while (dlg.open) {
      const codes = await detector.detect(video).catch(() => []);
      if (codes.length) {
        const code = codes[0].rawValue.replace(/^0+/, "");
        dlg.close();
        await loadCatalog();
        if (catalog[code]) { addItem(code); toast("נוסף: " + catalog[code][0]); }
        else { $("#search").value = code; doSearch(code); toast("המוצר לא נמצא במאגר"); }
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    toast("לא ניתן להפעיל את המצלמה");
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

/* ------------------------------------------------------------ ui helpers */
function ask(title, { input = null, ok = "אישור", danger = false } = {}) {
  return new Promise((resolve) => {
    openDialog(`<h2>${esc(title)}</h2>${input !== null ? `<p><input id="askInput" value="${esc(input)}" style="width:100%;height:42px;border-radius:10px;border:1px solid var(--line);background:var(--card);padding:0 10px"></p>` : ""}
      <div class="list-actions"><button class="btn ${danger ? "danger" : "primary"}" id="askOk">${esc(ok)}</button><button class="btn ghost" id="askCancel">ביטול</button></div>`);
    const dlg = $("#dialog");
    dlg.querySelector("form").hidden = true;
    const done = (v) => { dlg.onclose = null; dlg.close(); resolve(v); };
    $("#askOk").onclick = () => done(input !== null ? $("#askInput").value.trim() : true);
    $("#askCancel").onclick = () => done(input !== null ? null : false);
    dlg.onclose = () => resolve(input !== null ? null : false);
    $("#askInput")?.focus();
  });
}
function openDialog(html) { $("#dialogBody").innerHTML = html; $("#dialog").querySelector("form").hidden = false; $("#dialog").showModal(); }
let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2500);
}
let currentTab = "list";
function showTab(name) {
  currentTab = name;
  if (name === "compare") $("#cheapestBar").hidden = true;
  else if (lastResult?.ranked?.length) $("#cheapestBar").hidden = false;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  window.scrollTo(0, 0);
  if (name === "compare") { compared = true; compute(); }
}

function listMenu(id) {
  const l = state.lists.find((x) => x.id === id);
  openDialog(`<h2>${esc(l.name)}</h2>
    <p><label>שם הרשימה <input id="renameInput" value="${esc(l.name)}"></label></p>
    <div class="list-actions">
      <button class="btn primary" id="renameBtn">שמירה</button>
      <button class="btn" id="dupBtn">שכפול</button>
      ${state.lists.length > 1 ? '<button class="btn ghost" id="delBtn">מחיקת הרשימה</button>' : ""}
    </div>`);
  $("#renameBtn").onclick = () => { l.name = $("#renameInput").value.trim() || l.name; save(); renderList(); $("#dialog").close(); };
  $("#dupBtn").onclick = () => {
    const copy = { id: uid(), name: l.name + " (עותק)", items: l.items.map((i) => ({ ...i })) };
    state.lists.push(copy); state.active = copy.id; save(); renderList(); scheduleCompute(); $("#dialog").close();
  };
  const del = $("#delBtn");
  if (del) del.onclick = async () => {
    $("#dialog").close();
    if (!(await ask(`למחוק את "${l.name}"?`, { ok: "מחיקה", danger: true }))) return;
    state.lists = state.lists.filter((x) => x.id !== id); state.active = state.lists[0].id;
    save(); renderList(); scheduleCompute();
  };
}

/* ------------------------------------------------------------ events */
function bind() {
  let searchTimer;
  $("#search").addEventListener("input", (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(e.target.value), 200); });
  $("#search").addEventListener("focus", () => loadCatalog());
  $("#results").addEventListener("click", (e) => {
    const r = e.target.closest(".result[data-code]");
    if (!r) return;
    if (replacing) { replaceItem(replacing, r.dataset.code); replacing = null; $("#search").placeholder = "חפשו מוצר, מותג או ברקוד"; }
    else { addItem(r.dataset.code); toast("נוסף לרשימה"); }
    $("#search").value = ""; $("#results").innerHTML = "";
  });
  $("#items").addEventListener("click", (e) => {
    const li = e.target.closest(".item"); if (!li) return;
    const code = li.dataset.code;
    const it = activeList().items.find((i) => i.c === code);
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (e.target.dataset.dq) setQty(code, it.q + Number(e.target.dataset.dq));
    else if (act === "done") {
      it.st = it.st === "done" ? undefined : "done";
      if (it.st === "done") noteCollected(it.k);
      if (activeList().items.every((i) => i.st)) { commitTrip(); toast("סיימתם! סדר המחלקות נלמד לפעם הבאה"); }
      save(); renderList();
    }
    else if (act === "edit") editItem(code);
  });
  $("#progress").addEventListener("click", async (e) => {
    if (e.target.id !== "resetStatus") return;
    if (!(await ask("להתחיל קנייה חדשה? כל הסימונים (נאסף / חסר) יתאפסו, המוצרים נשארים.", { ok: "התחלה" }))) return;
    commitTrip();
    activeList().items.forEach((i) => { delete i.st; }); save(); renderList();
  });
  $("#listsBar").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-list]"); if (!b) return;
    const id = b.dataset.list;
    if (id === "__new") {
      const name = await ask("שם הרשימה החדשה", { input: "רשימה חדשה", ok: "יצירה" });
      if (!name) return;
      const l = { id: uid(), name: name.trim(), items: [] };
      state.lists.push(l); state.active = l.id;
    } else if (id === state.active) { listMenu(id); return; }
    else state.active = id;
    save(); lastResult = null; renderList(); scheduleCompute();
  });
  $("#shareListBtn").onclick = shareList;
  $("#liveShareBtn").onclick = liveShare;
  $("#clearListBtn").onclick = async () => {
    if (!activeList().items.length) { toast("הרשימה כבר ריקה"); return; }
    if (!(await ask(`לנקות את כל המוצרים מ"${activeList().name}"?`, { ok: "ניקוי", danger: true }))) return;
    lastResult = null; renderCompare();
    activeList().items = []; save(); renderList(); scheduleCompute();
  };
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  $("#cheapestBar").onclick = () => showTab("compare");
  $("#findBtn").onclick = () => showTab("compare");
  document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => {
    state.mode = b.dataset.mode; save();
    document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x === b));
    $("#locationBox").hidden = state.mode === "online"; $("#radius").hidden = state.mode === "online";
    compute();
  }));
  $("#radius").value = String(state.radius);
  $("#radius").onchange = (e) => { state.radius = Number(e.target.value); save(); compute(); };
  $("#gpsBtn").onclick = useGPS;
  $("#cityInput").addEventListener("change", (e) => {
    const c = cityCenters[e.target.value.trim()];
    if (c) setLocation({ ...c, label: e.target.value.trim() });
    else toast("לא נמצאה עיר עם סניפים בשם הזה");
  });
  $("#compare").addEventListener("click", (e) => {
    if (e.target.dataset.share) shareStore(Number(e.target.dataset.share));
    if (e.target.dataset.detail) showDetail(Number(e.target.dataset.detail));
    if (e.target.dataset.apply) {
      const it = activeList().items.find((x) => x.c === e.target.dataset.apply);
      if (it) { setQty(it.c, it.q + Number(e.target.dataset.delta)); toast("הכמות עודכנה"); }
    }
  });
  $("#clubs").addEventListener("change", (e) => {
    const { chain, kind } = e.target.dataset; if (!chain) return;
    (state.clubs[chain] ||= {})[kind] = e.target.checked; save(); scheduleCompute();
  });
  $("#deliveryFee").value = state.fee;
  $("#deliveryFee").onchange = (e) => { state.fee = Number(e.target.value) || 0; save(); scheduleCompute(); };
  renderCatsSettings();
  renderCardsSettings();
  $("#cards").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.card) state.cards[t.dataset.card] = t.checked;
    else if (t.dataset.pct) state.cardPct[t.dataset.pct] = Math.max(0, Math.min(30, Number(t.value) || 0));
    else if (t.id === "rlMonthly") state.rlMonthly = t.checked;
    else return;
    save(); renderCardsSettings(); scheduleCompute();
  });
  $("#autoSort").onchange = (e) => { state.autoSort = e.target.checked; save(); renderList(); };
  $("#catsList").addEventListener("change", (e) => {
    if (!e.target.classList.contains("cat-name")) return;
    const c = cats().find((x) => x.id === e.target.closest("li").dataset.id);
    if (c && e.target.value.trim()) { c.label = e.target.value.trim(); save(); renderList(); }
  });
  $("#catsList").addEventListener("click", async (e) => {
    const li = e.target.closest("li"); if (!li) return;
    const list = cats(), i = list.findIndex((x) => x.id === li.dataset.id);
    if (e.target.dataset.move) {
      const j = i + Number(e.target.dataset.move);
      [list[i], list[j]] = [list[j], list[i]];
      state.autoSort = false; // a manual order means the user wants this order
    } else if (e.target.hasAttribute("data-del")) {
      if (!(await ask(`למחוק את הקטגוריה "${list[i].label}"? המוצרים בה יעברו ל"אחר".`, { ok: "מחיקה", danger: true }))) return;
      const id = list[i].id;
      list.splice(i, 1);
      for (const l of state.lists) for (const it of l.items) if (it.k === id) it.k = "other";
      for (const [code, k] of Object.entries(state.catMap)) if (k === id) delete state.catMap[code];
    } else return;
    save(); renderCatsSettings(); renderList();
  });
  $("#addCat").onclick = async () => {
    const name = await ask("שם הקטגוריה החדשה", { input: "", ok: "הוספה" });
    if (!name) return;
    cats().splice(Math.max(0, cats().length - 1), 0, { id: "c" + uid(), label: name });
    save(); renderCatsSettings(); renderList();
  };
  if ("BarcodeDetector" in window && navigator.mediaDevices) {
    $("#scanBtn").hidden = false; $("#scanBtn").onclick = scanBarcode;
  }
  // Pick up price updates when the user returns to the app.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshMeta(true).then((ch) => ch && compute()); });
}

/* ------------------------------------------------------------ boot */
(async function init() {
  importFromHash();
  bind();
  document.querySelectorAll(".seg button").forEach((x) => x.classList.toggle("on", x.dataset.mode === state.mode));
  $("#locationBox").hidden = state.mode === "online"; $("#radius").hidden = state.mode === "online";
  if (state.loc) $("#locText").textContent = "📍 " + state.loc.label;
  renderList();
  try { await refreshMeta(true); } catch (e) { $("#updated").textContent = "לא ניתן לטעון נתונים"; }
  state.lists.filter((l) => l.sync).forEach(watchList);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
