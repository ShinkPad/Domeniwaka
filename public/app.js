(() => {
const firebaseConfig = window.NIWAKA_FIREBASE_CONFIG || {};
const startView = window.NIWAKA_START_VIEW || { lat: 35.0730, lng: 133.7535, zoom: 16 };
const ADMIN_EMAILS = (window.NIWAKA_ADMIN_EMAILS || []).map(s => String(s).trim().toLowerCase());

/* ============ 状態の種類 ============ */
// "todo" は以前の「未訪問」と同じ扱い（＝未訪問・可）
const ST = [
  { k: "todo",     label: "未訪問（可）",   c: "var(--st-todo)" },
  { k: "ng",       label: "未訪問（不可）", c: "var(--st-ng)" },
  { k: "received", label: "お花受取済",     c: "var(--st-rcv)" },
  { k: "done",     label: "俄留を貼った",   c: "var(--st-done)" },
  { k: "absent",   label: "不在・再訪",     c: "var(--st-abs)" },
  { k: "refused",  label: "断られた",       c: "var(--st-ref)" },
];
const stOf = k => ST.find(s => s.k === k) || ST[0];
// 俄留を貼れるのは夜9時から（日付が変わっても朝5時までは「夜」として扱う）
const POST_FROM_HOUR = 21;
const canPost = (d = new Date()) => d.getHours() >= POST_FROM_HOUR || d.getHours() < 5;
// 年度：祭りは10月なので、1〜3月はまだ前の年の年度として扱う
const yearOf = t => { const d = new Date(t || Date.now()); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; };

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const USE_FIREBASE = !!(firebaseConfig.apiKey && firebaseConfig.projectId);

/* ============ データの保存先 ============ */
// データの形
//   teams/{合言葉}                 … { year: 今の年度, allowHide: メンバーが非表示にできるか }（管理者だけ変更可）
//   teams/{合言葉}/houses/{id}     … { name, lat, lng, memo(家のメモ・毎年), hidden, years: { "2026": { status, note, updatedAt, updatedBy } } }
//   teams/{合言葉}/members/{uid}   … 位置を共有中のメンバー

// Firebase（チームで共有）
async function createFirebaseStore(team, onSync) {
  const V = "10.12.2";
  const [{ initializeApp }, A, fs] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig);
  let db;
  try {
    // 電波が悪くても端末に一時保存し、つながったら自動で送信する
    db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
  } catch { db = fs.getFirestore(app); }
  const auth = A.getAuth(app);
  await new Promise(res => { const un = A.onAuthStateChanged(auth, () => { un(); res(); }); }); // 前回のログインを復元
  if (!auth.currentUser) await A.signInAnonymously(auth);
  const tdoc = fs.doc(db, "teams", team);
  const col = fs.collection(db, "teams", team, "houses");
  const mcol = fs.collection(db, "teams", team, "members");
  return {
    get memberId() { return auth.currentUser && auth.currentUser.uid; },
    user() { const u = auth.currentUser; return { email: u && !u.isAnonymous ? (u.email || "").toLowerCase() : "", anon: !u || u.isAnonymous }; },
    onAuth(cb) { A.onAuthStateChanged(auth, () => cb()); },
    async signInAdmin() { await A.signInWithPopup(auth, new A.GoogleAuthProvider()); },
    async signOutAdmin() { await A.signOut(auth); await A.signInAnonymously(auth); },
    subscribeTeam(cb) { fs.onSnapshot(tdoc, s => cb(s.exists() ? s.data() : null), () => cb(null)); },
    setTeam(patch) { return fs.setDoc(tdoc, patch, { merge: true }); },
    subscribe(cb, onErr) {
      return fs.onSnapshot(col, { includeMetadataChanges: true }, snap => {
        cb(snap.docs.map(d => ({ id: d.id, ...d.data(), _pending: d.metadata.hasPendingWrites })));
        onSync(snap.metadata.hasPendingWrites ? "pending" : snap.metadata.fromCache ? "offline" : "ok");
      }, e => { onSync("error"); onErr && onErr(e); });
    },
    add(data) { const ref = fs.doc(col); fs.setDoc(ref, data).catch(err); return ref.id; },
    update(id, patch) { return fs.updateDoc(fs.doc(col, id), patch).catch(e => { err(e); throw e; }); },
    remove(id) { return fs.deleteDoc(fs.doc(col, id)).catch(e => { err(e); throw e; }); },
    subscribeMembers(cb) { fs.onSnapshot(mcol, s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), () => {}); },
    setMember(data) { if (auth.currentUser) fs.setDoc(fs.doc(mcol, auth.currentUser.uid), data).catch(console.error); },
    removeMember() { if (auth.currentUser) fs.deleteDoc(fs.doc(mcol, auth.currentUser.uid)).catch(console.error); },
  };
}

