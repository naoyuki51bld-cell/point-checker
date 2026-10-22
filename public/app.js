import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  updatePassword, EmailAuthProvider, reauthenticateWithCredential, setPersistence, inMemoryPersistence,
  connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, onSnapshot, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { firebaseConfig, appConfig } from './firebase-config.js';
import { indexWorkbook, evalGroup, computeStats, validScore, isNum, describe, rankOf, deviation } from './stats.js';

// ---------------------------------------------------------------- Firebase
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const useEmu = appConfig.useEmulatorsOnLocalhost && ['localhost', '127.0.0.1'].includes(location.hostname);
if (useEmu) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
let fns = null;
if (appConfig.functionsEnabled) {
  fns = getFunctions(fbApp, appConfig.functionsRegion);
  if (useEmu) connectFunctionsEmulator(fns, '127.0.0.1', 5001);
}

// 教師が生徒アカウントを作るとき、自分のログイン状態を保ったまま作成するための 2 つ目のアプリ
let secondary = null;
async function secondaryAuth() {
  if (!secondary) {
    const app2 = initializeApp(firebaseConfig, 'secondary');
    const a2 = getAuth(app2);
    await setPersistence(a2, inMemoryPersistence);
    if (useEmu) connectAuthEmulator(a2, 'http://127.0.0.1:9099', { disableWarnings: true });
    secondary = a2;
  }
  return secondary;
}

// ---------------------------------------------------------------- helpers
const S = { ready: false, user: null, profile: null, registering: false, cleanups: [] };
const $main = document.getElementById('app');
document.title = appConfig.appName;
document.getElementById('brand').textContent = appConfig.appName;

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'readOnly'].includes(k)) el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const mount = (...nodes) => { $main.replaceChildren(...nodes); window.scrollTo(0, 0); };
const fmt = (x) => (isNum(x) ? (Number.isInteger(x) ? String(x) : (Math.round(x * 10) / 10).toFixed(1)) : '—');
const f1 = (x) => (isNum(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—');
const pct = (x) => (isNum(x) ? f1(x * 100) + '%' : '—');
const today = () => new Date().toLocaleDateString('sv-SE');
const emailOf = (username) => `${username.toLowerCase()}@${appConfig.usernameDomain}`;
const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const rid = (p) => p + Math.random().toString(36).slice(2, 9);
const heat = (rate) => (!isNum(rate) ? '' : rate < 0.5 ? 'heat-lo' : rate < 0.7 ? 'heat-mid' : 'heat-hi');
const byClassNumber = (a, b) => (a.className || '').localeCompare(b.className || '', 'ja', { numeric: true })
  || (a.number ?? 9999) - (b.number ?? 9999) || a.displayName.localeCompare(b.displayName, 'ja');

function genPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

function errMsg(e) {
  const c = (e && e.code) || '';
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email', 'auth/invalid-login-credentials'].includes(c)) return 'ユーザー名またはパスワードが違います。';
  if (c === 'auth/email-already-in-use') return 'このユーザー名はすでに使われています。別のユーザー名にしてください。';
  if (c === 'auth/weak-password') return 'パスワードは6文字以上にしてください。';
  if (c === 'auth/too-many-requests') return '試行回数が多すぎます。少し時間をおいてからお試しください。';
  if (c === 'auth/requires-recent-login') return 'もう一度ログインしてからお試しください。';
  if (c === 'auth/network-request-failed' || c === 'unavailable') return '通信できませんでした。ネットワークを確認してください。';
  if (c === 'permission-denied' || c === 'functions/permission-denied') return 'この操作をする権限がありません。';
  return `処理できませんでした（${c || (e && e.message) || '不明なエラー'}）。`;
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// 2 回押すと実行されるボタン（誤操作防止）
function confirmButton(label, armedLabel, onConfirm, cls = 'btn small danger') {
  let armed = false, timer = null;
  const b = h('button', { class: cls, type: 'button' }, label);
  b.addEventListener('click', async () => {
    if (!armed) {
      armed = true; b.textContent = armedLabel; b.classList.add('armed');
      timer = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('armed'); }, 4000);
      return;
    }
    clearTimeout(timer); armed = false; b.textContent = label; b.classList.remove('armed');
    b.disabled = true;
    try { await onConfirm(); } finally { b.disabled = false; }
  });
  return b;
}

function downloadText(filename, text, type = 'text/csv') {
  const blob = new Blob(['﻿' + text], { type: type + ';charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

const isTeacher = () => S.profile && S.profile.role === 'teacher';

// ---------------------------------------------------------------- nav & router
function renderNav() {
  const bar = document.getElementById('topbar');
  const nav = document.getElementById('nav');
  if (!S.user || !S.profile) { bar.hidden = true; return; }
  bar.hidden = false;
  const cur = location.hash || '#/';
  const link = (href, text) => h('a', { href, class: (href === '#/' ? cur === '#/' || cur === '' : cur.startsWith(href)) ? 'active' : '' }, text);
  nav.replaceChildren(...[
    link('#/', '得点表'),
    isTeacher() ? link('#/t/users', '生徒・アカウント') : null,
    link('#/account', 'パスワード変更'),
    h('span', { class: 'who' }, `${S.profile.displayName}（${isTeacher() ? '教師' : '生徒'}）`),
    h('button', { type: 'button', onclick: () => signOut(auth) }, 'ログアウト'),
  ].filter(Boolean));
}

async function route() {
  S.cleanups.splice(0).forEach((f) => { try { f(); } catch (e) { /* noop */ } });
  if (!S.ready || S.registering) return;
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
  if (!S.user) { renderNav(); return parts[0] === 'register' ? viewRegister() : viewLogin(); }
  if (!S.profile) { renderNav(); return viewNoProfile(); }
  renderNav();
  if (S.profile.mustChangePassword) return viewPassword(true);
  try {
    if (parts[0] === 'account') return viewPassword(false);
    if (isTeacher()) {
      if (parts[0] === 't' && parts[1] === 'users') return await viewUsers();
      if (parts[0] === 't' && parts[1] === 'wb' && parts[3] === 'edit') return await viewEditor(parts[2]);
      if (parts[0] === 't' && parts[1] === 'wb' && parts[3] === 'results') return await viewResults(parts[2]);
      if (parts[0] === 't' && parts[1] === 'wb' && parts[3] === 'u') return await viewSheet(parts[2], parts[4], true);
      return await viewTeacherHome();
    }
    if (parts[0] === 'wb' && parts[1]) return await viewSheet(parts[1], S.user.uid, false);
    return await viewStudentHome();
  } catch (e) {
    console.error(e);
    mount(h('div', { class: 'card' }, h('h2', null, '表示できませんでした'), h('p', { class: 'err' }, errMsg(e)), h('p', null, h('a', { href: '#/' }, 'トップに戻る'))));
  }
}
window.addEventListener('hashchange', route);

onAuthStateChanged(auth, async (user) => {
  S.user = user;
  S.profile = null;
  if (user && !S.registering) {
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      S.profile = snap.exists() ? snap.data() : null;
    } catch (e) { S.profile = null; }
  }
  S.ready = true;
  route();
});

// ---------------------------------------------------------------- auth views
function viewLogin() {
  const msg = h('p', { class: 'err', hidden: true });
  const form = h('form', null,
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'li-user' }, 'ユーザー名'),
      h('input', { type: 'text', id: 'li-user', autocomplete: 'username', autocapitalize: 'none', required: true })),
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'li-pass' }, 'パスワード'),
      h('input', { type: 'password', id: 'li-pass', autocomplete: 'current-password', required: true })),
    msg,
    h('button', { class: 'btn primary', type: 'submit' }, 'ログイン'),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.hidden = true;
    const u = form.querySelector('#li-user').value.trim().toLowerCase();
    const p = form.querySelector('#li-pass').value;
    if (!USERNAME_RE.test(u)) { msg.textContent = 'ユーザー名またはパスワードが違います。'; msg.hidden = false; return; }
    form.querySelector('button').disabled = true;
    try { await signInWithEmailAndPassword(auth, emailOf(u), p); location.hash = '#/'; }
    catch (e) { msg.textContent = errMsg(e); msg.hidden = false; }
    finally { form.querySelector('button').disabled = false; }
  });
  mount(h('div', { class: 'auth card' },
    h('h1', null, appConfig.appName),
    h('p', { class: 'muted small' }, '問題演習の得点を記録して、得点率・平均点・順位を確認できます。'),
    form,
    h('p', { class: 'small' }, 'アカウントをお持ちでない方は ', h('a', { href: '#/register' }, '登録コードで新規登録'), '（登録コードは先生に確認してください）'),
  ));
}

