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
  s.mode = s.mode || "store";
  s.radius = s.radius || 5;
  return s;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { /* ignore */ } }
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
      catalogIndex = Object.entries(c).map(([code, v]) => [code, norm(v[0] + " " + v[1]), v[4] || 0]);
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
  else list.items.push({ c: code, n: info ? info[0] : code, s: info ? info[2] : "", w: info ? info[3] : 0, q: qty });
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
    state.lists.map((l) => `<button class="chip ${l.id === state.active ? "on" : ""}" data-list="${l.id}">${esc(l.name)} <small>(${l.items.length})</small></button>`).join("") +
    '<button class="chip" data-list="__new">+ רשימה חדשה</button>';
}

function renderList() {
  renderListsBar();
  const list = activeList();
  const ul = $("#items");
  $("#emptyList").hidden = list.items.length > 0;
  $("#countBadge").textContent = list.items.length || "";
  ul.innerHTML = list.items.map((it) => {
    const step = it.w ? 0.5 : 1;
    return `<li class="item" data-code="${it.c}">
      <div class="row1">
        <div class="name">${esc(it.n)}<div class="meta">${esc(it.s || "")}${it.w ? " · לק״ג" : ""}</div></div>
        <div class="qty"><button data-dq="${-step}" aria-label="הפחתה">−</button><span>${it.q}</span><button data-dq="${step}" aria-label="הוספה">+</button></div>
      </div></li>`;
  }).join("");
  $("#findBtn").hidden = !list.items.length;
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

/* ------------------------------------------------------------ pricing */
function eligible(chain, club) {
  if (club === 0) return true;
  const c = state.clubs[chain] || {};
  return club === 1 ? !!c.club : club === 2 ? !!c.card : false;
}

/** Cost of q units of `code` at a store, using the best eligible deal. */
function itemCost(data, chain, code, q) {
  const p = data.p[code];
  if (p == null) return null;
  const deals = (data.d?.[code] || []).filter((d) => eligible(chain, d[2]));
  let unit = p, unitDeal = null;
  for (const d of deals) if (d[0] === 1 && d[1] < unit) { unit = d[1]; unitDeal = d; }
  let best = { cost: q * unit, deal: unitDeal };
  if (Number.isInteger(q)) {
    for (const d of deals) {
      if (d[0] <= 1) continue;
      const k = Math.floor(q / d[0]);
      if (!k) continue;
      const cost = k * d[1] + (q - k * d[0]) * unit;
      if (cost < best.cost - 0.001) best = { cost, deal: d };
    }
  }
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
  if (state.mode === "online") return stores.filter((s) => s.online).slice(0, 30).map((s) => ({ s, km: null }));
  if (!state.loc) return [];
  return stores
    .filter((s) => !s.online && s.lat != null)
    .map((s) => ({ s, km: distKm(state.loc, s) }))
    .filter((x) => x.km <= state.radius)
    .sort((a, b) => a.km - b.km)
    .slice(0, MAX_STORES);
}

let computeTimer = null, computeSeq = 0, lastResult = null;
let compared = false; // prices are shown only after the user asks for the cheapest cart
function scheduleCompute() { if (!compared) return; clearTimeout(computeTimer); computeTimer = setTimeout(compute, 350); }

async function compute() {
  const seq = ++computeSeq;
  const list = activeList();
  const status = $("#compareStatus");
  await refreshMeta(false);
  if (!list.items.length) { lastResult = null; renderCompare(); return; }
  const cands = candidateStores();
  if (!cands.length) {
    lastResult = null;
    status.textContent = state.mode === "online" ? "אין חנויות אונליין בנתונים." :
      state.loc ? "אין סניפים בטווח שנבחר. נסו להגדיל את המרחק." : "בחרו מיקום כדי למצוא את הסל הזול ביותר.";
    renderCompare(); renderList();
    return;
  }
  status.textContent = `בודק מחירים ב־${cands.length} סניפים…`;
  const datas = await Promise.all(cands.map((c) => loadStore(c.s.id)));
  if (seq !== computeSeq) return;
  const fee = state.mode === "online" ? Number(state.fee) || 0 : 0;
  const ranked = [];
  cands.forEach((c, i) => {
    const data = datas[i];
    if (!data) return;
    let total = 0, regular = 0, missing = 0;
    const lines = [], suggestions = [];
    for (const it of list.items) {
      const r = itemCost(data, c.s.chain, it.c, it.q);
      if (!r) { missing++; lines.push({ code: it.c, name: it.n, q: it.q, cost: null }); continue; }
      total += r.cost; regular += r.regular;
      lines.push({ code: it.c, name: it.n, q: it.q, cost: r.cost, regular: r.regular, deal: r.deal });
      suggestions.push(...suggestion(data, c.s.chain, it.c, it.q, r));
    }
    ranked.push({ store: c.s, km: c.km, total: total + fee, fee, saved: regular - total, missing, lines, suggestions });
  });
  ranked.sort((a, b) => a.missing - b.missing || a.total - b.total || (a.km ?? 0) - (b.km ?? 0));
  lastResult = { listId: list.id, ranked, count: list.items.length };
  status.textContent = `נבדקו ${ranked.length} סניפים · מחירים מ־${meta.generated}`;
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
    box.innerHTML = activeList().items.length ? "" : '<div class="empty"><p>הוסיפו מוצרים לרשימה כדי להשוות.</p></div>';
    bar.hidden = true;
    return;
  }
  const { ranked, count } = lastResult;
  box.innerHTML = ranked.slice(0, 15).map((r, i) => {
    const s = r.store;
    const where = [s.address, s.city].filter(Boolean).join(", ");
    const badges = (i === 0 ? '<span class="badge best">הכי זול</span>' : "") +
      (r.missing ? `<span class="badge missing">חסרים ${r.missing}</span>` : "") +
      (r.saved > 0.5 ? `<span class="badge saved">חיסכון ₪${money(r.saved)} במבצעים</span>` : "");
    return `<article class="store ${i === 0 ? "best" : ""}" data-idx="${i}">
      <div class="head"><div class="title">${esc(storeTitle(s))}${badges}</div><div class="total">₪${money(r.total)}</div></div>
      <div class="sub">${esc(where)}${r.km != null ? ` · ${r.km.toFixed(1)} ק״מ` : ""} · ${count - r.missing}/${count} מוצרים${r.fee ? ` · כולל משלוח ₪${money(r.fee)}` : ""}</div>
      ${i === 0 ? tipsHtml(r) : ""}
      <div class="actions">${navLinks(s)}
        <button data-share="${i}">💬 שיתוף בוואטסאפ</button>
        <button data-detail="${i}">🧾 פירוט</button></div>
    </article>`;
  }).join("");
  const b = ranked[0];
  bar.hidden = false;
  bar.innerHTML = `<span>הכי זול: <b>${esc(storeTitle(b.store))}</b>${b.missing ? ` (חסרים ${b.missing})` : ""}</span><b>₪${money(b.total)}</b>`;
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
    : `<tr><td>${esc(l.name)} ×${l.q}${l.deal ? `<div class="dealtxt">🏷️ ${esc(l.deal)}</div>` : ""}</td>
       <td class="n">₪${money(l.cost)}${l.deal ? `<div class="dealtxt"><s>₪${money(l.regular)}</s></div>` : ""}</td></tr>`).join("");
  openDialog(`<h2>${esc(storeTitle(r.store))}</h2>
    <div class="hint">${esc([r.store.address, r.store.city].filter(Boolean).join(", "))}</div>
    <table class="breakdown">${rows}
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
function importFromHash() {
  const m = location.hash.match(/#l=([\w-]+)/);
  if (!m) return;
  try {
    const json = decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))));
    const p = JSON.parse(json);
    const list = { id: uid(), name: (p.n || "רשימה משותפת") + " (שותפה)", items: p.i.map(([c, q, n]) => ({ c, q, n })) };
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
function showTab(name) {
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
    addItem(r.dataset.code);
    toast("נוסף לרשימה");
    $("#search").value = ""; $("#results").innerHTML = "";
  });
  $("#items").addEventListener("click", (e) => {
    const li = e.target.closest(".item"); if (!li) return;
    const code = li.dataset.code;
    const it = activeList().items.find((i) => i.c === code);
    if (e.target.dataset.dq) setQty(code, it.q + Number(e.target.dataset.dq));
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
