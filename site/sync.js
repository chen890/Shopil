/* Live list sync over Firebase Realtime Database.
 *
 * A synced list lives at /lists/<id> = { name, updated, items: { <key>: item } }.
 * The id is a long random string: whoever has the link can read and write.
 * Each item is its own child, so two people changing different items at the
 * same time don't overwrite each other.
 */
"use strict";

const Sync = (() => {
  const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
  let db = null, ready = null;
  const subs = new Map();      // listId -> firebase ref
  const lastSent = new Map();  // listId -> {key: json}
  const enabled = () => !!window.SHOPIL_FIREBASE;
  const keyOf = (code) => String(code).replace(/[.#$\[\]\/]/g, "_");

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  function init() {
    if (!enabled()) return Promise.resolve(false);
    ready ||= loadScript(SDK + "firebase-app-compat.js")
      .then(() => loadScript(SDK + "firebase-database-compat.js"))
      .then(() => {
        const app = firebase.initializeApp(window.SHOPIL_FIREBASE);
        db = firebase.database(app);
        return true;
      })
      .catch(() => false);
    return ready;
  }

  const pack = (it) => {
    const o = {};
    for (const k of ["c", "n", "s", "w", "q", "k", "st", "note", "sub", "ok"]) if (it[k] !== undefined && it[k] !== null) o[k] = it[k];
    return o;
  };

  /** Push local changes of one list (only the items that changed). */
  async function push(list) {
    if (!list.sync || !(await init())) return;
    const prev = lastSent.get(list.sync) || {};
    const now = {};
    const updates = {};
    for (const it of list.items) {
      const k = keyOf(it.c), json = JSON.stringify(pack(it));
      now[k] = json;
      if (prev[k] !== json) updates["items/" + k] = pack(it);
    }
    for (const k of Object.keys(prev)) if (!(k in now)) updates["items/" + k] = null;
    if (!Object.keys(updates).length) return;
    updates.name = list.name;
    updates.updated = firebase.database.ServerValue.TIMESTAMP;
    lastSent.set(list.sync, now);
    await db.ref("lists/" + list.sync).update(updates);
  }

  /** Listen to remote changes; onChange(items, name) is called with the full list. */
  async function subscribe(list, onChange) {
    if (!list.sync || subs.has(list.sync) || !(await init())) return;
    const ref = db.ref("lists/" + list.sync);
    subs.set(list.sync, ref);
    ref.on("value", (snap) => {
      const v = snap.val();
      if (!v) return;
      const items = Object.values(v.items || {});
      lastSent.set(list.sync, Object.fromEntries(items.map((it) => [keyOf(it.c), JSON.stringify(pack(it))])));
      onChange(items, v.name);
    });
  }

  function newId() {
    const a = new Uint8Array(18);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 28);
  }

  return { enabled, init, push, subscribe, newId };
})();