function viewRegister() {
  const msg = h('p', { class: 'err', hidden: true });
  const f = (id, label, input, hint) => h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input, hint ? h('span', { class: 'small muted' }, hint) : null);
  const form = h('form', null,
    f('rg-code', '登録コード', h('input', { type: 'text', id: 'rg-code', required: true, autocomplete: 'off' })),
    f('rg-name', '名前', h('input', { type: 'text', id: 'rg-name', required: true, maxlength: 40, placeholder: '例: 山田 太郎' })),
    h('div', { class: 'row' },
      f('rg-class', '組', h('input', { type: 'text', id: 'rg-class', maxlength: 20, placeholder: '例: 3-1', style: 'width:7em' })),
      f('rg-num', '番号', h('input', { type: 'number', id: 'rg-num', min: 1, max: 999, style: 'width:6em' }))),
    f('rg-user', 'ユーザー名', h('input', { type: 'text', id: 'rg-user', required: true, autocapitalize: 'none', autocomplete: 'username' }), '半角英数字と . _ - で3〜30文字'),
    f('rg-pass', 'パスワード', h('input', { type: 'password', id: 'rg-pass', required: true, minlength: 6, autocomplete: 'new-password' }), '6文字以上'),
    f('rg-pass2', 'パスワード（確認）', h('input', { type: 'password', id: 'rg-pass2', required: true, autocomplete: 'new-password' })),
    h('label', { class: 'row small' }, h('input', { type: 'checkbox', id: 'rg-teacher' }), '教師として登録する（教師用の登録コードが必要）'),
    msg,
    h('button', { class: 'btn primary', type: 'submit' }, '登録する'),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = (id) => form.querySelector('#' + id).value.trim();
    const show = (t) => { msg.textContent = t; msg.hidden = false; };
    msg.hidden = true;
    const username = v('rg-user').toLowerCase();
    if (!USERNAME_RE.test(username)) return show('ユーザー名は半角英数字と . _ - で3〜30文字にしてください。');
    if (form.querySelector('#rg-pass').value !== form.querySelector('#rg-pass2').value) return show('確認用のパスワードが一致しません。');
    const num = v('rg-num') ? parseInt(v('rg-num'), 10) : null;
    const profile = {
      username, displayName: v('rg-name'), role: form.querySelector('#rg-teacher').checked ? 'teacher' : 'student',
      className: v('rg-class'), number: Number.isInteger(num) ? num : null, mustChangePassword: false,
      createdAt: Date.now(), joinCode: v('rg-code'),
    };
    form.querySelector('button[type=submit]').disabled = true;
    S.registering = true;
    let cred = null;
    try {
      cred = await createUserWithEmailAndPassword(auth, emailOf(username), form.querySelector('#rg-pass').value);
      try {
        await setDoc(doc(db, 'users', cred.user.uid), profile);
      } catch (e) {
        await cred.user.delete().catch(() => {});
        throw Object.assign(new Error('code'), { code: e.code === 'permission-denied' ? 'bad-code' : e.code });
      }
      S.profile = profile;
      S.registering = false;
      location.hash = '#/';
      route();
    } catch (e) {
      S.registering = false;
      show(e.code === 'bad-code' ? '登録コードが違います。先生に確認してください。' : errMsg(e));
    } finally {
      form.querySelector('button[type=submit]').disabled = false;
    }
  });
  mount(h('div', { class: 'auth card' }, h('h1', null, '新規登録'), form, h('p', { class: 'small' }, h('a', { href: '#/' }, 'ログイン画面に戻る'))));
}

function viewNoProfile() {
  mount(h('div', { class: 'auth card' },
    h('h2', null, 'アカウント情報が見つかりません'),
    h('p', null, 'このアカウントは削除されたか、登録が完了していません。先生に確認してください。'),
    h('button', { class: 'btn', onclick: () => signOut(auth) }, 'ログアウト')));
}

function viewPassword(forced) {
  const msg = h('p', { class: 'err', hidden: true });
  const form = h('form', { class: 'stack' },
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'pw-cur' }, forced ? '先生から受け取ったパスワード' : '今のパスワード'), h('input', { type: 'password', id: 'pw-cur', required: true, autocomplete: 'current-password' })),
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'pw-new' }, '新しいパスワード（6文字以上）'), h('input', { type: 'password', id: 'pw-new', required: true, minlength: 6, autocomplete: 'new-password' })),
    h('div', { class: 'field' }, h('label', { class: 'label', for: 'pw-new2' }, '新しいパスワード（確認）'), h('input', { type: 'password', id: 'pw-new2', required: true, autocomplete: 'new-password' })),
    msg,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'パスワードを変更'),
      forced ? h('button', { class: 'btn', type: 'button', onclick: () => signOut(auth) }, 'ログアウト') : null),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.hidden = true;
    const cur = form.querySelector('#pw-cur').value, nw = form.querySelector('#pw-new').value;
    if (nw !== form.querySelector('#pw-new2').value) { msg.textContent = '確認用のパスワードが一致しません。'; msg.hidden = false; return; }
    if (nw === cur) { msg.textContent = '今と違うパスワードにしてください。'; msg.hidden = false; return; }
    try {
      await reauthenticateWithCredential(S.user, EmailAuthProvider.credential(S.user.email, cur));
      await updatePassword(S.user, nw);
      if (S.profile.mustChangePassword) {
        await updateDoc(doc(db, 'users', S.user.uid), { mustChangePassword: false });
        S.profile.mustChangePassword = false;
      }
      toast('パスワードを変更しました');
      location.hash = '#/';
      route();
    } catch (e) { msg.textContent = errMsg(e); msg.hidden = false; }
  });
  mount(h('div', { class: 'auth card' },
    h('h1', null, forced ? '最初にパスワードを変更してください' : 'パスワード変更'),
    forced ? h('p', { class: 'small muted' }, '先生から受け取った仮のパスワードを、自分だけが知っているパスワードに変えます。') : null,
    h('p', { class: 'small muted' }, `ユーザー名: ${S.profile.username}`),
    form));
}

// ---------------------------------------------------------------- student home
async function viewStudentHome() {
  const [wbSnap, scSnap] = await Promise.all([
    getDocs(query(collection(db, 'workbooks'), where('published', '==', true))),
    getDocs(query(collection(db, 'scores'), where('uid', '==', S.user.uid))),
  ]);
  const mine = Object.fromEntries(scSnap.docs.map((d) => [d.data().wbId, d.data()]));
  const wbs = wbSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.title.localeCompare(b.title, 'ja'));

  const recent = [];
  const cards = wbs.map((wb) => {
    const idx = indexWorkbook(wb);
    const rec = mine[wb.id] || {};
    const scores = rec.scores || {};
    let done = 0;
    for (const [rId, items] of idx.rounds) {
      const g = evalGroup(items, scores);
      if (g.complete) done++;
      if (g.count > 0) recent.push({ wb, rId, g, date: (rec.dates || {})[rId] || '', label: items[0] ? items[0].roundLabel : '' });
    }
    const all = evalGroup(idx.all, scores);
    const total = idx.rounds.size;
    return h('a', { class: 'card wb-card', href: `#/wb/${wb.id}` },
      h('div', { class: 'row' }, h('h2', null, wb.title), h('span', { class: 'spacer' }), all.count ? h('span', { class: 'pill accent' }, `得点率 ${pct(all.rate)}`) : h('span', { class: 'pill muted' }, '未記入')),
      wb.description ? h('p', { class: 'small muted' }, wb.description) : null,
      h('div', { class: 'progress', 'aria-hidden': 'true' }, h('div', { style: `width:${total ? (done / total) * 100 : 0}%` })),
      h('p', { class: 'small muted' }, `${done} / ${total} 回 記入済み`),
    );
  });

  recent.sort((a, b) => b.date.localeCompare(a.date));
  const recentTable = recent.length ? h('div', { class: 'tscroll' }, h('table', null,
    h('thead', null, h('tr', null, h('th', null, '記入日'), h('th', null, '得点表'), h('th', null, '回'), h('th', { class: 'r' }, '得点'), h('th', { class: 'r' }, '得点率'))),
    h('tbody', null, recent.slice(0, 10).map((r) => h('tr', null,
      h('td', { class: 'num' }, r.date || '—'),
      h('td', null, h('a', { href: `#/wb/${r.wb.id}` }, r.wb.title)),
      h('td', null, r.label, r.g.complete ? '' : h('span', { class: 'muted small' }, '（途中）')),
      h('td', { class: 'r num' }, `${fmt(r.g.sum)} / ${fmt(r.g.complete ? r.g.max : r.g.enteredMax)}`),
      h('td', { class: `r num ${heat(r.g.rate)}` }, pct(r.g.rate))))))) : null;

  mount(
    h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, `${S.profile.className ? S.profile.className + '組 ' : ''}${S.profile.number ? S.profile.number + '番 ' : ''}${S.profile.displayName}`), h('h1', null, '自分の得点表'))),
    wbs.length ? h('div', { class: 'wb-list' }, cards)
      : h('div', { class: 'card' }, h('h2', null, 'まだ得点表がありません'), h('p', { class: 'muted' }, '先生が得点表を公開すると、ここに表示されます。')),
    recentTable ? h('section', { class: 'stack' }, h('h2', null, '最近の記録'), recentTable) : null,
  );
}