// お試しモード（この端末のブラウザだけに保存。管理者の操作も誰でも試せる）
function createLocalStore(team, onSync) {
  const mk = name => {
    const key = `niwakadome:${name}:${team}`;
    const read = () => { try { return JSON.parse(ls.get(key) || "{}"); } catch { return {}; } };
    let subs = [];
    const emit = () => { const o = read(); subs.forEach(cb => cb(o)); };
    addEventListener("storage", e => { if (e.key === key) emit(); });
    return { read, write(fn) { const o = read(); fn(o); ls.set(key, JSON.stringify(o)); emit(); }, sub(cb) { subs.push(cb); setTimeout(emit, 0); } };
  };
  const H = mk("houses"), M = mk("members"), T = mk("team");
  const setPath = (o, path, v) => { const ks = path.split("."); let x = o; ks.slice(0, -1).forEach(k => { if (typeof x[k] !== "object" || !x[k]) x[k] = {}; x = x[k]; }); x[ks[ks.length - 1]] = v; };
  let myMid = null;
  try { myMid = sessionStorage.getItem("niwakadome:mid"); } catch {}
  myMid = myMid || ("m" + Math.random().toString(36).slice(2, 10));
  try { sessionStorage.setItem("niwakadome:mid", myMid); } catch {}
  return {
    memberId: myMid,
    user() { return { email: "", anon: true }; },
    onAuth() {},
    subscribeTeam(cb) { T.sub(o => cb(Object.keys(o).length ? o : null)); },
    setTeam(patch) { T.write(o => Object.assign(o, patch)); return Promise.resolve(); },
    subscribe(cb) { H.sub(o => { cb(Object.entries(o).map(([id, v]) => ({ id, ...v }))); onSync("local"); }); },
    add(data) { const id = "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); H.write(o => { o[id] = data; }); return id; },
    update(id, patch) { H.write(o => { if (o[id]) for (const [k, v] of Object.entries(patch)) setPath(o[id], k, v); }); return Promise.resolve(); },
    remove(id) { H.write(o => { delete o[id]; }); return Promise.resolve(); },
    subscribeMembers(cb) { M.sub(o => cb(Object.entries(o).map(([id, v]) => ({ id, ...v })))); },
    setMember(data) { M.write(o => { o[myMid] = data; }); },
    removeMember() { M.write(o => { delete o[myMid]; }); },
  };
}
function err(e) {
  console.error(e);
  toast(e && e.code === "permission-denied" ? "この操作をする権限がありません" : "保存できませんでした。電波を確認してください");
}

/* ============ 画面の状態 ============ */
let store = null, houses = [], filter = new Set(ST.map(s => s.k));
let selId = null, mode = null /* "add" | "move" | null */, view = "map", loaded = false;
let team = null, myName = ls.get("niwakadome:name") || "";
let teamCfg = null;                  // チーム設定（年度など）
let viewYear = null;                 // 表示中の年度（過去の年も見られる）
const curYear = () => (teamCfg && teamCfg.year) || yearOf();
const allowHide = () => !teamCfg || teamCfg.allowHide !== false;
const isAdmin = () => {
  if (!store) return false;
  if (!USE_FIREBASE) return true;
  const u = store.user();
  return !!u.email && ADMIN_EMAILS.includes(u.email);
};
const vy = () => viewYear || curYear();
const isPast = () => vy() !== curYear();

/* ============ 年度ごとの記録 ============ */
// 古い形（status/note が直下にある）のデータは、更新した年の記録として読む
function normalize(h) {
  if (!h.years || typeof h.years !== "object") {
    h.years = {};
    if (h.status) h.years[yearOf(h.updatedAt)] = { status: h.status, note: h.note || "", updatedAt: h.updatedAt, updatedBy: h.updatedBy };
  }
  return h;
}
const rec = (h, y = vy()) => (h.years && h.years[y]) || null;
// その年の記録がなければ「未訪問（可）」。ただし直近の記録が「未訪問（不可）」か「断られた」なら「未訪問（不可）」にする
function effStatus(h, y = vy()) {
  const r = rec(h, y);
  if (r && r.status) return stOf(r.status).k;
  const prev = Object.keys(h.years || {}).map(Number).filter(v => v < y && h.years[v] && h.years[v].status).sort((a, b) => b - a)[0];
  if (prev && (h.years[prev].status === "ng" || h.years[prev].status === "refused")) return "ng";
  return "todo";
}
const inherited = h => !rec(h) && effStatus(h) === "ng";
const shown = () => houses.filter(h => !h.hidden);

/* ============ 地図 ============ */
const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([startView.lat, startView.lng], startView.zoom);
const GSI = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const layers = [
  { name: "地理院 標準", layer: L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", { maxNativeZoom: 18, maxZoom: 20, attribution: GSI }) },
  { name: "航空写真",   layer: L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", { maxNativeZoom: 18, maxZoom: 20, attribution: GSI }) },
  { name: "地理院 淡色", layer: L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", { maxNativeZoom: 18, maxZoom: 20, attribution: GSI }) },
];
let layerIdx = Math.min(+(ls.get("niwakadome:layer") || 0), layers.length - 1) || 0;
layers[layerIdx].layer.addTo(map);
$("layerBtn").onclick = () => {
  map.removeLayer(layers[layerIdx].layer);
  layerIdx = (layerIdx + 1) % layers.length;
  layers[layerIdx].layer.addTo(map);
  ls.set("niwakadome:layer", layerIdx);
  toast(layers[layerIdx].name);
};
const zoomClass = () => $("map").classList.toggle("small-zoom", map.getZoom() < 16);
map.on("zoomend", zoomClass); zoomClass();

let meMarker = null;
map.on("locationfound", e => {
  if (!meMarker) meMarker = L.circleMarker(e.latlng, { radius: 8, color: "#fff", weight: 3, fillColor: "#2a7de1", fillOpacity: 1 }).addTo(map);
  else meMarker.setLatLng(e.latlng);
});
map.on("locationerror", () => toast("現在地を取得できませんでした（位置情報の許可を確認）"));
$("locBtn").onclick = () => map.locate({ setView: true, maxZoom: 18, enableHighAccuracy: true });

/* ============ メンバーの位置共有 ============ */
// 自分で「位置を共有」をオンにした人だけが表示される。アプリを閉じる・オフにすると消える。
// 10分以上更新がない人は表示しない（アプリを閉じたまま放置した場合など）。
// 送信は60秒に1回まで。立ち止まっている（10m未満しか動いていない）ときは5分に1回だけ送る。
// Firestore の無料枠（1日 読み込み5万回）を超えないように回数を抑えている。
const STALE_MS = 10 * 60 * 1000, SEND_EVERY_MS = 60 * 1000, IDLE_SEND_MS = 5 * 60 * 1000, MIN_MOVE_M = 10;
let members = [], sharing = false, watchId = null, lastSent = 0, lastPos = null;
const memberMarkers = new Map();
const ago = t => { const m = Math.floor((Date.now() - t) / 60000); return m < 1 ? "今" : m + "分前"; };
function memberIcon(m, mine) {
  return L.divIcon({
    className: "pin-icon", iconSize: [0, 0], iconAnchor: [0, 0],
    html: `<div class="mem${mine ? " mine" : ""}"><i class="dot"></i><span class="lbl">${esc(m.name || "メンバー")}${mine ? "（自分）" : ""}<small>${ago(m.at)}</small></span></div>`,
  });
}
function renderMembers() {
  const myId = store && store.memberId, now = Date.now(), vis = new Set();
  members.filter(m => typeof m.lat === "number" && now - m.at < STALE_MS).forEach(m => {
    vis.add(m.id);
    const mine = m.id === myId;
    let mk = memberMarkers.get(m.id);
    if (!mk) { mk = L.marker([m.lat, m.lng], { icon: memberIcon(m, mine), interactive: false, zIndexOffset: 2000 }).addTo(map); memberMarkers.set(m.id, mk); }
    else { mk.setLatLng([m.lat, m.lng]); mk.setIcon(memberIcon(m, mine)); }
  });
  for (const [id, mk] of memberMarkers) if (!vis.has(id)) { map.removeLayer(mk); memberMarkers.delete(id); }
  const others = members.filter(m => m.id !== myId && now - m.at < STALE_MS).length;
  $("shareLocBtn").title = sharing ? `位置を共有中（ほか${others}人）` : `位置を共有する（共有中 ${others}人）`;
  $("memCount").textContent = others ? others : "";
  $("memCount").hidden = !others;
}
setInterval(renderMembers, 30 * 1000);
function sendPos(p, force) {
  const now = Date.now();
  const moved = lastPos ? map.distance(lastPos, [p.coords.latitude, p.coords.longitude]) : Infinity;
  const elapsed = now - lastSent;
  if (!force && (elapsed < SEND_EVERY_MS || (moved < MIN_MOVE_M && elapsed < IDLE_SEND_MS))) return;
  lastSent = now; lastPos = [p.coords.latitude, p.coords.longitude];
  store.setMember({ name: myName, lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0), at: now });
}
function setSharing(on) {
  if (!store) return;
  if (on) {
    if (!navigator.geolocation) { toast("この端末では位置情報を使えません"); return; }
    watchId = navigator.geolocation.watchPosition(
      p => { const first = !sharing; if (first) { sharing = true; updateShareBtn(); toast("位置の共有を始めました"); } sendPos(p, first); },
      () => { toast("位置情報を取得できませんでした（ブラウザの許可を確認）"); setSharing(false); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
    ls.set("niwakadome:sharing", "1");
  } else {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null; lastPos = null;
    if (sharing) { store.removeMember(); toast("位置の共有をやめました"); }
    sharing = false; ls.set("niwakadome:sharing", "0"); updateShareBtn();
  }
}
function updateShareBtn() { $("shareLocBtn").classList.toggle("on", sharing); $("shareLocBtn").setAttribute("aria-pressed", sharing); }
$("shareLocBtn").onclick = () => setSharing(!sharing);
addEventListener("pagehide", () => { if (sharing && store) store.removeMember(); });

map.on("click", e => {
  if (mode === "add") addHouse(e.latlng.lat, e.latlng.lng);
  else if (mode === "move") moveHouse(e.latlng.lat, e.latlng.lng);
  else if (selId) closeSheet();
});

/* ============ ピン ============ */
const markers = new Map();
function pinIcon(h) {
  const cls = "pin" + (h.id === selId ? " sel" : "") + (h._pending ? " pending" : "");
  return L.divIcon({
    className: "pin-icon", iconSize: [0, 0], iconAnchor: [0, 0],
    html: `<div class="${cls}" style="--c:${stOf(effStatus(h)).c}"><i class="head"></i><span class="lbl">${esc(h.name || "（名前なし）")}</span></div>`,
  });
}
function renderPins() {
  const vis = new Set();
  visible().forEach(h => {
    vis.add(h.id);
    let m = markers.get(h.id);
    if (!m) {
      m = L.marker([h.lat, h.lng], { icon: pinIcon(h), keyboard: true, title: h.name || "名前なし" }).addTo(map);
      m.on("click", ev => { L.DomEvent.stopPropagation(ev); if (!mode) openSheet(m._hid); });
      markers.set(h.id, m);
    } else {
      m.setLatLng([h.lat, h.lng]);
      m.setIcon(pinIcon(h));
    }
    m._hid = h.id;
    m.setZIndexOffset(h.id === selId ? 1000 : 0);
  });
  for (const [id, m] of markers) if (!vis.has(id)) { map.removeLayer(m); markers.delete(id); }
}

/* ============ 集計・一覧 ============ */
const visible = () => shown().filter(h => filter.has(effStatus(h)));
function renderChips() {
  const cnt = {}; ST.forEach(s => cnt[s.k] = 0); shown().forEach(h => cnt[effStatus(h)]++);
  const box = $("chips"); box.innerHTML = "";
  ST.forEach(s => {
    const b = document.createElement("button");
    b.className = "chip"; b.style.setProperty("--c", s.c);
    b.setAttribute("aria-pressed", filter.has(s.k));
    b.innerHTML = `<span class="dot"></span>${s.label} <b>${cnt[s.k]}</b>`;
    b.onclick = () => { filter.has(s.k) ? filter.delete(s.k) : filter.add(s.k); if (!filter.size) ST.forEach(t => filter.add(t.k)); renderAll(); };
    box.appendChild(b);
  });
  // 俄留を貼る時間のお知らせ（今の年度を見ているときだけ）
  const n = cnt.received, nb = $("notice");
  nb.hidden = !n || isPast();
  if (n) {
    const night = canPost();
    nb.classList.toggle("go", night);
    nb.textContent = night ? `俄留を貼る時間です。お花受取済 ${n}件 →` : `お花受取済 ${n}件：俄留は${POST_FROM_HOUR}時から`;
  }
  const tot = shown().length || 1;
  $("progress").innerHTML = shown().length ? ST.map(s => `<i style="width:${cnt[s.k] / tot * 100}%;background:${s.c}"></i>`).join("") : "";
}
function renderList() {
  const L_ = $("list"); L_.innerHTML = "";
  const order = canPost() && !isPast()
    ? { received: 0, todo: 1, absent: 2, done: 3, refused: 4, ng: 5 }   // 夜9時以降は貼りに行く家を上に
    : { todo: 0, absent: 1, received: 2, done: 3, refused: 4, ng: 5 };
  const arr = visible().sort((a, b) => order[effStatus(a)] - order[effStatus(b)] || (a.name || "").localeCompare(b.name || "", "ja"));
  if (!arr.length) {
    L_.innerHTML = `<div class="none">${!loaded ? "読み込み中…" : shown().length ? "この条件の家はありません" : "まだ家が登録されていません。<br>地図で「＋ 家を追加」から登録してください。"}</div>`;
    return;
  }
  arr.forEach(h => {
    const s = stOf(effStatus(h)), r = rec(h), b = document.createElement("button");
    const sub = [h.memo, r && r.note].filter(Boolean).join("／");
    b.className = "row"; b.style.setProperty("--c", s.c);
    b.innerHTML = `<span class="dot"></span><span class="nm">${esc(h.name || "（名前なし）")}${sub ? `<small>${esc(sub)}</small>` : ""}</span><span class="st">${s.label}</span>`;
    b.onclick = () => { setView("map"); map.setView([h.lat, h.lng], Math.max(map.getZoom(), 18)); openSheet(h.id); };
    L_.appendChild(b);
  });
}
function renderYear() {
  const ys = new Set([curYear()]);
  houses.forEach(h => Object.keys(h.years || {}).forEach(y => ys.add(+y)));
  const sel = $("yearSel"), list = [...ys].filter(Boolean).sort((a, b) => b - a);
  sel.innerHTML = list.map(y => `<option value="${y}">${y}年</option>`).join("");
  sel.value = vy();
  $("pastBanner").hidden = !isPast();
  $("pastYear").textContent = vy();
  $("addBtn").hidden = isPast();
  $("adminBtn").classList.toggle("is-admin", isAdmin());
}
function renderAll() { renderYear(); renderChips(); renderPins(); renderList(); if (selId) fillSheet(); if (!$("admin").hidden) renderAdmin(); }
$("yearSel").onchange = () => { viewYear = +$("yearSel").value; if (viewYear === curYear()) viewYear = null; renderAll(); };
$("backToNow").onclick = () => { viewYear = null; renderAll(); };

/* ============ 編集シート ============ */
const fS = $("fStatus");
ST.forEach(s => {
  const b = document.createElement("button");
  b.dataset.k = s.k; b.textContent = s.label; b.style.setProperty("--c", s.c);
  b.onclick = () => {
    if (isPast()) return;
    // 夜9時前に「俄留を貼った」を押したら確認する
    if (s.k === "done" && !canPost() && effStatus(cur()) !== "done") { $("postWarn").hidden = false; return; }
    $("postWarn").hidden = true;
    setStatus(s.k);
  };
  fS.appendChild(b);
});
const cur = () => houses.find(h => h.id === selId);
const fmt = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
function openSheet(id) {
  if (selId && selId !== id) saveText();
  selId = id; $("sheet").hidden = false;
  $("hideConfirm").hidden = true; $("postWarn").hidden = true;
  fillSheet(true); renderPins();
}
function closeSheet() { saveText(); selId = null; $("sheet").hidden = true; setMode(null); renderPins(); }
function fillSheet(force) {
  const h = cur(); if (!h || h.hidden) { selId = null; $("sheet").hidden = true; return; }
  const r = rec(h), past = isPast();
  if (force || document.activeElement !== $("fName")) $("fName").value = h.name || "";
  if (force || document.activeElement !== $("fMemo")) $("fMemo").value = h.memo || "";
  if (force || document.activeElement !== $("fNote")) $("fNote").value = (r && r.note) || "";
  $("fNoteLabel").textContent = past ? `${vy()}年のメモ` : `今年（${vy()}年）のメモ`;
  $("fNote").disabled = past;
  const es = effStatus(h);
  fS.querySelectorAll("button").forEach(b => { b.setAttribute("aria-pressed", b.dataset.k === es); b.disabled = past; });
  $("fInherit").hidden = !inherited(h);
  if (inherited(h)) {
    const py = Object.keys(h.years || {}).map(Number).filter(v => v < vy() && h.years[v] && h.years[v].status).sort((a, b) => b - a)[0];
    $("fInherit").textContent = `${py}年に「${stOf(h.years[py].status).label}」だったので、「未訪問（不可）」になっています`;
  }
  // 過去の記録
  const ys = Object.keys(h.years || {}).map(Number).filter(y => h.years[y] && (h.years[y].status || h.years[y].note)).sort((a, b) => b - a);
  $("fHist").innerHTML = ys.length
    ? ys.map(y => { const x = h.years[y], s = stOf(x.status); return `<li${y === vy() ? ' class="now"' : ""}><b>${y}年</b><span class="hs" style="--c:${s.c}">${x.status ? s.label : "—"}</span>${x.note ? `<span class="hn">${esc(x.note)}</span>` : ""}</li>`; }).join("")
    : `<li class="empty">まだ記録はありません</li>`;
  $("fMeta").textContent = r && r.updatedAt ? `${vy()}年の最終更新 ${fmt(r.updatedAt)}${r.updatedBy ? "・" + r.updatedBy : ""}${h._pending ? "（未送信）" : ""}` : "";
  $("hideBtn").hidden = !(allowHide() || isAdmin());
}
function setStatus(k) {
  const h = cur(); if (!h || !store || isPast()) return;
  if (effStatus(h) === k && rec(h)) return;
  const y = curYear(), now = Date.now();
  h.years[y] = { ...(h.years[y] || {}), status: k, updatedAt: now, updatedBy: myName };
  renderAll();
  store.update(h.id, { [`years.${y}.status`]: k, [`years.${y}.updatedAt`]: now, [`years.${y}.updatedBy`]: myName, updatedAt: now, updatedBy: myName }).catch(() => {});
  toast(`${h.name || "この家"}を「${stOf(k).label}」にしました`);
}
function saveText() {
  const h = cur(); if (!h || !store) return;
  const name = $("fName").value.trim(), memo = $("fMemo").value.trim(), note = $("fNote").value.trim();
  const patch = {}, now = Date.now();
  if (name !== (h.name || "")) { patch.name = name; h.name = name; }
  if (memo !== (h.memo || "")) { patch.memo = memo; h.memo = memo; }
  if (!isPast()) {
    const y = curYear(), r = rec(h, y);
    if (note !== ((r && r.note) || "")) {
      patch[`years.${y}.note`] = note; patch[`years.${y}.updatedAt`] = now; patch[`years.${y}.updatedBy`] = myName;
      h.years[y] = { ...(r || {}), note, updatedAt: now, updatedBy: myName };
    }
  }
  if (!Object.keys(patch).length) return;
  patch.updatedAt = now; patch.updatedBy = myName;
  renderAll();
  store.update(h.id, patch).catch(() => {});
}
["fName", "fMemo", "fNote"].forEach(id => $(id).addEventListener("change", saveText));
$("closeBtn").onclick = closeSheet;
$("warnRcv").onclick = () => { $("postWarn").hidden = true; setStatus("received"); };
$("warnDone").onclick = () => { $("postWarn").hidden = true; setStatus("done"); };
$("notice").onclick = () => { filter = new Set(["received"]); setView("list"); renderAll(); };
setInterval(() => { renderChips(); renderList(); }, 60 * 1000); // 9時になったら表示を切り替える

// 「削除」は非表示にするだけ。記録は残り、管理者が元に戻せる
$("hideBtn").onclick = () => { $("hideBtn").hidden = true; $("hideConfirm").hidden = false; };
$("hideNo").onclick = () => { $("hideBtn").hidden = false; $("hideConfirm").hidden = true; };
$("hideYes").onclick = () => {
  const h = cur(); if (!h) return;
  const now = Date.now();
  selId = null; $("sheet").hidden = true;
  h.hidden = true; renderAll();
  store.update(h.id, { hidden: true, hiddenBy: myName, hiddenAt: now, updatedAt: now, updatedBy: myName })
    .then(() => toast("非表示にしました（管理者が元に戻せます）"))
    .catch(() => { h.hidden = false; renderAll(); });
};
$("moveBtn").onclick = () => setMode("move");

/* ============ 追加・移動 ============ */
function setMode(m) {
  mode = m;
  $("map").classList.toggle("adding", !!m);
  $("hint").hidden = !m;
  $("hint").querySelector("span").textContent = m === "move" ? "新しい位置をタップ" : "家の場所をタップ";
  $("addBtn").textContent = m === "add" ? "追加をやめる" : "＋ 家を追加";
  $("addBtn").classList.toggle("primary", m !== "add");
  $("addBtn").classList.toggle("on", m === "add");
}
$("addBtn").onclick = () => {
  if (view !== "map") setView("map");
  if (mode === "add") { setMode(null); return; }
  if (selId) closeSheet();
  setMode("add");
};
$("addHere").onclick = e => {
  e.stopPropagation();
  if (!navigator.geolocation) { toast("この端末では現在地を使えません"); return; }
  toast("現在地を取得中…");
  navigator.geolocation.getCurrentPosition(
    p => { const ll = [p.coords.latitude, p.coords.longitude]; mode === "move" ? moveHouse(...ll) : addHouse(...ll); map.setView(ll, Math.max(map.getZoom(), 18)); },
    () => toast("現在地を取得できませんでした（位置情報の許可を確認）"),
    { enableHighAccuracy: true, timeout: 10000 }
  );
};
function addHouse(lat, lng) {
  if (!store || isPast()) return;
  setMode(null);
  const now = Date.now();
  const data = { name: "", memo: "", lat, lng, hidden: false, years: {}, createdAt: now, createdBy: myName, updatedAt: now, updatedBy: myName };
  const id = store.add(data);
  if (!houses.find(h => h.id === id)) houses.push({ id, ...data, _pending: USE_FIREBASE });
  renderAll(); openSheet(id);
  setTimeout(() => $("fName").focus(), 60);
}
function moveHouse(lat, lng) {
  const h = cur(); setMode(null); if (!h) return;
  Object.assign(h, { lat, lng }); renderAll();
  store.update(h.id, { lat, lng, updatedAt: Date.now(), updatedBy: myName }).catch(() => {});
  toast("位置を直しました");
}

/* ============ 管理者 ============ */
function renderAdmin() {
  const u = store ? store.user() : { email: "", anon: true }, admin = isAdmin(), y = curYear();
  let who;
  if (!USE_FIREBASE) who = `<p>お試しモードでは、管理者の操作を誰でも試せます。</p>`;
  else if (admin) who = `<p>管理者としてログイン中：<b>${esc(u.email)}</b></p><button class="link" id="aLogout">ログアウト</button>`;
  else if (u.email) who = `<p class="err">${esc(u.email)} は管理者として登録されていません。</p><button class="link" id="aLogout">ログアウト</button>`;
  else who = `<p>年度の切り替えや、非表示にした家を元に戻す操作は管理者だけができます。</p><button class="btn on" id="aLogin">管理者としてログイン（Google）</button>`;
  $("adminWho").innerHTML = who;
  $("adminBody").hidden = !admin;
  if (admin) {
    $("aYear").textContent = `${y}年${teamCfg && teamCfg.year ? "" : "（自動で判定）"}`;
    $("aNext").textContent = `${y + 1}年を始める`;
    $("aPrev").textContent = `${y - 1}年に戻す`;
    $("aAllowHide").checked = allowHide();
    const hid = houses.filter(h => h.hidden);
    $("aHidden").innerHTML = hid.length
      ? hid.map(h => `<li><span><b>${esc(h.name || "（名前なし）")}</b><small>${esc(h.hiddenBy || "")}${h.hiddenAt ? "・" + fmt(h.hiddenAt) : ""}</small></span>`
        + (pendingDelete === h.id
          ? `<span class="del-ask"><small>過去の記録もすべて消え、元に戻せません</small><span class="del-btns"><button class="btn danger" data-delete-yes="${esc(h.id)}">完全に削除</button><button class="btn" data-delete-no="1">やめる</button></span></span>`
          : `<span class="hid-btns"><button class="btn" data-restore="${esc(h.id)}">元に戻す</button><button class="btn danger-ghost" data-delete="${esc(h.id)}">削除</button></span>`)
        + `</li>`).join("")
      : `<li class="empty">非表示の家はありません</li>`;
  }
  const lg = $("aLogin"); if (lg) lg.onclick = async () => {
    try { if (sharing) store.removeMember(); await store.signInAdmin(); toast("ログインしました"); }
    catch (e) { console.error(e); toast(e.code === "auth/popup-closed-by-user" ? "ログインをやめました" : "ログインできませんでした"); }
    renderAll();
  };
  const lo = $("aLogout"); if (lo) lo.onclick = async () => { try { if (sharing) store.removeMember(); await store.signOutAdmin(); } catch (e) { console.error(e); } renderAll(); };
}
$("adminBtn").onclick = () => { $("yearConfirm").hidden = true; $("admin").hidden = false; renderAdmin(); };
$("adminClose").onclick = () => { $("admin").hidden = true; };
let pendingYear = null;
function askYear(y, msg) { pendingYear = y; $("yearMsg").textContent = msg; $("yearConfirm").hidden = false; }
$("aNext").onclick = () => askYear(curYear() + 1, `${curYear() + 1}年を始めます。家のリストと家のメモはそのままで、すべての家が「未訪問（可）」から始まります（去年「未訪問（不可）」または「断られた」だった家は「未訪問（不可）」になります）。${curYear()}年の記録は消えずに残ります。`);
$("aPrev").onclick = () => askYear(curYear() - 1, `年度を${curYear() - 1}年に戻します。間違えて切り替えたときに使ってください。${curYear()}年に入力した記録は消えません。`);
$("yearNo").onclick = () => { $("yearConfirm").hidden = true; };
$("yearYes").onclick = async () => {
  const y = pendingYear; $("yearConfirm").hidden = true;
  try { await store.setTeam({ year: y, yearChangedAt: Date.now(), yearChangedBy: myName }); viewYear = null; toast(`${y}年に切り替えました`); }
  catch (e) { err(e); }
};
$("aAllowHide").onchange = async () => {
  try { await store.setTeam({ allowHide: $("aAllowHide").checked }); toast($("aAllowHide").checked ? "メンバーも家を非表示にできます" : "家の非表示は管理者だけになりました"); }
  catch (e) { err(e); $("aAllowHide").checked = allowHide(); }
};
let pendingDelete = null;
$("aHidden").onclick = e => {
  const ds = e.target.dataset || {};
  if (ds.delete) { pendingDelete = ds.delete; renderAdmin(); return; }
  if (ds.deleteNo) { pendingDelete = null; renderAdmin(); return; }
  if (ds.deleteYes) {
    const did = ds.deleteYes, h = houses.find(x => x.id === did); pendingDelete = null;
    houses = houses.filter(x => x.id !== did); renderAll();
    store.remove(did).then(() => toast(`${(h && h.name) || "家"}を完全に削除しました`)).catch(() => { if (h) houses.push(h); renderAll(); });
    return;
  }
  const id = ds.restore; if (!id) return;
  const h = houses.find(x => x.id === id); if (!h) return;
  h.hidden = false; renderAll();
  store.update(id, { hidden: false, updatedAt: Date.now(), updatedBy: myName }).then(() => toast("元に戻しました")).catch(() => { h.hidden = true; renderAll(); });
};

/* ============ 表示切替・共有 ============ */
function setView(v) {
  view = v;
  $("tabMap").setAttribute("aria-pressed", v === "map");
  $("tabList").setAttribute("aria-pressed", v === "list");
  $("list").hidden = v !== "list";
  $("locBtn").hidden = $("layerBtn").hidden = v !== "map";
  if (v === "list") setMode(null);
  else setTimeout(() => map.invalidateSize(), 0);
}
$("tabMap").onclick = () => setView("map");
$("tabList").onclick = () => setView("list");

const inviteUrl = () => `${location.origin}${location.pathname}?team=${encodeURIComponent(team)}`;
$("shareBtn").onclick = async () => {
  const url = inviteUrl();
  if (navigator.share) { try { await navigator.share({ title: "俄留マップ", text: "お花回りのチームに参加してください", url }); return; } catch (e) { if (e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(url); toast("招待リンクをコピーしました（LINEで送ってください）"); }
  catch { prompt("このリンクをチームに送ってください", url); }
};

const SYNC = { local: "お試しモード（この端末だけ）", ok: "共有中", pending: "未送信あり・電波待ち", offline: "オフライン", error: "接続エラー" };
function setSync(s) { const el = $("sync"); el.dataset.state = s; el.textContent = SYNC[s] || s; }
addEventListener("offline", () => setSync("offline"));

let tt;
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => t.hidden = true, 2400); }

/* ============ はじめの設定（名前・チーム） ============ */
function newCode() {
  const a = "abcdefghjkmnpqrstuvwxyz23456789", r = new Uint8Array(12);
  crypto.getRandomValues(r);
  return Array.from(r, x => a[x % a.length]).join("");
}
const validCode = c => /^[a-z0-9]{8,40}$/.test(c);
function startSetup() {
  const fromUrl = (new URLSearchParams(location.search).get("team") || "").trim().toLowerCase();
  const saved = ls.get("niwakadome:team") || "";
  const known = validCode(fromUrl) ? fromUrl : validCode(saved) ? saved : "";
  $("myName").value = myName;
  if (!USE_FIREBASE) {
    $("setupLead").textContent = "お試しモードです。データはこの端末のブラウザだけに保存されます（チーム共有は Firebase の設定後に使えます）。";
  }
  if (known || !USE_FIREBASE) {
    $("teamBox").hidden = true; $("nameOnlyBtn").hidden = false;
    if (myName) return begin(known || "demo");
    $("nameOnlyBtn").onclick = () => saveName() && begin(known || "demo");
  } else {
    $("joinBtn").onclick = () => {
      const c = $("teamCode").value.trim().toLowerCase().replace(/^.*team=/, "");
      if (!validCode(c)) return showErr("合言葉は英小文字と数字（8文字以上）です。リンクをもらった人はリンクから開いてください。");
      saveName() && begin(c);
    };
    $("newTeamBtn").onclick = () => saveName() && begin(newCode(), true);
  }
  $("setup").hidden = false;
  setTimeout(() => $("myName").focus(), 50);
}
function showErr(m) { $("setupErr").textContent = m; $("setupErr").hidden = false; return false; }
function saveName() {
  const n = $("myName").value.trim();
  if (!n) return showErr("名前を入れてください（誰が更新したか表示されます）");
  myName = n; ls.set("niwakadome:name", n); return true;
}
async function begin(code, isNew) {
  team = code; ls.set("niwakadome:team", code);
  if (USE_FIREBASE && new URLSearchParams(location.search).get("team") !== code) { try { history.replaceState(null, "", "?team=" + code); } catch {} }
  $("setup").hidden = true;
  $("teamLabel").textContent = USE_FIREBASE ? "" : "お試しモード";
  $("shareBtn").hidden = !USE_FIREBASE;
  try {
    store = USE_FIREBASE ? await createFirebaseStore(code, setSync) : createLocalStore(code, setSync);
  } catch (e) {
    console.error(e); setSync("error");
    toast("接続できませんでした。設定（firebase-config.js）を確認してください"); return;
  }
  store.onAuth(() => renderAll());
  store.subscribeTeam(t => { const before = curYear(); teamCfg = t; if (curYear() !== before) viewYear = null; renderAll(); });
  store.subscribe(list => { houses = list.filter(h => typeof h.lat === "number").map(normalize); loaded = true; renderAll(); },
    e => toast(e.code === "permission-denied" ? "読み込む権限がありません" : "データを読み込めませんでした"));
  store.subscribeMembers(list => { members = list; renderMembers(); });
  if (ls.get("niwakadome:sharing") === "1") setSharing(true);
  if (isNew) setTimeout(() => toast("チームを作りました。右上の「招待」からリンクを送れます"), 400);
}

renderAll();
startSetup();
})();