// ---------------------------------------------------------------- 得点表（生徒の記入画面・教師の閲覧画面）
async function viewSheet(wbId, uid, teacherMode) {
  const wbSnap = await getDoc(doc(db, 'workbooks', wbId));
  if (!wbSnap.exists()) throw Object.assign(new Error(), { code: 'not-found' });
  const wb = { id: wbId, ...wbSnap.data() };
  const idx = indexWorkbook(wb);
  const scoreRef = doc(db, 'scores', `${wbId}_${uid}`);
  const noteRef = doc(db, 'notes', `${wbId}_${uid}`);
  const [sSnap, nSnap, pSnap] = await Promise.all([
    getDoc(scoreRef), getDoc(noteRef), teacherMode ? getDoc(doc(db, 'users', uid)) : Promise.resolve(null),
  ]);
  const student = teacherMode ? (pSnap.exists() ? pSnap.data() : { displayName: '（削除されたユーザー）' }) : S.profile;
  const sd = sSnap.exists() ? sSnap.data() : {};
  const nd = nSnap.exists() ? nSnap.data() : {};
  const st = {
    scores: { ...(sd.scores || {}) },
    dates: { ...(sd.dates || {}) },
    goal: isNum(nd.goal) ? nd.goal : null,
    entries: JSON.parse(JSON.stringify(nd.entries || {})),
    others: {},
  };
  const editable = !teacherMode;
  const refs = { items: {}, rounds: {}, sets: {} };

  // ---- 保存（入力が止まって少ししたら自動保存）
  const saveEl = h('span', { class: 'save-state muted' }, editable ? '自動で保存されます' : '閲覧のみ');
  const setSave = (state, text) => {
    saveEl.className = 'save-state ' + (state === 'error' ? 'err' : state === 'saved' ? 'ok' : 'muted');
    saveEl.textContent = text;
  };
  let scoreTimer = null, noteTimer = null;
  const dirtyRounds = new Set();
  async function saveScores() {
    clearTimeout(scoreTimer); scoreTimer = null;
    for (const r of dirtyRounds) {
      if (evalGroup(idx.rounds.get(r) || [], st.scores).count) st.dates[r] = today(); else delete st.dates[r];
    }
    dirtyRounds.clear();
    setSave('saving', '保存中…');
    try {
      await setDoc(scoreRef, { wbId, uid, scores: st.scores, dates: st.dates, updatedAt: Date.now() });
      setSave('saved', '保存しました');
      updateDates();
    } catch (e) { setSave('error', '保存できませんでした: ' + errMsg(e)); }
  }
  async function saveNotes() {
    clearTimeout(noteTimer); noteTimer = null;
    setSave('saving', '保存中…');
    try {
      await setDoc(noteRef, { wbId, uid, goal: st.goal, entries: st.entries, updatedAt: Date.now() });
      setSave('saved', '保存しました');
    } catch (e) { setSave('error', '保存できませんでした: ' + errMsg(e)); }
  }
  const queueScores = (roundId) => { dirtyRounds.add(roundId); setSave('dirty', '入力中…'); clearTimeout(scoreTimer); scoreTimer = setTimeout(saveScores, 700); };
  const queueNotes = () => { setSave('dirty', '入力中…'); clearTimeout(noteTimer); noteTimer = setTimeout(saveNotes, 900); };
  const onBeforeUnload = (e) => { if (scoreTimer || noteTimer) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  S.cleanups.push(() => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (scoreTimer) saveScores();
    if (noteTimer) saveNotes();
  });

  // ---- 入力欄
  function scoreInput(item, roundId) {
    const v = validScore(item, st.scores);
    if (!editable) return h('span', { class: 'val' }, v === null ? '—' : fmt(v));
    const inp = h('input', {
      type: 'text', inputmode: 'decimal', value: v === null ? '' : String(v), 'aria-label': `${item.label} ${item.fieldName || ''} 得点（満点${item.max}）`,
    });
    inp.addEventListener('input', () => {
      const raw = inp.value.trim().replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
      if (raw === '') { delete st.scores[item.id]; inp.classList.remove('invalid'); }
      else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > item.max) { inp.classList.add('invalid'); inp.title = `0〜${item.max}で入力してください`; return; }
        inp.classList.remove('invalid'); inp.title = '';
        st.scores[item.id] = n;
      }
      recompute();
      queueScores(roundId);
    });
    return inp;
  }
  const fieldName = Object.fromEntries((wb.fields || []).map((f) => [f.id, f.name]));

  function renderSet(set, si) {
    const rounds = (set.rounds || []).map((round) => {
      const items = (round.items || []).map((item) => {
        const avgEl = h('div', { class: 'item-avg' });
        refs.items[item.id] = { avgEl };
        return h('div', { class: 'item' },
          h('div', { class: 'item-head' }, item.label ? h('span', { class: 'qno' }, item.label) : null, h('span', null, fieldName[item.fieldId] || '')),
          h('div', { class: 'item-body' }, scoreInput({ ...item, fieldName: fieldName[item.fieldId] }, round.id), h('span', { class: 'max' }, `/${fmt(item.max)}`)),
          avgEl);
      });
      const subV = h('span', { class: 'v' });
      const dateEl = h('span', { class: 'date' });
      refs.rounds[round.id] = { subV, dateEl };
      return h('div', { class: 'round' },
        h('div', { class: 'round-label' }, h('span', null, round.label), dateEl),
        h('div', { class: 'items' }, items),
        h('div', { class: 'subtotal' }, h('span', { class: 'k' }, '小計'), subV, h('span', { class: 'm' }, `/${fmt(evalGroup(idx.rounds.get(round.id), {}).max)}`)));
    });

    const entry = st.entries[set.id] || {};
    let targetEl;
    if (editable) {
      targetEl = h('input', { type: 'text', inputmode: 'numeric', value: isNum(entry.target) ? String(entry.target) : '', 'aria-label': `${set.label} 目標点` });
      targetEl.addEventListener('input', () => {
        const n = Number(targetEl.value.trim());
        const e = (st.entries[set.id] = st.entries[set.id] || {});
        if (targetEl.value.trim() === '') delete e.target;
        else if (Number.isFinite(n) && n >= 0) e.target = n;
        else return;
        recompute(); queueNotes();
      });
    } else targetEl = h('span', { class: 'num' }, isNum(entry.target) ? fmt(entry.target) : '—');

    let memoEl;
    if (editable) {
      memoEl = h('textarea', { rows: 2, maxlength: 500, placeholder: '振り返り・メモ', 'aria-label': `${set.label} 振り返り・メモ` });
      memoEl.value = entry.memo || '';
      memoEl.addEventListener('input', () => { (st.entries[set.id] = st.entries[set.id] || {}).memo = memoEl.value; queueNotes(); });
    } else memoEl = h('div', { class: 'memo-text' }, entry.memo || h('span', { class: 'muted' }, '（メモなし）'));

    const totV = h('div', { class: 'v' });
    const cmpEl = h('div', { class: 'set-cmp' });
    const badgeEl = h('div');
    refs.sets[set.id] = { totV, cmpEl, badgeEl };
    const m = set.label.match(/^(\D*)(\d+)$/);
    return h('section', { class: 'set' },
      h('div', { class: 'set-badge' }, h('span', { class: 's1' }, m ? m[1] : ''), h('span', { class: 's2' }, m ? m[2] : set.label)),
      h('div', { class: 'set-rounds' }, rounds),
      h('div', { class: 'set-side' },
        h('label', { class: 'target' }, h('span', { class: 'label' }, '目標'), h('span', { class: 'row', style: 'gap:4px' }, targetEl, '点')),
        h('div', { class: 'set-total' }, h('span', { class: 'label' }, '合計'), totV, badgeEl),
        cmpEl,
        h('div', { class: 'memo field' }, h('span', { class: 'label' }, '振り返り・メモ'), memoEl)));
  }

  // ---- 上部のまとめ
  let goalEl;
  if (editable) {
    goalEl = h('input', { type: 'text', inputmode: 'numeric', value: isNum(st.goal) ? String(st.goal) : '', 'aria-label': '最終目標' });
    goalEl.addEventListener('input', () => {
      const raw = goalEl.value.trim(); const n = Number(raw);
      if (raw === '') st.goal = null; else if (Number.isFinite(n) && n >= 0) st.goal = n; else return;
      queueNotes();
    });
  } else goalEl = h('span', { class: 'v' }, isNum(st.goal) ? fmt(st.goal) : '—');
  const T = {};
  const tile = (key, label) => { T[key] = h('span', { class: 'v' }); return h('div', { class: 'tile' }, h('span', { class: 'label' }, label), T[key]); };
  const tiles = h('div', { class: 'tiles' },
    h('div', { class: 'tile' }, h('span', { class: 'label' }, '最終目標'), h('span', { class: 'goal-input' }, goalEl, h('span', { class: 'muted small' }, '点'))),
    tile('progress', '記入済み'), tile('rate', '得点率（記入済みの問題）'), tile('avg', 'クラス平均の得点率'), tile('rank', '順位（得点率）'), tile('dev', '偏差値'));

  const fieldsBox = h('div', { class: 'fields' });
  const sheetBox = h('div', { class: 'sheet' }, (wb.sets || []).map(renderSet));
  const tabSheet = h('button', { class: 'tab', role: 'tab', 'aria-selected': 'true', type: 'button' }, '得点表');
  const tabFields = h('button', { class: 'tab', role: 'tab', 'aria-selected': 'false', type: 'button' }, '分野別チェック');
  const fieldsWrap = h('div', { class: 'stack', hidden: true },
    h('div', { class: 'legend' }, h('span', null, h('i'), '得点率（記入済みの問題）'), h('span', null, h('i', { class: 'tick' }), 'クラス平均')),
    fieldsBox);
  const showTab = (which) => {
    tabSheet.setAttribute('aria-selected', String(which === 'sheet'));
    tabFields.setAttribute('aria-selected', String(which === 'fields'));
    sheetBox.hidden = which !== 'sheet';
    fieldsWrap.hidden = which !== 'fields';
  };
  tabSheet.onclick = () => showTab('sheet');
  tabFields.onclick = () => showTab('fields');

  function updateDates() {
    for (const [rId, r] of Object.entries(refs.rounds)) r.dateEl.textContent = st.dates[rId] ? st.dates[rId].slice(5).replace('-', '/') : '';
  }

  function recompute() {
    const all = { ...st.others };
    if (Object.keys(st.scores).length) all[uid] = st.scores;
    const stats = computeStats(wb, all, uid);

    for (const it of idx.all) {
      const d = stats.items[it.id];
      refs.items[it.id].avgEl.textContent = d.n ? `平均 ${f1(d.avg)}` : '';
    }
    for (const [rId, items] of idx.rounds) {
      const g = evalGroup(items, st.scores);
      const r = refs.rounds[rId];
      r.subV.textContent = g.count ? fmt(g.sum) : '';
      r.subV.className = 'v' + (g.count && !g.complete ? ' partial' : '');
    }
    for (const set of wb.sets || []) {
      const g = evalGroup(idx.sets.get(set.id), st.scores);
      const r = refs.sets[set.id];
      r.totV.replaceChildren(g.count ? fmt(g.sum) : '', h('small', null, ` /${fmt(g.max)}`));
      const target = (st.entries[set.id] || {}).target;
      r.badgeEl.replaceChildren(
        !g.count ? h('span', { class: 'small muted' }, '未記入')
          : !g.complete ? h('span', { class: 'small muted' }, '記入途中')
            : isNum(target) ? (g.sum >= target ? h('span', { class: 'pill good' }, '目標達成') : h('span', { class: 'pill warn' }, `目標まであと${fmt(target - g.sum)}点`)) : null);
      const lines = [];
      const sStat = stats.sets[set.id];
      if (sStat.n) lines.push(h('div', null, `平均 ${f1(sStat.avg)}点（${sStat.n}人）`, sStat.rank ? ` ・ ${sStat.rank}位` : ''));
      for (const round of set.rounds || []) {
        const rs = stats.rounds[round.id];
        if (rs.n) lines.push(h('div', null, `${round.label}: 平均 ${f1(rs.avg)}`, rs.rank ? ` ・ ${rs.rank}位/${rs.n}人` : ` （${rs.n}人）`));
      }
      r.cmpEl.replaceChildren(...lines);
    }

    let done = 0;
    for (const items of idx.rounds.values()) if (evalGroup(items, st.scores).complete) done++;
    const me = evalGroup(idx.all, st.scores);
    const o = stats.overall;
    T.progress.replaceChildren(String(done), h('small', null, `/ ${idx.rounds.size}回`));
    T.rate.replaceChildren(pct(me.rate), me.count ? h('small', null, `${fmt(me.sum)}/${fmt(me.enteredMax)}`) : '');
    T.avg.replaceChildren(o.n ? pct(o.avg) : '—', o.n ? h('small', null, `${o.n}人`) : '');
    T.rank.replaceChildren(o.rank ? String(o.rank) : '—', o.rank ? h('small', null, `位 / ${o.n}人`) : '');
    T.dev.textContent = me.count && o.n > 1 ? f1(deviation(me.rate, o)) : '—';

    renderFields(stats);
  }

  function renderFields(stats) {
    if (!(wb.fields || []).length) { fieldsBox.replaceChildren(h('p', { class: 'muted' }, 'この得点表には分野が設定されていません。')); return; }
    fieldsBox.replaceChildren(...wb.fields.map((f) => {
      const items = idx.fields.get(f.id) || [];
      const g = evalGroup(items, st.scores);
      const fs = stats.fields[f.id];
      const chips = items.map((it) => {
        const v = validScore(it, st.scores);
        return h('div', { class: 'chip' + (v === null ? ' empty' : '') },
          h('div', { class: 'ch' }, it.roundLabel, it.label ? ` ${it.label}` : ''),
          h('div', { class: 'cv' }, v === null ? '' : fmt(v), h('span', { class: 'm' }, `/${fmt(it.max)}`)));
      });
      return h('div', { class: 'frow' },
        h('div', { class: 'fname' }, h('b', null, f.name), h('span', { class: 'small muted' }, `満点 ${fmt(g.max)}`)),
        h('div', { class: 'chips' }, chips.length ? chips : h('span', { class: 'muted small' }, 'この分野の問題はありません')),
        h('div', { class: 'fres' },
          h('div', { class: 'big' }, h('span', { class: 'num' }, `${fmt(g.sum)} /${fmt(g.max)}`), h('span', { class: `v ${heat(g.rate)}` }, pct(g.rate))),
          h('div', { class: 'bar', 'aria-hidden': 'true' },
            g.count ? h('div', { class: 'fill', style: `width:${Math.min(100, g.rate * 100)}%` }) : null,
            fs.n ? h('div', { class: 'avg', style: `left:calc(${Math.min(100, fs.avg * 100)}% - 1px)` }) : null),
          h('div', { class: 'small muted' }, fs.n ? `クラス平均 ${pct(fs.avg)}` : 'まだ比較できる記録がありません', fs.rank ? ` ・ ${fs.rank}位 / ${fs.n}人` : '')));
    }));
  }

  // 全員の点数（平均・順位の計算用）をリアルタイムで受け取る
  const unsub = onSnapshot(query(collection(db, 'scores'), where('wbId', '==', wbId)), (snap) => {
    const others = {};
    for (const d of snap.docs) {
      const data = d.data();
      if (data.uid === uid) { if (!editable) { st.scores = { ...(data.scores || {}) }; st.dates = { ...(data.dates || {}) }; } continue; }
      others[data.uid] = data.scores || {};
    }
    st.others = others;
    recompute();
    if (!editable) updateDates();
  }, (e) => setSave('error', '集計を読み込めませんでした: ' + errMsg(e)));
  S.cleanups.push(unsub);

  const nameLine = `${student.className ? student.className + '組 ' : ''}${student.number ? student.number + '番 ' : ''}${student.displayName}`;
  mount(
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'eyebrow' }, teacherMode ? h('a', { href: `#/t/wb/${wbId}/results` }, '← 成績一覧') : h('a', { href: '#/' }, '← 自分の得点表')),
        h('h1', null, wb.title),
        h('p', { class: 'small muted' }, teacherMode ? `${nameLine} さんの記録（閲覧のみ）` : nameLine)),
      saveEl),
    wb.description ? h('p', { class: 'notice' }, wb.description) : null,
    tiles,
    h('div', { class: 'tabs', role: 'tablist' }, tabSheet, tabFields),
    sheetBox,
    fieldsWrap,
    editable ? h('p', { class: 'small muted' }, '点数は問題ごとに入力すると自動で保存されます。受けていない回は空欄のままにしてください。回・セットの順位は全問を記入した人どうしで比べます。') : null,
  );
  updateDates();
  recompute();
}

// ---------------------------------------------------------------- teacher: home
async function viewTeacherHome() {
  const snap = await getDocs(collection(db, 'workbooks'));
  const wbs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const titleIn = h('input', { type: 'text', id: 'new-wb', placeholder: '例: 数学Ⅰ・A 共通テスト対策 得点表', maxlength: 60, style: 'flex:1;min-width:12em' });
  const msg = h('span', { class: 'err' });
  const createBtn = h('button', { class: 'btn primary', type: 'button' }, '作成して編集');
  createBtn.onclick = async () => {
    const title = titleIn.value.trim();
    if (!title) { msg.textContent = '得点表の名前を入力してください。'; return; }
    createBtn.disabled = true;
    try {
      const ref = await addDoc(collection(db, 'workbooks'), { title, description: '', published: false, fields: [], sets: [], createdAt: Date.now(), updatedAt: Date.now() });
      location.hash = `#/t/wb/${ref.id}/edit`;
    } catch (e) { msg.textContent = errMsg(e); createBtn.disabled = false; }
  };

  const list = wbs.map((wb) => {
    const idx = indexWorkbook(wb);
    const pubBtn = h('button', { class: 'btn small', type: 'button' }, wb.published ? '非公開にする' : '生徒に公開する');
    pubBtn.onclick = async () => {
      pubBtn.disabled = true;
      try { await updateDoc(doc(db, 'workbooks', wb.id), { published: !wb.published, updatedAt: Date.now() }); route(); }
      catch (e) { toast(errMsg(e)); pubBtn.disabled = false; }
    };
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', null, wb.title), wb.published ? h('span', { class: 'pill good' }, '公開中') : h('span', { class: 'pill muted' }, '非公開')),
      h('p', { class: 'small muted' }, `${(wb.sets || []).length}セット ・ ${idx.rounds.size}回 ・ ${idx.all.length}問 ・ 分野 ${(wb.fields || []).length}`),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary small', href: `#/t/wb/${wb.id}/results` }, '成績一覧'),
        h('a', { class: 'btn small', href: `#/t/wb/${wb.id}/edit` }, '構成を編集'),
        pubBtn));
  });

  mount(
    h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, '教師用'), h('h1', null, '得点表の管理'))),
    h('div', { class: 'card' },
      h('h2', null, '新しい得点表を作る'),
      h('p', { class: 'small muted' }, '教材やテストごとに1つ作ります。作成後に、セット・回・問題（番号・分野・配点）を設定します。'),
      h('div', { class: 'row' }, titleIn, createBtn), msg),
    wbs.length ? h('div', { class: 'wb-list' }, list) : h('p', { class: 'muted' }, 'まだ得点表がありません。上のフォームから作成してください。'),
  );
}

// ---------------------------------------------------------------- teacher: editor
async function viewEditor(wbId) {
  const snap = await getDoc(doc(db, 'workbooks', wbId));
  if (!snap.exists()) throw Object.assign(new Error(), { code: 'not-found' });
  const orig = snap.data();
  const wb = JSON.parse(JSON.stringify({ title: orig.title, description: orig.description || '', published: !!orig.published, fields: orig.fields || [], sets: orig.sets || [] }));
  let dirty = false;
  const markDirty = () => { dirty = true; statusEl.textContent = '未保存の変更があります'; statusEl.className = 'small err'; };
  const statusEl = h('span', { class: 'small muted' }, '');
  const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  S.cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

  const box = h('div', { class: 'stack' });
  const nextRoundNo = () => wb.sets.reduce((a, s) => a + s.rounds.length, 0) + 1;
  const newRound = () => ({ id: rid('r_'), label: `第${nextRoundNo()}回`, items: [{ id: rid('i_'), label: '', fieldId: null, max: 10 }] });
  const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; markDirty(); render(); };
  const textIn = (obj, key, attrs = {}) => {
    const el = h('input', { type: 'text', value: obj[key] ?? '', ...attrs });
    el.addEventListener('input', () => { obj[key] = el.value; markDirty(); });
    return el;
  };
  const numIn = (obj, key, attrs = {}) => {
    const el = h('input', { type: 'number', min: 1, step: 'any', value: obj[key] ?? '', ...attrs });
    el.addEventListener('input', () => { obj[key] = el.value === '' ? null : Number(el.value); markDirty(); renderTotals(); });
    return el;
  };
  const totalsEl = h('p', { class: 'small muted' });
  function renderTotals() {
    const idx = indexWorkbook({ ...wb, sets: wb.sets.map((s) => ({ ...s, rounds: s.rounds.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i, max: Number(i.max) || 0 })) })) })) });
    const parts = wb.fields.map((f) => `${f.name || '（名前なし）'} ${fmt(evalGroup(idx.fields.get(f.id) || [], {}).max)}点`);
    totalsEl.textContent = `全体の満点 ${fmt(evalGroup(idx.all, {}).max)}点` + (parts.length ? ` ／ 分野別の満点: ${parts.join('、')}` : '');
  }

  function render() {
    const fieldsEd = h('div', { class: 'ed-fields' }, wb.fields.map((f, i) => h('div', { class: 'ed-field' },
      textIn(f, 'name', { placeholder: '分野名（例: 2次関数）', maxlength: 30, 'aria-label': '分野名' }),
      h('span', { class: 'small muted' }, ''),
      h('button', { class: 'btn small', type: 'button', onclick: () => move(wb.fields, i, -1), 'aria-label': '上へ' }, '↑'),
      h('button', { class: 'btn small', type: 'button', onclick: () => move(wb.fields, i, 1), 'aria-label': '下へ' }, '↓'),
      h('button', {
        class: 'btn small danger', type: 'button', onclick: () => {
          wb.fields.splice(i, 1);
          for (const s of wb.sets) for (const r of s.rounds) for (const it of r.items) if (it.fieldId === f.id) it.fieldId = null;
          markDirty(); render();
        },
      }, '削除'))));

    const fieldSelect = (item) => {
      const sel = h('select', { 'aria-label': '分野' }, h('option', { value: '' }, '（分野なし）'),
        wb.fields.map((f) => h('option', { value: f.id, selected: item.fieldId === f.id }, f.name || '（名前なし）')));
      sel.addEventListener('change', () => { item.fieldId = sel.value || null; markDirty(); renderTotals(); });
      return sel;
    };

    const setsEd = wb.sets.map((set, si) => h('section', { class: 'ed-set' },
      h('div', { class: 'ed-set-head' },
        textIn(set, 'label', { maxlength: 20, 'aria-label': 'セット名' }),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn small', type: 'button', onclick: () => move(wb.sets, si, -1) }, '↑'),
        h('button', { class: 'btn small', type: 'button', onclick: () => move(wb.sets, si, 1) }, '↓'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { set.rounds.push(newRound()); markDirty(); render(); } }, '＋ 回を追加'),
        confirmButton('セットを削除', 'もう一度押すと削除', async () => { wb.sets.splice(si, 1); markDirty(); render(); }, 'btn small')),
      set.rounds.map((round, ri) => h('div', { class: 'ed-round' },
        h('div', { class: 'ed-round-head' },
          textIn(round, 'label', { maxlength: 20, 'aria-label': '回の名前' }),
          h('span', { class: 'small muted' }, `小計 ${fmt(round.items.reduce((a, i) => a + (Number(i.max) || 0), 0))}点`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', type: 'button', onclick: () => move(set.rounds, ri, -1) }, '↑'),
          h('button', { class: 'btn small', type: 'button', onclick: () => move(set.rounds, ri, 1) }, '↓'),
          h('button', {
            class: 'btn small', type: 'button', title: 'この回と同じ問題構成の回を下に追加',
            onclick: () => { set.rounds.splice(ri + 1, 0, { id: rid('r_'), label: `第${nextRoundNo()}回`, items: round.items.map((i) => ({ ...i, id: rid('i_') })) }); markDirty(); render(); },
          }, '複製'),
          h('button', { class: 'btn small danger', type: 'button', onclick: () => { set.rounds.splice(ri, 1); markDirty(); render(); } }, '削除')),
        h('div', { class: 'ed-items' },
          h('div', { class: 'ed-item label' }, h('span', null, '問題番号'), h('span', null, '分野'), h('span', null, '配点'), h('span')),
          round.items.map((item, ii) => h('div', { class: 'ed-item' },
            textIn(item, 'label', { maxlength: 10, placeholder: '1-1', 'aria-label': '問題番号' }),
            fieldSelect(item),
            numIn(item, 'max', { 'aria-label': '配点' }),
            h('button', { class: 'btn small danger', type: 'button', onclick: () => { round.items.splice(ii, 1); markDirty(); render(); } }, '削除')))),
        h('div', null, h('button', { class: 'btn small', type: 'button', onclick: () => { round.items.push({ id: rid('i_'), label: '', fieldId: null, max: 10 }); markDirty(); render(); } }, '＋ 問題を追加'))))));

    const roundsPerSet = h('select', { 'aria-label': '1セットの回数' }, [1, 2, 3, 4].map((n) => h('option', { value: n, selected: n === 2 }, `${n}回`)));
    const addSet = h('button', {
      class: 'btn', type: 'button', onclick: () => {
        const set = { id: rid('s_'), label: `セット${wb.sets.length + 1}`, rounds: [] };
        wb.sets.push(set);
        for (let k = 0; k < Number(roundsPerSet.value); k++) set.rounds.push(newRound());
        markDirty(); render();
      },
    }, '＋ セットを追加');

    const pub = h('input', { type: 'checkbox', checked: wb.published, id: 'ed-pub' });
    pub.addEventListener('change', () => { wb.published = pub.checked; markDirty(); });
    const desc = h('textarea', { rows: 2, maxlength: 300, id: 'ed-desc', placeholder: '例: 奇数回と偶数回の2回で1セット（100点満点）。解く前にセットごとの目標点を書こう。' });
    desc.value = wb.description;
    desc.addEventListener('input', () => { wb.description = desc.value; markDirty(); });

    box.replaceChildren(
      h('div', { class: 'card' },
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'ed-title' }, '得点表の名前'), textIn(wb, 'title', { id: 'ed-title', maxlength: 60 })),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'ed-desc' }, '説明（生徒の画面の上に表示）'), desc),
        h('label', { class: 'row' }, pub, '生徒に公開する')),
      h('div', { class: 'card' },
        h('h2', null, '分野'),
        h('p', { class: 'small muted' }, '「分野別チェック」で集計する単位です。問題ごとにどの分野かを選びます。'),
        fieldsEd,
        h('div', null, h('button', { class: 'btn small', type: 'button', onclick: () => { wb.fields.push({ id: rid('f_'), name: '' }); markDirty(); render(); } }, '＋ 分野を追加'))),
      h('div', { class: 'stack' },
        h('h2', null, 'セット・回・問題'),
        h('p', { class: 'small muted' }, 'セットの中に回、回の中に問題（問題番号・分野・配点）を並べます。同じ構成の回は「複製」で作ると早いです。'),
        setsEd,
        h('div', { class: 'row' }, addSet, h('span', { class: 'small muted' }, '1セットの回数'), roundsPerSet)),
      totalsEl);
    renderTotals();
  }

  async function save() {
    const problems = [];
    if (!wb.title.trim()) problems.push('得点表の名前を入力してください。');
    wb.fields.forEach((f) => { if (!f.name.trim()) problems.push('名前のない分野があります。'); });
    for (const s of wb.sets) {
      if (!s.label.trim()) problems.push('名前のないセットがあります。');
      for (const r of s.rounds) {
        if (!r.label.trim()) problems.push(`${s.label} に名前のない回があります。`);
        if (!r.items.length) problems.push(`${s.label} ${r.label} に問題がありません。`);
        for (const it of r.items) if (!(Number(it.max) > 0)) problems.push(`${s.label} ${r.label} に配点が0以下または空の問題があります。`);
      }
    }
    if (problems.length) { statusEl.textContent = [...new Set(problems)].join(' '); statusEl.className = 'small err'; return; }
    const clean = {
      title: wb.title.trim(), description: wb.description.trim(), published: wb.published,
      fields: wb.fields.map((f) => ({ id: f.id, name: f.name.trim() })),
      sets: wb.sets.map((s) => ({
        id: s.id, label: s.label.trim(),
        rounds: s.rounds.map((r) => ({ id: r.id, label: r.label.trim(), items: r.items.map((i) => ({ id: i.id, label: (i.label || '').trim(), fieldId: i.fieldId || null, max: Number(i.max) })) })),
      })),
      updatedAt: Date.now(),
    };
    saveBtn.disabled = true;
    try {
      await updateDoc(doc(db, 'workbooks', wbId), clean);
      dirty = false; statusEl.textContent = '保存しました'; statusEl.className = 'small ok';
      toast('保存しました');
    } catch (e) { statusEl.textContent = errMsg(e); statusEl.className = 'small err'; }
    finally { saveBtn.disabled = false; }
  }
  const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: save }, '保存する');

  const delBtn = confirmButton('この得点表を削除', 'もう一度押すと、生徒の記録ごと削除します', async () => {
    try {
      for (const col of ['scores', 'notes']) {
        const s = await getDocs(query(collection(db, col), where('wbId', '==', wbId)));
        for (let i = 0; i < s.docs.length; i += 400) {
          const b = writeBatch(db);
          s.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
          await b.commit();
        }
      }
      await deleteDoc(doc(db, 'workbooks', wbId));
      dirty = false;
      toast('削除しました');
      location.hash = '#/';
    } catch (e) { toast(errMsg(e)); }
  });

  render();
  mount(
    h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, h('a', { href: '#/' }, '← 得点表の管理')), h('h1', null, '得点表の構成を編集')),
      h('a', { class: 'btn small', href: `#/t/wb/${wbId}/results` }, '成績一覧へ')),
    h('p', { class: 'notice warn small' }, '生徒が記入を始めた後に問題を削除すると、その問題の点数は集計に使われなくなります。配点や分野の変更はすぐに集計に反映されます。'),
    box,
    h('div', { class: 'sticky-save' }, saveBtn, statusEl, h('span', { class: 'spacer' }), delBtn),
  );
}

// ---------------------------------------------------------------- teacher: results
async function viewResults(wbId) {
  const wbSnap = await getDoc(doc(db, 'workbooks', wbId));
  if (!wbSnap.exists()) throw Object.assign(new Error(), { code: 'not-found' });
  const wb = { id: wbId, ...wbSnap.data() };
  const idx = indexWorkbook(wb);
  const [uSnap, nSnap] = await Promise.all([
    getDocs(query(collection(db, 'users'), where('role', '==', 'student'))),
    getDocs(query(collection(db, 'notes'), where('wbId', '==', wbId))),
  ]);
  const students = uSnap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort(byClassNumber);
  const notes = Object.fromEntries(nSnap.docs.map((d) => [d.data().uid, d.data()]));
  let records = {};
  const st = { mode: 'rounds', cls: '', sort: 'number' };

  const classes = [...new Set(students.map((s) => s.className).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
  const clsSel = h('select', { 'aria-label': '組' }, h('option', { value: '' }, 'すべての組'), classes.map((c) => h('option', { value: c }, `${c}組`)));
  clsSel.onchange = () => { st.cls = clsSel.value; render(); };
  const sortSel = h('select', { 'aria-label': '並び順' }, h('option', { value: 'number' }, '出席番号順'), h('option', { value: 'rate' }, '得点率の高い順'));
  sortSel.onchange = () => { st.sort = sortSel.value; render(); };
  const modes = [['rounds', '回別'], ['sets', 'セット別'], ['fields', '分野別']];
  const modeTabs = modes.map(([k, label]) => {
    const b = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(k === st.mode) }, label);
    b.onclick = () => { st.mode = k; modeTabs.forEach((t, i) => t.setAttribute('aria-selected', String(modes[i][0] === k))); render(); };
    return b;
  });
  const tableBox = h('div', { class: 'tscroll' });
  const summary = h('div', { class: 'tiles' });

  function columns() {
    if (st.mode === 'rounds') return [...idx.rounds.entries()].map(([id, items]) => ({ key: id, label: items[0] ? items[0].roundLabel : '', items, kind: 'complete' }));
    if (st.mode === 'sets') return (wb.sets || []).map((s) => ({ key: s.id, label: s.label, items: idx.sets.get(s.id), kind: 'complete', set: s }));
    return (wb.fields || []).map((f) => ({ key: f.id, label: f.name, items: idx.fields.get(f.id) || [], kind: 'rate' }));
  }

  function render() {
    const cols = columns();
    const rows = students.filter((s) => !st.cls || s.className === st.cls).map((s) => {
      const scores = (records[s.uid] || {}).scores || {};
      const overall = evalGroup(idx.all, scores);
      let done = 0;
      for (const items of idx.rounds.values()) if (evalGroup(items, scores).complete) done++;
      return { s, scores, overall, done, cells: cols.map((c) => evalGroup(c.items, scores)), updatedAt: (records[s.uid] || {}).updatedAt };
    });
    const rates = rows.filter((r) => r.overall.count).map((r) => r.overall.rate);
    if (st.sort === 'rate') rows.sort((a, b) => (b.overall.rate ?? -1) - (a.overall.rate ?? -1));

    const ov = describe(rates);
    summary.replaceChildren(
      h('div', { class: 'tile' }, h('span', { class: 'label' }, '生徒数'), h('span', { class: 'v' }, String(rows.length), h('small', null, '人'))),
      h('div', { class: 'tile' }, h('span', { class: 'label' }, '記入している生徒'), h('span', { class: 'v' }, String(rates.length), h('small', null, '人'))),
      h('div', { class: 'tile' }, h('span', { class: 'label' }, '平均得点率'), h('span', { class: 'v' }, pct(ov.avg))),
      h('div', { class: 'tile' }, h('span', { class: 'label' }, '最高得点率'), h('span', { class: 'v' }, pct(ov.max))));

    const colAvg = cols.map((c, i) => {
      const vals = rows.map((r) => r.cells[i]).filter((g) => (c.kind === 'complete' ? g.complete : g.count > 0)).map((g) => (c.kind === 'complete' ? g.sum : g.rate));
      return describe(vals);
    });
    const maxOf = (c) => evalGroup(c.items, {}).max;
    const cellFor = (c, g, r) => {
      if (!g.count) return h('td', { class: 'r muted' }, '—');
      if (c.kind === 'rate') return h('td', { class: `r num ${heat(g.rate)}` }, pct(g.rate));
      const target = c.set ? ((notes[r.s.uid] || {}).entries || {})[c.set.id]?.target : undefined;
      return h('td', { class: `r num ${g.complete ? heat(g.rate) : 'partial'}`, title: g.complete ? '' : `記入途中（${g.count}/${g.total}問）` },
        fmt(g.sum), g.complete ? '' : '*', isNum(target) ? h('span', { class: 'muted small' }, ` (目標${fmt(target)})`) : '');
    };

    tableBox.replaceChildren(h('table', null,
      h('thead', null, h('tr', null,
        h('th', { class: 'sticky' }, '名前'), h('th', null, '組'), h('th', { class: 'r' }, '番号'),
        cols.map((c) => h('th', { class: 'r' }, c.label, h('br'), h('span', null, c.kind === 'rate' ? `満点${fmt(maxOf(c))}` : `/${fmt(maxOf(c))}`))),
        h('th', { class: 'r' }, '記入済み'), h('th', { class: 'r' }, '得点率'), h('th', { class: 'r' }, '順位'), h('th', { class: 'r' }, '最終目標'), h('th', null, '最終更新'))),
      h('tbody', null,
        h('tr', { class: 'avg-row' },
          h('td', { class: 'sticky' }, '平均'), h('td'), h('td'),
          cols.map((c, i) => h('td', { class: 'r num' }, colAvg[i].n ? (c.kind === 'rate' ? pct(colAvg[i].avg) : f1(colAvg[i].avg)) : '—')),
          h('td'), h('td', { class: 'r num' }, pct(ov.avg)), h('td'), h('td'), h('td')),
        rows.map((r) => h('tr', null,
          h('td', { class: 'sticky' }, h('a', { href: `#/t/wb/${wbId}/u/${r.s.uid}` }, r.s.displayName)),
          h('td', null, r.s.className || ''), h('td', { class: 'r num' }, r.s.number ?? ''),
          cols.map((c, i) => cellFor(c, r.cells[i], r)),
          h('td', { class: 'r num' }, `${r.done}/${idx.rounds.size}`),
          h('td', { class: `r num ${heat(r.overall.rate)}` }, pct(r.overall.rate)),
          h('td', { class: 'r num' }, r.overall.count ? rankOf(rates, r.overall.rate) : '—'),
          h('td', { class: 'r num' }, isNum((notes[r.s.uid] || {}).goal) ? fmt(notes[r.s.uid].goal) : '—'),
          h('td', { class: 'num small muted' }, r.updatedAt ? new Date(r.updatedAt).toLocaleDateString('sv-SE') : '—'))))));
  }

  function exportCsv() {
    const head = ['組', '番号', '名前', 'ユーザー名'];
    for (const it of idx.all) head.push(`${it.roundLabel} ${it.label} ${(wb.fields || []).find((f) => f.id === it.fieldId)?.name || ''} (/${it.max})`.replace(/\s+/g, ' '));
    for (const [, items] of idx.rounds) head.push(`${items[0]?.roundLabel || ''} 小計 (/${evalGroup(items, {}).max})`);
    for (const s of wb.sets || []) head.push(`${s.label} 合計 (/${evalGroup(idx.sets.get(s.id), {}).max})`, `${s.label} 目標`);
    for (const f of wb.fields || []) head.push(`${f.name} 得点率(%)`);
    head.push('全体 得点率(%)', '最終目標');
    const lines = [head];
    for (const s of students.filter((x) => !st.cls || x.className === st.cls)) {
      const scores = (records[s.uid] || {}).scores || {};
      const note = notes[s.uid] || {};
      const row = [s.className || '', s.number ?? '', s.displayName, s.username];
      for (const it of idx.all) { const v = validScore(it, scores); row.push(v === null ? '' : v); }
      for (const [, items] of idx.rounds) { const g = evalGroup(items, scores); row.push(g.complete ? g.sum : ''); }
      for (const set of wb.sets || []) { const g = evalGroup(idx.sets.get(set.id), scores); row.push(g.complete ? g.sum : '', (note.entries || {})[set.id]?.target ?? ''); }
      for (const f of wb.fields || []) { const g = evalGroup(idx.fields.get(f.id) || [], scores); row.push(g.count ? f1(g.rate * 100) : ''); }
      const o = evalGroup(idx.all, scores);
      row.push(o.count ? f1(o.rate * 100) : '', note.goal ?? '');
      lines.push(row);
    }
    downloadText(`${wb.title}_成績_${today()}.csv`, lines.map((r) => r.map(csvCell).join(',')).join('\r\n'));
  }

  const unsub = onSnapshot(query(collection(db, 'scores'), where('wbId', '==', wbId)), (snap) => {
    records = Object.fromEntries(snap.docs.map((d) => [d.data().uid, d.data()]));
    render();
  }, (e) => toast(errMsg(e)));
  S.cleanups.push(unsub);

  mount(
    h('div', { class: 'page-head' },
      h('div', null, h('div', { class: 'eyebrow' }, h('a', { href: '#/' }, '← 得点表の管理')), h('h1', null, wb.title), h('p', { class: 'small muted' }, '成績一覧（リアルタイムで更新されます）')),
      h('div', { class: 'row' }, h('a', { class: 'btn small', href: `#/t/wb/${wbId}/edit` }, '構成を編集'), h('button', { class: 'btn small', type: 'button', onclick: exportCsv }, 'CSVでダウンロード'))),
    summary,
    h('div', { class: 'row' }, h('div', { class: 'tabs', role: 'tablist' }, modeTabs), h('span', { class: 'spacer' }), clsSel, sortSel),
    tableBox,
    h('p', { class: 'small muted' }, '名前を押すと、その生徒の得点表（目標・振り返りメモを含む）を見られます。「*」は記入途中の回・セットです。色: 得点率 70%以上=緑、50〜70%=橙、50%未満=赤。'),
  );
  render();
}

// ---------------------------------------------------------------- teacher: users
async function viewUsers() {
  const [uSnap, secSnap] = await Promise.all([getDocs(collection(db, 'users')), getDoc(doc(db, 'config', 'secret')).catch(() => null)]);
  let users = uSnap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.role === b.role ? 0 : a.role === 'teacher' ? -1 : 1) || byClassNumber(a, b));
  const secret = secSnap && secSnap.exists() ? secSnap.data() : {};

  // 登録コード
  const sc = h('input', { type: 'text', value: secret.studentCode || '', id: 'code-s', maxlength: 40, autocomplete: 'off' });
  const tc = h('input', { type: 'text', value: secret.teacherCode || '', id: 'code-t', maxlength: 40, autocomplete: 'off' });
  const codeMsg = h('span', { class: 'small' });
  const codeCard = h('div', { class: 'card' },
    h('h2', null, '登録コード'),
    h('p', { class: 'small muted' }, '生徒が自分でアカウントを作るときに入力するコードです。空欄にすると、その種類の自己登録はできなくなります。'),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'code-s' }, '生徒用'), sc),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'code-t' }, '教師用'), tc),
      h('button', {
        class: 'btn', type: 'button', style: 'align-self:flex-end', onclick: async () => {
          try { await setDoc(doc(db, 'config', 'secret'), { studentCode: sc.value.trim(), teacherCode: tc.value.trim() }); codeMsg.className = 'small ok'; codeMsg.textContent = '保存しました'; }
          catch (e) { codeMsg.className = 'small err'; codeMsg.textContent = errMsg(e); }
        },
      }, '保存'), codeMsg));

  // 一括作成
  const bulk = h('textarea', { rows: 6, id: 'bulk', placeholder: '3-1,1,山田 太郎,yamada.taro\n3-1,2,佐藤 花子,sato.hanako' });
  const roleSel = h('select', { id: 'bulk-role' }, h('option', { value: 'student' }, '生徒として作成'), h('option', { value: 'teacher' }, '教師として作成'));
  const bulkMsg = h('div', { class: 'small' });
  const bulkResult = h('div');
  const bulkBtn = h('button', { class: 'btn primary', type: 'button' }, 'アカウントを作成');
  bulkBtn.onclick = async () => {
    const lines = bulk.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows = [], problems = [];
    lines.forEach((l, i) => {
      const [cls = '', num = '', name = '', user = ''] = l.split(/[,\t、，]/).map((x) => x.trim());
      const username = user.toLowerCase();
      if (!name || !USERNAME_RE.test(username)) problems.push(`${i + 1}行目: 名前とユーザー名（半角英数字と . _ - で3〜30文字）を確認してください`);
      else rows.push({ className: cls, number: num && Number.isInteger(Number(num)) ? Number(num) : null, displayName: name.slice(0, 40), username });
    });
    if (!rows.length || problems.length) { bulkMsg.className = 'small err'; bulkMsg.textContent = problems.join(' / ') || '1行に「組,番号,名前,ユーザー名」の形で入力してください。'; return; }
    bulkBtn.disabled = true;
    bulkMsg.className = 'small muted';
    const a2 = await secondaryAuth();
    const results = [];
    for (const [i, r] of rows.entries()) {
      bulkMsg.textContent = `作成中… ${i + 1} / ${rows.length}`;
      const password = genPassword();
      try {
        const cred = await createUserWithEmailAndPassword(a2, emailOf(r.username), password);
        try {
          await setDoc(doc(db, 'users', cred.user.uid), { ...r, role: roleSel.value, mustChangePassword: true, createdAt: Date.now() });
        } catch (e) { await cred.user.delete().catch(() => {}); throw e; }
        results.push({ ...r, password, ok: true });
      } catch (e) { results.push({ ...r, ok: false, error: errMsg(e) }); }
      finally { await signOut(a2).catch(() => {}); }
    }
    bulkBtn.disabled = false;
    const okRows = results.filter((r) => r.ok);
    bulkMsg.className = 'small ' + (okRows.length === results.length ? 'ok' : 'err');
    bulkMsg.textContent = `${okRows.length}件作成しました` + (okRows.length < results.length ? `（${results.length - okRows.length}件は失敗）` : '') + '。初期パスワードはこの画面を離れると再表示できません。控えてから生徒に配ってください。';
    const tsv = ['組\t番号\t名前\tユーザー名\t初期パスワード', ...okRows.map((r) => [r.className, r.number ?? '', r.displayName, r.username, r.password].join('\t'))].join('\n');
    bulkResult.replaceChildren(
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(tsv); toast('コピーしました（表計算ソフトに貼り付けられます）'); } catch (e) { toast('コピーできませんでした'); } } }, '一覧をコピー'),
        h('button', { class: 'btn small', type: 'button', onclick: () => downloadText(`初期パスワード_${today()}.csv`, tsv.replace(/\t/g, ',')) }, 'CSVで保存')),
      h('div', { class: 'tscroll' }, h('table', { class: 'pw-list' },
        h('thead', null, h('tr', null, h('th', null, '組'), h('th', null, '番号'), h('th', null, '名前'), h('th', null, 'ユーザー名'), h('th', null, '初期パスワード / 結果'))),
        h('tbody', null, results.map((r) => h('tr', null, h('td', null, r.className), h('td', null, r.number ?? ''), h('td', null, r.displayName), h('td', null, r.username),
          h('td', { class: r.ok ? '' : 'err' }, r.ok ? r.password : r.error)))))));
    if (okRows.length) { bulk.value = ''; await refreshList(); }
  };
  const bulkCard = h('div', { class: 'card' },
    h('h2', null, 'アカウントをまとめて作成'),
    h('p', { class: 'small muted' }, '1行に1人、「組,番号,名前,ユーザー名」の順でカンマ区切りで入力します（表計算ソフトからの貼り付けも可）。初期パスワードは自動で作られ、生徒は最初のログイン時に自分のパスワードへ変更します。'),
    bulk, h('div', { class: 'row' }, roleSel, bulkBtn), bulkMsg, bulkResult);

  // 一覧
  const listBox = h('div', { class: 'tscroll' });
  const filterSel = h('select', { 'aria-label': '組で絞り込み' });
  filterSel.onchange = () => renderList();
  async function refreshList() {
    const s = await getDocs(collection(db, 'users'));
    users = s.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (a.role === b.role ? 0 : a.role === 'teacher' ? -1 : 1) || byClassNumber(a, b));
    renderList();
  }
  const call = (name) => httpsCallable(fns, name);

  function renderList() {
    const classes = [...new Set(users.map((u) => u.className).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
    const cur = filterSel.value;
    filterSel.replaceChildren(h('option', { value: '' }, 'すべて'), classes.map((c) => h('option', { value: c, selected: c === cur }, `${c}組`)));
    const shown = users.filter((u) => !filterSel.value || u.className === filterSel.value);
    listBox.replaceChildren(h('table', null,
      h('thead', null, h('tr', null, h('th', null, '組'), h('th', { class: 'r' }, '番号'), h('th', null, '名前'), h('th', null, 'ユーザー名'), h('th', null, '役割'), h('th', null, 'パスワード'), h('th', null, '操作'))),
      h('tbody', null, shown.map((u) => userRow(u)))));
  }

  function userRow(u) {
    const tr = h('tr');
    const pwCell = h('td', null, u.mustChangePassword ? h('span', { class: 'pill warn' }, '初期パスワードのまま') : h('span', { class: 'pill muted' }, '変更済み'));
    const actions = h('td', { class: 'row', style: 'flex-wrap:nowrap' });
    const isMe = u.uid === S.user.uid;
    actions.append(h('button', { class: 'btn small', type: 'button', onclick: () => editRow() }, '編集'));
    if (fns) {
      actions.append(confirmButton('パスワード再発行', 'もう一度押すと再発行', async () => {
        try { const r = await call('resetPassword')({ uid: u.uid }); u.mustChangePassword = true; pwCell.replaceChildren(h('span', { class: 'num' }, `新しいパスワード: ${r.data.password}`)); }
        catch (e) { toast(errMsg(e)); }
      }, 'btn small'));
    }
    if (!isMe) {
      actions.append(confirmButton('削除', 'もう一度押すと記録ごと削除', async () => {
        try {
          if (fns) await call('deleteAccount')({ uid: u.uid });
          for (const col of ['scores', 'notes']) {
            const s = await getDocs(query(collection(db, col), where('uid', '==', u.uid)));
            const b = writeBatch(db); s.docs.forEach((d) => b.delete(d.ref)); if (s.docs.length) await b.commit();
          }
          await deleteDoc(doc(db, 'users', u.uid));
          users = users.filter((x) => x.uid !== u.uid);
          renderList();
          toast(fns ? '削除しました' : '削除しました（ログイン情報はFirebaseコンソールから削除してください）');
        } catch (e) { toast(errMsg(e)); }
      }));
    }
    tr.append(h('td', null, u.className || ''), h('td', { class: 'r num' }, u.number ?? ''), h('td', null, u.displayName), h('td', { class: 'num' }, u.username),
      h('td', null, u.role === 'teacher' ? h('span', { class: 'pill accent' }, '教師') : '生徒'), pwCell, actions);

    function editRow() {
      const c = h('input', { type: 'text', value: u.className || '', style: 'width:5em', maxlength: 20, 'aria-label': '組' });
      const n = h('input', { type: 'number', value: u.number ?? '', style: 'width:5em', 'aria-label': '番号' });
      const nm = h('input', { type: 'text', value: u.displayName, maxlength: 40, 'aria-label': '名前' });
      const rl = h('select', { 'aria-label': '役割', disabled: isMe }, h('option', { value: 'student', selected: u.role === 'student' }, '生徒'), h('option', { value: 'teacher', selected: u.role === 'teacher' }, '教師'));
      const save = h('button', {
        class: 'btn small primary', type: 'button', onclick: async () => {
          const num = n.value === '' ? null : parseInt(n.value, 10);
          const next = { ...u, className: c.value.trim(), number: Number.isInteger(num) ? num : null, displayName: nm.value.trim() || u.displayName, role: rl.value };
          const { uid, ...data } = next;
          try { await setDoc(doc(db, 'users', uid), data); Object.assign(u, next); renderList(); toast('保存しました'); }
          catch (e) { toast(errMsg(e)); }
        },
      }, '保存');
      tr.replaceChildren(h('td', null, c), h('td', null, n), h('td', null, nm), h('td', { class: 'num' }, u.username), h('td', null, rl), h('td'),
        h('td', { class: 'row', style: 'flex-wrap:nowrap' }, save, h('button', { class: 'btn small', type: 'button', onclick: () => renderList() }, 'やめる')));
    }
    return tr;
  }

  mount(
    h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, '教師用'), h('h1', null, '生徒・アカウント'))),
    !fns ? h('p', { class: 'notice small' }, 'パスワードを忘れた生徒がいる場合: Cloud Functions を有効にすると、この画面から再発行できます（README参照）。有効にしていない場合は、Firebase コンソールの Authentication でそのユーザーを削除し、ここで同じユーザー名のアカウントを作り直してください（記録は引き継がれません）。') : null,
    bulkCard,
    h('section', { class: 'stack' }, h('div', { class: 'row' }, h('h2', null, 'アカウント一覧'), h('span', { class: 'spacer' }), h('span', { class: 'label' }, '組'), filterSel), listBox),
    codeCard,
  );
  renderList();
}
