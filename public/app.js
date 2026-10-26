import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  updatePassword, EmailAuthProvider, reauthenticateWithCredential, setPersistence, inMemoryPersistence,
  connectAuthEmulator, sendPasswordResetEmail, sendEmailVerification, updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, onSnapshot, writeBatch, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
import { firebaseConfig, appConfig } from './firebase-config.js';
import { evalGroup, validScore, isNum, describe, rankOf, deviation, compare, histogram, binOf, blockOf, unchosenIds } from './stats.js';

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

// 先生が生徒アカウントを作るとき、自分のログイン状態を保ったまま作成するための 2 つ目のアプリ
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
const S = { ready: false, user: null, profile: null, busy: false, cleanups: [] };
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
// null / false を取り除いてから子要素を差し替える（そのままだと「null」という文字が表示される）
const clean = (nodes) => nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
const fill = (el, ...nodes) => el.replaceChildren(...clean(nodes));
// 描画を始めたあとに別の画面へ移っていたら、古い画面は表示しない
const mount = (...nodes) => {
  if (S.routeHash !== undefined && S.routeHash !== location.hash) return;
  fill($main, nodes);
  window.scrollTo(0, 0);
};
const fmt = (x) => (isNum(x) ? (Number.isInteger(x) ? String(x) : (Math.round(x * 10) / 10).toFixed(1)) : '—');
const f1 = (x) => (isNum(x) ? (Math.round(x * 10) / 10).toFixed(1) : '—');
const pct = (x) => (isNum(x) ? f1(x * 100) + '%' : '—');
const today = () => new Date().toLocaleDateString('sv-SE');
// 生徒は「出席番号」から作った内部用のメールアドレスで Firebase Authentication にログインする
const STUDENT_NO_RE = /^[0-9]{4}$/;
const studentEmail = (no) => `s${no}@${appConfig.studentEmailDomain}`;
const isStudentEmail = (email) => (email || '').toLowerCase().endsWith('@' + appConfig.studentEmailDomain);
const normNo = (s) => (s || '').normalize('NFKC').trim();
const normName = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '');
const rid = (p) => p + Math.random().toString(36).slice(2, 9);
const heat = (rate) => (!isNum(rate) ? '' : rate < 0.5 ? 'heat-lo' : rate < 0.7 ? 'heat-mid' : 'heat-hi');
const byNumber = (a, b) => (a.studentNo || a.email || '').localeCompare(b.studentNo || b.email || '') || a.displayName.localeCompare(b.displayName, 'ja');
// 出席番号の先頭2桁（例: 3101 → 31）で絞り込むための候補
const prefixesOf = (list) => [...new Set(list.filter((u) => u.role === 'student' && u.studentNo).map((u) => u.studentNo.slice(0, 2)))].sort();

function genPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

function errMsg(e) {
  const c = (e && e.code) || '';
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email', 'auth/invalid-login-credentials'].includes(c)) return 'ログイン情報が違います。';
  if (c === 'auth/email-already-in-use') return 'すでに登録されています。';
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
  fill(nav, ...[
    link('#/', '得点表'),
    isTeacher() ? link('#/t/classes', 'クラス') : null,
    isTeacher() ? link('#/t/users', '生徒・アカウント') : null,
    link('#/account', 'パスワード変更'),
    h('span', { class: 'who' }, `${S.profile.displayName}（${isTeacher() ? '先生' : '生徒'}）`),
    h('button', { type: 'button', onclick: () => signOut(auth) }, 'ログアウト'),
  ].filter(Boolean));
}

// 同じタイミングで何度呼ばれても描画は1回にまとめる（明示的な route() と hashchange が重なるため）
let routeTimer = null;
function route() {
  clearTimeout(routeTimer);
  routeTimer = setTimeout(renderRoute, 0);
}

async function renderRoute() {
  S.routeHash = location.hash;
  S.cleanups.splice(0).forEach((f) => { try { f(); } catch (e) { /* noop */ } });
  if (!S.ready || S.busy) return;
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
  if (!S.user) {
    renderNav();
    if (parts[0] === 'register') return viewStudentRegister();
    if (parts[0] === 'teacher') return viewTeacherLogin();
    if (parts[0] === 'teacher-register') return viewTeacherRegister();
    return viewLogin();
  }
  if (!S.profile) { renderNav(); return isStudentEmail(S.user.email) ? viewNoProfile() : viewTeacherPending(); }
  renderNav();
  if (S.profile.mustChangePassword) return viewPassword(true);
  try {
    if (parts[0] === 'account') return viewPassword(false);
    if (isTeacher()) {
      const [t0, kind, id, sub, uid, sub2] = parts;
      if (t0 === 't' && kind === 'users') return await viewUsers();
      if (t0 === 't' && kind === 'classes') return await viewClasses();
      if (t0 === 't' && kind === 'class' && id) return await viewClassEditor(id);
      if (t0 === 't' && (kind === 'test' || kind === 'set') && id) {
        if (sub === 'edit') return kind === 'test' ? await viewTestEditor(id) : await viewSetEditor(id);
        if (sub === 'results') return await viewResults(kind, id);
        if (sub === 'preview' && kind === 'test') return await viewTest(id, PREVIEW_UID, 'preview');
        if (sub === 'u' && uid) return kind === 'test' ? await viewTest(id, uid, sub2 === 'edit' ? 'teacher-edit' : 'teacher-view') : await viewSet(id, uid, 'teacher-view');
      }
      return await viewTeacherHome();
    }
    if (parts[0] === 'test' && parts[1]) return await viewTest(parts[1], S.user.uid, 'student');
    if (parts[0] === 'set' && parts[1]) return await viewSet(parts[1], S.user.uid, 'student');
    return await viewStudentHome();
  } catch (e) {
    console.error(e);
    mount(h('div', { class: 'card' }, h('h2', null, '表示できませんでした'), h('p', { class: 'err' }, errMsg(e)), h('p', null, h('a', { href: '#/' }, 'トップに戻る'))));
  }
}
window.addEventListener('hashchange', route);

onAuthStateChanged(auth, async (user) => {
  S.user = user;
  // ログイン・登録の処理中は、その処理の側でプロフィールを読み込んで画面を切り替える
  if (S.busy) return;
  S.profile = null;
  if (user) {
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      S.profile = snap.exists() ? snap.data() : null;
    } catch (e) { S.profile = null; }
  }
  S.ready = true;
  route();
});

// ---------------------------------------------------------------- auth views
let settingsCache = null;
async function publicSettings() {
  if (settingsCache) return settingsCache;
  try {
    const s = await getDoc(doc(db, 'config', 'settings'));
    settingsCache = s.exists() ? s.data() : {};
  } catch (e) { settingsCache = {}; }
  return settingsCache;
}

const field = (id, label, input, hint) => h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input, hint ? h('span', { class: 'small muted' }, hint) : null);
const noInput = (id) => h('input', { type: 'text', id, inputmode: 'numeric', maxlength: 4, autocomplete: 'username', placeholder: '例: 3101', required: true, style: 'width:8em' });
const authTabs = (active) => h('div', { class: 'tabs', role: 'tablist' },
  h('a', { class: 'tab', href: '#/', role: 'tab', 'aria-selected': String(active === 'student') }, '生徒'),
  h('a', { class: 'tab', href: '#/teacher', role: 'tab', 'aria-selected': String(active === 'teacher') }, '先生'));
const authCard = (...children) => h('div', { class: 'auth card' }, h('h1', null, appConfig.appName), ...children);

async function viewLogin() {
  const msg = h('p', { class: 'err', hidden: true });
  const form = h('form', null,
    field('li-no', '出席番号（4桁）', noInput('li-no')),
    field('li-name', '名前', h('input', { type: 'text', id: 'li-name', autocomplete: 'name', required: true, placeholder: '例: 山田 太郎' })),
    field('li-pass', 'パスワード', h('input', { type: 'password', id: 'li-pass', autocomplete: 'current-password', required: true })),
    msg,
    h('button', { class: 'btn primary', type: 'submit' }, 'ログイン'));
  const signupNote = h('p', { class: 'small', hidden: true }, 'はじめて使う人は ', h('a', { href: '#/register' }, 'アカウントを作成'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.hidden = true;
    const no = normNo(form.querySelector('#li-no').value);
    const name = form.querySelector('#li-name').value;
    const fail = 'ログインできません。出席番号・名前・パスワードを確かめてください。';
    if (!STUDENT_NO_RE.test(no)) { msg.textContent = '出席番号は4桁の数字で入力してください。'; msg.hidden = false; return; }
    const btn = form.querySelector('button');
    btn.disabled = true;
    S.busy = true;
    try {
      const cred = await signInWithEmailAndPassword(auth, studentEmail(no), form.querySelector('#li-pass').value);
      const snap = await getDoc(doc(db, 'users', cred.user.uid));
      // 名前が登録内容と合わなければログインさせない（空白・全角半角の違いは無視）
      if (!snap.exists() || normName(snap.data().displayName) !== normName(name)) {
        await signOut(auth);
        throw Object.assign(new Error(), { code: 'name-mismatch' });
      }
      S.user = cred.user;
      S.profile = snap.data();
      S.busy = false;
      location.hash = '#/';
      route();
    } catch (e) {
      S.busy = false;
      msg.textContent = e.code === 'name-mismatch' || /^auth\/(invalid|wrong|user-not)/.test(e.code || '') ? fail : errMsg(e);
      msg.hidden = false;
    } finally { btn.disabled = false; }
  });
  mount(authCard(authTabs('student'), form, signupNote));
  if ((await publicSettings()).selfSignup) signupNote.hidden = false;
}

function viewTeacherLogin() {
  const msg = h('p', { class: 'err', hidden: true });
  const form = h('form', null,
    field('tl-mail', 'メールアドレス', h('input', { type: 'email', id: 'tl-mail', autocomplete: 'email', required: true })),
    field('tl-pass', 'パスワード', h('input', { type: 'password', id: 'tl-pass', autocomplete: 'current-password', required: true })),
    msg,
    h('button', { class: 'btn primary', type: 'submit' }, 'ログイン'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.hidden = true;
    const email = form.querySelector('#tl-mail').value.trim();
    if (isStudentEmail(email)) { msg.textContent = 'メールアドレスまたはパスワードが違います。'; msg.hidden = false; return; }
    try { await signInWithEmailAndPassword(auth, email, form.querySelector('#tl-pass').value); location.hash = '#/'; }
    catch (e) { msg.textContent = /^auth\/(invalid|wrong|user-not)/.test(e.code || '') ? 'メールアドレスまたはパスワードが違います。' : errMsg(e); msg.hidden = false; }
  });
  const reset = h('button', {
    class: 'btn link', type: 'button', onclick: async () => {
      const email = form.querySelector('#tl-mail').value.trim();
      if (!email) { msg.textContent = '上の欄にメールアドレスを入力してから押してください。'; msg.hidden = false; return; }
      try { await sendPasswordResetEmail(auth, email); toast('パスワード再設定用のメールを送りました'); }
      catch (e) { msg.textContent = errMsg(e); msg.hidden = false; }
    },
  }, 'パスワードを忘れた場合');
  mount(authCard(authTabs('teacher'), form,
    h('div', { class: 'row small' }, reset, h('span', { class: 'spacer' }), h('a', { href: '#/teacher-register' }, '先生の新規登録'))));
}

async function viewStudentRegister() {
  if (!(await publicSettings()).selfSignup) {
    return mount(authCard(h('h2', null, 'アカウントの作成'), h('p', null, '現在、自分でアカウントを作ることはできません。先生から配られた出席番号とパスワードでログインしてください。'), h('p', null, h('a', { href: '#/' }, 'ログイン画面に戻る'))));
  }
  const msg = h('p', { class: 'err', hidden: true });
  const form = h('form', null,
    field('rg-no', '出席番号（4桁）', noInput('rg-no')),
    field('rg-name', '名前', h('input', { type: 'text', id: 'rg-name', required: true, maxlength: 40, placeholder: '例: 山田 太郎' }), 'ログインのときも同じ名前を入力します'),
    field('rg-pass', 'パスワード', h('input', { type: 'password', id: 'rg-pass', required: true, minlength: 6, autocomplete: 'new-password' }), '6文字以上'),
    field('rg-pass2', 'パスワード（確認）', h('input', { type: 'password', id: 'rg-pass2', required: true, autocomplete: 'new-password' })),
    msg,
    h('button', { class: 'btn primary', type: 'submit' }, 'アカウントを作成'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const show = (t) => { msg.textContent = t; msg.hidden = false; };
    msg.hidden = true;
    const no = normNo(form.querySelector('#rg-no').value);
    const name = form.querySelector('#rg-name').value.trim();
    if (!STUDENT_NO_RE.test(no)) return show('出席番号は4桁の数字で入力してください。');
    if (!name) return show('名前を入力してください。');
    if (form.querySelector('#rg-pass').value !== form.querySelector('#rg-pass2').value) return show('確認用のパスワードが一致しません。');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    S.busy = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, studentEmail(no), form.querySelector('#rg-pass').value);
      const profile = { studentNo: no, displayName: name.slice(0, 40), role: 'student', mustChangePassword: false, createdAt: Date.now(), classIds: [] };
      try { await setDoc(doc(db, 'users', cred.user.uid), profile); }
      catch (e) { await cred.user.delete().catch(() => {}); throw Object.assign(new Error(), { code: e.code === 'permission-denied' ? 'closed' : e.code }); }
      S.user = cred.user;
      S.profile = profile;
      S.busy = false;
      location.hash = '#/';
      route();
    } catch (e) {
      S.busy = false;
      show(e.code === 'auth/email-already-in-use' ? 'この出席番号はすでに登録されています。先生に確認してください。'
        : e.code === 'closed' ? '現在、自分でアカウントを作ることはできません。先生に確認してください。' : errMsg(e));
    } finally { btn.disabled = false; }
  });
  mount(authCard(h('h2', null, 'アカウントの作成'), form, h('p', { class: 'small' }, h('a', { href: '#/' }, 'ログイン画面に戻る'))));
}

function viewTeacherRegister() {
  const msg = h('p', { class: 'err', hidden: true });
  const form = h('form', null,
    field('tr-name', '名前', h('input', { type: 'text', id: 'tr-name', required: true, maxlength: 40, placeholder: '例: 田中 一郎' })),
    field('tr-mail', 'メールアドレス', h('input', { type: 'email', id: 'tr-mail', required: true, autocomplete: 'email' }), '先生として登録を許可されたメールアドレスだけが使えます'),
    field('tr-pass', 'パスワード', h('input', { type: 'password', id: 'tr-pass', required: true, minlength: 8, autocomplete: 'new-password' }), '8文字以上'),
    field('tr-pass2', 'パスワード（確認）', h('input', { type: 'password', id: 'tr-pass2', required: true, autocomplete: 'new-password' })),
    msg,
    h('button', { class: 'btn primary', type: 'submit' }, '登録して確認メールを送る'));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const show = (t) => { msg.textContent = t; msg.hidden = false; };
    msg.hidden = true;
    const email = form.querySelector('#tr-mail').value.trim();
    const name = form.querySelector('#tr-name').value.trim();
    const pw = form.querySelector('#tr-pass').value;
    if (isStudentEmail(email)) return show('このメールアドレスは使えません。');
    if (pw.length < 8) return show('パスワードは8文字以上にしてください。');
    if (pw !== form.querySelector('#tr-pass2').value) return show('確認用のパスワードが一致しません。');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    S.busy = true;
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, pw);
      await updateProfile(cred.user, { displayName: name.slice(0, 40) });
      await sendEmailVerification(cred.user);
      S.user = cred.user;
      S.profile = null;
    } catch (e) {
      show(e.code === 'auth/email-already-in-use' ? 'このメールアドレスはすでに登録されています。「先生」タブからログインしてください。' : errMsg(e));
    } finally {
      S.busy = false;
      btn.disabled = false;
    }
    if (S.user) { location.hash = '#/'; route(); }
  });
  mount(authCard(h('h2', null, '先生の新規登録'), form, h('p', { class: 'small' }, h('a', { href: '#/teacher' }, 'ログイン画面に戻る'))));
}

// 先生: メール確認 → 許可リストに載っていればプロフィールを作成
async function viewTeacherPending() {
  const u = S.user;
  const out = h('p', { class: 'small' });
  const logout = h('button', { class: 'btn', type: 'button', onclick: () => signOut(auth) }, 'ログアウト');
  if (!u.emailVerified) {
    const check = h('button', {
      class: 'btn primary', type: 'button', onclick: async () => {
        await u.reload();
        if (!auth.currentUser.emailVerified) { out.className = 'small err'; out.textContent = 'まだ確認が済んでいません。メールのリンクを開いてから押してください。'; return; }
        await auth.currentUser.getIdToken(true);
        viewTeacherPending();
      },
    }, '確認しました');
    const resend = h('button', {
      class: 'btn', type: 'button', onclick: async () => {
        try { await sendEmailVerification(u); out.className = 'small ok'; out.textContent = '確認メールを送り直しました。'; }
        catch (e) { out.className = 'small err'; out.textContent = errMsg(e); }
      },
    }, '確認メールを再送');
    return mount(authCard(h('h2', null, 'メールアドレスの確認'),
      h('p', null, `${u.email} に確認メールを送りました。メールのリンクを開いてから「確認しました」を押してください。`),
      h('p', { class: 'small muted' }, 'メールが見つからないときは、迷惑メールフォルダも確認してください。'),
      h('div', { class: 'row' }, check, resend, logout), out));
  }
  const profile = { email: u.email.toLowerCase(), displayName: (u.displayName || u.email.split('@')[0]).slice(0, 40), role: 'teacher', mustChangePassword: false, createdAt: Date.now() };
  try {
    await setDoc(doc(db, 'users', u.uid), profile);
    S.profile = profile;
    route();
  } catch (e) {
    mount(authCard(h('h2', null, '先生としての登録が許可されていません'),
      h('p', null, `${u.email} は、先生として登録できるメールアドレスの一覧にありません。`),
      h('p', { class: 'small muted' }, 'すでに登録している先生に「生徒・アカウント」画面の「先生として登録できるメールアドレス」へ追加してもらい、もう一度ログインしてください。最初の先生の場合は、README の手順で Firebase コンソールから追加します。'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'button', onclick: () => viewTeacherPending() }, 'もう一度確認する'), logout)));
  }
}

function viewNoProfile() {
  mount(authCard(
    h('h2', null, 'アカウント情報が見つかりません'),
    h('p', null, 'このアカウントは削除されたか、登録が完了していません。先生に確認してください。'),
    h('button', { class: 'btn', onclick: () => signOut(auth) }, 'ログアウト')));
}

function viewPassword(forced) {
  const msg = h('p', { class: 'err', hidden: true });
  const form = h('form', { class: 'stack' },
    field('pw-cur', forced ? '先生から受け取ったパスワード' : '今のパスワード', h('input', { type: 'password', id: 'pw-cur', required: true, autocomplete: 'current-password' })),
    field('pw-new', '新しいパスワード（6文字以上）', h('input', { type: 'password', id: 'pw-new', required: true, minlength: 6, autocomplete: 'new-password' })),
    field('pw-new2', '新しいパスワード（確認）', h('input', { type: 'password', id: 'pw-new2', required: true, autocomplete: 'new-password' })),
    msg,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'パスワードを変更'),
      forced ? h('button', { class: 'btn', type: 'button', onclick: () => signOut(auth) }, 'ログアウト') : null));
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
    } catch (e) { msg.textContent = /^auth\/(invalid|wrong)/.test(e.code || '') ? '今のパスワードが違います。' : errMsg(e); msg.hidden = false; }
  });
  mount(h('div', { class: 'auth card' },
    h('h1', null, forced ? '最初にパスワードを変更してください' : 'パスワード変更'),
    forced ? h('p', { class: 'small muted' }, '先生から受け取った仮のパスワードを、自分だけが知っているパスワードに変えます。') : null,
    h('p', { class: 'small muted' }, S.profile.role === 'student' ? `出席番号 ${S.profile.studentNo}　${S.profile.displayName}` : S.profile.email),
    form));
}

// ---------------------------------------------------------------- 共通: タブ・分野・テスト・セット
const CATS = [['kyotsu', '共通テスト専用得点表'], ['other', 'その他の演習']];
const CAT_SHORT = { kyotsu: '共通テスト', other: 'その他の演習' };
const isKyotsu = (x) => !!x && x.category === 'kyotsu';
const catOf = (x) => (isKyotsu(x) ? 'kyotsu' : 'other');
function loadCat() { try { return localStorage.getItem('cat') === 'other' ? 'other' : 'kyotsu'; } catch (e) { return 'kyotsu'; } }
function saveCat(c) { try { localStorage.setItem('cat', c); } catch (e) { /* noop */ } }
function catTabs(current, counts, onChange) {
  const tabs = CATS.map(([k, label]) => {
    const b = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(k === current) }, label,
      counts ? h('span', { class: 'muted small' }, ` ${counts[k] || 0}`) : null);
    b.onclick = () => { tabs.forEach((t, i) => t.setAttribute('aria-selected', String(CATS[i][0] === k))); saveCat(k); onChange(k); };
    return b;
  });
  return h('div', { class: 'tabs', role: 'tablist' }, tabs);
}

const docsOf = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '', 'ja', { numeric: true });
// 選択問題のグループに属する問題には、cg（グループのキー）・pick（選ぶ数）・block（大問）を付ける
const qItems = (t) => {
  const groups = Object.fromEntries((t.choiceGroups || []).map((g) => [g.id, g]));
  return (t.questions || []).map((q) => {
    const g = q.choiceGroup && groups[q.choiceGroup];
    return { ...q, max: Number(q.max) || 0, testId: t.id, testTitle: t.title, ...(g ? { cg: `${t.id}:${g.id}`, pick: Number(g.pick) || 1, block: blockOf(q) } : {}) };
  });
};
// 満点（選択問題は選ぶ数のぶんだけ数える）
const testMax = (t) => evalGroup(qItems(t), {}).max;
const blockName = (b) => (/^\d+$/.test(b) ? `第${b}問` : b);

async function loadFields(cat) {
  const s = await getDoc(doc(db, 'fieldLists', cat));
  return s.exists() && Array.isArray(s.data().fields) ? s.data().fields : [];
}
// 先生はすべて、生徒は自分のクラスに公開中のもの（visibleTo）だけ読める（ルールに合わせたクエリにする）
async function loadAll(col) {
  if (isTeacher()) return docsOf(await getDocs(collection(db, col))).sort(byTitle);
  const mine = (S.profile.classIds || []).slice(0, 30);
  if (!mine.length) return [];
  return docsOf(await getDocs(query(collection(db, col), where('visibleTo', 'array-contains-any', mine)))).sort(byTitle);
}

// ---- クラス
const byName = (a, b) => (a.name || '').localeCompare(b.name || '', 'ja', { numeric: true });
// 先生はすべてのクラス、生徒は自分が入っているクラスだけ読める
async function loadClasses() {
  const q = isTeacher() ? collection(db, 'classes') : query(collection(db, 'classes'), where('studentIds', 'array-contains', S.user.uid));
  return docsOf(await getDocs(q)).sort(byName);
}
const myTeachingIds = (classes) => classes.filter((c) => (c.teacherIds || []).includes(S.user.uid)).map((c) => c.id);
// 生徒に見せる配信先（公開中のときだけ）
const visibleFor = (published, classIds) => (published ? [...(classIds || [])] : []);
// 平均・順位・分布で比べる相手: 配信先クラスのうち、その生徒が入っているクラスの生徒（生徒が不明なら配信先全員）
function peersOf(obj, studentClassIds, classes) {
  const target = obj.classIds || [];
  let ids = studentClassIds ? target.filter((c) => studentClassIds.includes(c)) : target;
  if (!ids.length) ids = target;
  const set = new Set();
  for (const c of classes) if (ids.includes(c.id)) for (const u of c.studentIds || []) set.add(u);
  return set;
}
const classNames = (ids, classes) => (ids || []).map((id) => classes.find((c) => c.id === id)?.name).filter(Boolean);
function classPicker(classes, selected, onChange) {
  if (!classes.length) return h('p', { class: 'notice small' }, 'クラスがまだありません。上の「クラス」から作ってください。');
  return h('div', { class: 'row' }, classes.map((c) => {
    const cb = h('input', { type: 'checkbox', checked: selected.includes(c.id) });
    cb.addEventListener('change', () => onChange(cb.checked ? [...new Set([...selected, c.id])] : selected.filter((x) => x !== c.id)));
    return h('label', { class: 'row chk' }, cb, c.name, h('span', { class: 'small muted' }, `${(c.studentIds || []).length}人`));
  }));
}

// セットに含まれる問題を「テストID:問題ID」で1つの並びにする
function setItems(set, testsById) {
  const items = [];
  for (const tid of set.testIds || []) {
    const t = testsById[tid];
    if (t) for (const q of qItems(t)) items.push({ ...q, id: `${tid}:${q.id}`, qid: q.id });
  }
  return items;
}
function mergeScores(testIds, byTest) {
  const out = {};
  for (const tid of testIds) {
    for (const [uid, sc] of Object.entries(byTest[tid] || {})) {
      const m = (out[uid] = out[uid] || {});
      for (const [qid, v] of Object.entries(sc)) m[`${tid}:${qid}`] = v;
    }
  }
  return out;
}

// 複数テストの点数をリアルタイムで受け取る（Firestore の in は30件まで）
function watchScores(testIds, onData, onErr) {
  const byTest = {}, meta = {};
  if (!testIds.length) { onData(byTest, meta); return () => {}; }
  const unsubs = [];
  for (let i = 0; i < testIds.length; i += 30) {
    const ids = testIds.slice(i, i + 30);
    unsubs.push(onSnapshot(query(collection(db, 'scores'), where('testId', 'in', ids)), (snap) => {
      for (const id of ids) byTest[id] = {};
      for (const d of snap.docs) {
        const x = d.data();
        if (!byTest[x.testId]) continue;
        byTest[x.testId][x.uid] = x.scores || {};
        meta[`${x.testId}_${x.uid}`] = { date: x.date, updatedAt: x.updatedAt };
      }
      onData(byTest, meta);
    }, onErr));
  }
  return () => unsubs.forEach((u) => u());
}

// 共通テストの目標点（100点満点あたり）をテストの満点に換算
const kyotsuTarget = (goal, max) => (isNum(goal) && max > 0 ? Math.round(goal * max) / 100 : null);

// ---------------------------------------------------------------- 共通: 表示部品
function distributionView(values, max, mine, { unit = 'pt', note = '' } = {}) {
  if (!values.length) return h('p', { class: 'muted small' }, 'まだ比べられる記録がありません。');
  const bins = histogram(values, max, 10);
  const top = Math.max(...bins.map((b) => b.count));
  const my = mine !== null && mine !== undefined ? binOf(mine, max, 10) : -1;
  const lbl = (b, i) => (unit === 'rate'
    ? `${Math.round(b.lo * 100)}${i === 9 ? '〜100' : '〜'}%`
    : `${fmt(Math.round(b.lo * 10) / 10)}${i === 9 ? `〜${fmt(max)}` : '〜'}点`);
  const d = describe(values);
  return h('div', { class: 'dist' },
    [...bins.keys()].reverse().map((i) => {
      const b = bins[i];
      return h('div', { class: 'dist-row' + (i === my ? ' me' : '') },
        h('span', { class: 'dist-l num' }, lbl(b, i)),
        h('span', { class: 'dist-bar' }, h('span', { style: `width:${top ? (b.count / top) * 100 : 0}%` })),
        h('span', { class: 'dist-n num' }, `${b.count}人`),
        h('span', { class: 'dist-me' }, i === my ? 'あなた' : ''));
    }),
    h('p', { class: 'small muted' }, `${d.n}人${note} ・ 平均 ${unit === 'rate' ? pct(d.avg) : f1(d.avg) + '点'} ・ 最高 ${unit === 'rate' ? pct(d.max) : fmt(d.max) + '点'}`));
}

// 分野ごとの行（チップ = 各問題、右に合計・得点率・クラス平均・順位）
function fieldRowsView(fields, items, allScores, myScores, myUid, chipLabel) {
  const groups = fields.map((f) => ({ name: f.name, items: items.filter((it) => it.fieldId === f.id) }));
  const none = items.filter((it) => !fields.some((f) => f.id === it.fieldId));
  if (none.length) groups.push({ name: '分野なし', items: none });
  const shown = groups.filter((g) => g.items.length);
  if (!shown.length) return h('p', { class: 'muted small' }, '分野が設定された問題がありません。');
  // 選ばなかった選択問題は、満点・分母に入れない
  const skip = unchosenIds(items, myScores);
  return h('div', { class: 'fields' }, shown.map((grp) => {
    const g = evalGroup(grp.items, myScores);
    const chosen = grp.items.filter((it) => !skip.has(it.id));
    const myMax = evalGroup(chosen, {}).max;
    const fs = compare(grp.items, allScores, myUid, 'rate');
    const allSkipped = !chosen.length;
    return h('div', { class: 'frow' + (allSkipped ? ' skipped' : '') },
      h('div', { class: 'fname' }, h('b', null, grp.name), h('span', { class: 'small muted' }, allSkipped ? '選択していません' : `満点 ${fmt(myMax)}`)),
      h('div', { class: 'chips' }, grp.items.map((it) => {
        const v = validScore(it, myScores);
        const off = skip.has(it.id);
        return h('div', { class: 'chip' + (off ? ' unchosen' : v === null ? ' empty' : '') },
          h('div', { class: 'ch' }, chipLabel(it)),
          h('div', { class: 'cv' }, off ? h('span', { class: 'm' }, '未選択') : [v === null ? '' : fmt(v), h('span', { class: 'm' }, `/${fmt(it.max)}`)]));
      })),
      h('div', { class: 'fres' },
        h('div', { class: 'big' },
          h('span', { class: 'num' }, g.count ? `${fmt(g.sum)} / ${fmt(g.enteredMax)}` : allSkipped ? '—' : `— / ${fmt(myMax)}`, g.count && g.enteredMax < myMax ? h('span', { class: 'muted small' }, ` （満点 ${fmt(myMax)}）`) : null),
          h('span', { class: `v ${heat(g.rate)}` }, pct(g.rate))),
        h('div', { class: 'bar', 'aria-hidden': 'true' },
          g.count ? h('div', { class: 'fill', style: `width:${Math.min(100, g.rate * 100)}%` }) : null,
          fs.n ? h('div', { class: 'avg', style: `left:calc(${Math.min(100, fs.avg * 100)}% - 1px)` }) : null),
        h('div', { class: 'small muted' },
          fs.n ? `クラス平均 ${pct(fs.avg)}` : 'まだ比べられる記録がありません',
          fs.n && grp.items.some((it) => it.cg) ? `（記入した${fs.n}人）` : '',
          fs.rank ? ` ・ ${fs.rank}位 / ${fs.n}人` : '')));
  }));
}
const fieldLegend = () => h('div', { class: 'legend' }, h('span', null, h('i'), '得点率（記入済みの問題）'), h('span', null, h('i', { class: 'tick' }), 'クラス平均'));

function section(title, ...children) { return h('section', { class: 'card' }, h('h2', null, title), ...children); }
const pageHead = (eyebrow, title, sub, right) => h('div', { class: 'page-head' },
  h('div', null, h('div', { class: 'eyebrow' }, eyebrow), h('h1', null, title), sub ? h('p', { class: 'small muted' }, sub) : null), right || null);
const catPill = (x) => h('span', { class: 'pill ' + (isKyotsu(x) ? 'accent' : 'muted') }, CAT_SHORT[catOf(x)]);
const studentLine = (p) => `${p.studentNo ? '出席番号 ' + p.studentNo + '　' : ''}${p.displayName}`;

// 共通テストの目標点（生徒ごとに1つ）
function goalInput(uid, goal, onChange) {
  const el = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', value: isNum(goal) ? String(goal) : '', 'aria-label': '目標点（100点満点あたり）', id: 'kyotsu-goal' });
  let timer = null;
  const msg = h('span', { class: 'small muted' });
  const apply = () => {
    const raw = el.value.normalize('NFKC').trim(); const n = Number(raw);
    let v;
    if (raw === '') v = null; else if (Number.isFinite(n) && n >= 0 && n <= 100) v = n; else { msg.className = 'small err'; msg.textContent = '0〜100で入力してください'; return; }
    msg.className = 'small muted'; msg.textContent = '';
    onChange(v);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try { await setDoc(doc(db, 'goals', uid), { kyotsu: v, updatedAt: Date.now() }); msg.className = 'small ok'; msg.textContent = '保存しました'; }
      catch (e) { msg.className = 'small err'; msg.textContent = errMsg(e); }
    }, 700);
  };
  el.addEventListener('input', (e) => { if (!e.isComposing) apply(); });
  el.addEventListener('compositionend', apply);
  return h('span', { class: 'goal-input' }, el, h('span', { class: 'muted small' }, '点 / 100点'), msg);
}

// ---------------------------------------------------------------- student home
async function viewStudentHome() {
  const uid = S.user.uid;
  // 先生がクラスを変えたときに備えて、プロフィール（所属クラス）を読み直す
  const prof = await getDoc(doc(db, 'users', uid));
  if (prof.exists()) S.profile = prof.data();
  const [tests, sets, mySnap, goalSnap] = await Promise.all([
    loadAll('tests'), loadAll('sets'),
    getDocs(query(collection(db, 'scores'), where('uid', '==', uid))),
    getDoc(doc(db, 'goals', uid)),
  ]);
  const mine = Object.fromEntries(mySnap.docs.map((d) => [d.data().testId, d.data()]));
  const testsById = Object.fromEntries(tests.map((t) => [t.id, t]));
  let goal = goalSnap.exists() && isNum(goalSnap.data().kyotsu) ? goalSnap.data().kyotsu : null;
  let cat = loadCat();
  const counts = { kyotsu: tests.filter(isKyotsu).length, other: tests.filter((t) => !isKyotsu(t)).length };
  if (!counts[cat] && counts[cat === 'kyotsu' ? 'other' : 'kyotsu']) cat = cat === 'kyotsu' ? 'other' : 'kyotsu';
  const body = h('div', { class: 'stack' });

  function render() {
    const ts = tests.filter((t) => catOf(t) === cat);
    const ss = sets.filter((s) => catOf(s) === cat);
    const goalCard = cat === 'kyotsu' ? h('div', { class: 'card goal-card' },
      h('div', { class: 'row' }, h('h2', null, '共通テストの目標点'), goalInput(uid, goal, (v) => { goal = v; renderTests(); })),
      h('p', { class: 'small muted' }, '100点満点あたりの目標点を1つ決めます。すべての共通テストの結果がこの目標と比べられます（200点満点のテストなら2倍で判定）。')) : null;

    const setCards = ss.map((s) => {
      const items = setItems(s, testsById);
      const my = {};
      for (const tid of s.testIds || []) for (const [qid, v] of Object.entries((mine[tid] || {}).scores || {})) my[`${tid}:${qid}`] = v;
      const g = evalGroup(items, my);
      const done = (s.testIds || []).filter((tid) => testsById[tid] && evalGroup(qItems(testsById[tid]), (mine[tid] || {}).scores).complete).length;
      const total = (s.testIds || []).filter((tid) => testsById[tid]).length;
      return h('a', { class: 'card wb-card', href: `#/set/${s.id}` },
        h('div', { class: 'row' }, h('span', { class: 'pill' }, 'セット'), h('h3', null, s.title), h('span', { class: 'spacer' }), g.count ? h('span', { class: `pill ${heat(g.rate) === 'heat-lo' ? 'warn' : 'accent'}` }, `得点率 ${pct(g.rate)}`) : h('span', { class: 'pill muted' }, '未記入')),
        h('div', { class: 'progress', 'aria-hidden': 'true' }, h('div', { style: `width:${total ? (done / total) * 100 : 0}%` })),
        h('p', { class: 'small muted' }, `${done} / ${total} テスト 記入済み`));
    });

    const testTable = h('div', { class: 'tscroll' });
    function renderTests() {
      fill(testTable, ts.length ? h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'テスト'), h('th', { class: 'r' }, '得点'), h('th', { class: 'r' }, '得点率'), h('th', null, cat === 'kyotsu' ? '目標' : ''), h('th', null, '記入日'))),
        h('tbody', null, ts.map((t) => {
          const rec = mine[t.id] || {};
          const g = evalGroup(qItems(t), rec.scores);
          const target = cat === 'kyotsu' ? kyotsuTarget(goal, g.max) : null;
          return h('tr', null,
            h('td', null, h('a', { href: `#/test/${t.id}` }, t.title)),
            h('td', { class: 'r num' }, g.count ? `${fmt(g.sum)} / ${fmt(g.complete ? g.max : g.enteredMax)}` : '—', g.count && !g.complete ? h('span', { class: 'muted small' }, ' 途中') : ''),
            h('td', { class: `r num ${heat(g.rate)}` }, pct(g.rate)),
            h('td', null, cat === 'kyotsu' && g.complete && target !== null ? (g.sum >= target ? h('span', { class: 'pill good' }, '達成') : h('span', { class: 'pill warn' }, `あと${fmt(Math.round((target - g.sum) * 10) / 10)}`)) : ''),
            h('td', { class: 'num small muted' }, rec.date || '—'));
        }))) : h('p', { class: 'muted', style: 'padding:14px' }, 'まだテストがありません。先生がテストを公開すると、ここに表示されます。'));
    }
    renderTests();
    fill(body,
      goalCard,
      ss.length ? h('section', { class: 'stack' }, h('h2', null, 'セット'), h('div', { class: 'wb-list' }, setCards)) : null,
      h('section', { class: 'stack' }, h('h2', null, 'テスト'), testTable));
  }

  mount(
    pageHead(`出席番号 ${S.profile.studentNo}　${S.profile.displayName}`, '自分の得点表'),
    !(S.profile.classIds || []).length ? h('p', { class: 'notice warn' }, 'まだクラスに登録されていません。先生にクラスへの登録を頼んでください。登録されると、そのクラスのテストが表示されます。') : null,
    catTabs(cat, counts, (k) => { cat = k; render(); }),
    body);
  render();
}

// ---------------------------------------------------------------- テスト（記入・閲覧・修正・プレビュー）
// mode: 'student' / 'teacher-view' / 'teacher-edit' / 'preview'
const PREVIEW_UID = '__preview__';
async function viewTest(testId, uid, mode) {
  const tSnap = await getDoc(doc(db, 'tests', testId));
  if (!tSnap.exists()) throw Object.assign(new Error(), { code: 'not-found' });
  const test = { id: testId, ...tSnap.data() };
  const kyotsu = isKyotsu(test);
  const isPreview = mode === 'preview';
  const teacherMode = mode === 'teacher-view' || mode === 'teacher-edit';
  const canScores = mode !== 'teacher-view';
  const canNotes = mode === 'student' || isPreview;
  const items = qItems(test);
  const max = testMax(test);
  const scoreRef = doc(db, 'scores', `${testId}_${uid}`);
  const noteRef = doc(db, 'notes', `${testId}_${uid}`);
  const [fields, sets, classes, sSnap, nSnap, gSnap, pSnap] = await Promise.all([
    loadFields(catOf(test)),
    loadAll('sets'),
    loadClasses(),
    isPreview ? null : getDoc(scoreRef),
    isPreview ? null : getDoc(noteRef),
    isPreview || !kyotsu ? null : getDoc(doc(db, 'goals', uid)),
    teacherMode ? getDoc(doc(db, 'users', uid)) : null,
  ]);
  const who = isPreview ? { displayName: 'プレビュー（保存されません）' } : teacherMode ? (pSnap.exists() ? pSnap.data() : { displayName: '（削除されたユーザー）' }) : S.profile;
  const sd = sSnap && sSnap.exists() ? sSnap.data() : {};
  const nd = nSnap && nSnap.exists() ? nSnap.data() : {};
  const st = {
    scores: { ...(sd.scores || {}) }, date: sd.date || '',
    choices: JSON.parse(JSON.stringify(sd.choices || {})),
    target: isNum(nd.target) ? nd.target : null, memo: nd.memo || '',
    goal: gSnap && gSnap.exists() && isNum(gSnap.data().kyotsu) ? gSnap.data().kyotsu : null,
    others: {},
  };
  const fieldName = Object.fromEntries(fields.map((f) => [f.id, f.name]));
  const inSets = sets.filter((s) => (s.testIds || []).includes(testId));
  const peers = peersOf(test, isPreview ? null : (who.classIds || []), classes);

  // ---- 保存
  const saveEl = h('span', { class: 'save-state muted' },
    isPreview ? 'プレビュー: 入力は保存されません' : mode === 'teacher-view' ? '閲覧のみ' : mode === 'teacher-edit' ? '先生による修正: 自動で保存されます' : '自動で保存されます');
  const setSave = (state, text) => {
    if (isPreview) return;
    saveEl.className = 'save-state ' + (state === 'error' ? 'err' : state === 'saved' ? 'ok' : 'muted');
    saveEl.textContent = text;
  };
  let scoreTimer = null, noteTimer = null;
  async function saveScores() {
    clearTimeout(scoreTimer); scoreTimer = null;
    st.date = Object.keys(st.scores).length ? today() : '';
    if (isPreview) return;
    setSave('saving', '保存中…');
    try {
      await setDoc(scoreRef, { testId, uid, scores: st.scores, choices: st.choices, date: st.date, updatedAt: Date.now() });
      setSave('saved', '保存しました');
    } catch (e) { setSave('error', '保存できませんでした: ' + errMsg(e)); }
  }
  async function saveNotes() {
    clearTimeout(noteTimer); noteTimer = null;
    if (isPreview) return;
    setSave('saving', '保存中…');
    try {
      await setDoc(noteRef, { testId, uid, target: st.target, memo: st.memo, updatedAt: Date.now() });
      setSave('saved', '保存しました');
    } catch (e) { setSave('error', '保存できませんでした: ' + errMsg(e)); }
  }
  const queueScores = () => { setSave('dirty', '入力中…'); clearTimeout(scoreTimer); scoreTimer = setTimeout(saveScores, 700); };
  const queueNotes = () => { setSave('dirty', '入力中…'); clearTimeout(noteTimer); noteTimer = setTimeout(saveNotes, 900); };
  const onBeforeUnload = (e) => { if (!isPreview && (scoreTimer || noteTimer)) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  S.cleanups.push(() => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    if (scoreTimer) saveScores();
    if (noteTimer) saveNotes();
  });

  // ---- 入力欄（全角数字・日本語入力の確定にも対応。Enter で次の欄へ）
  const avgEls = {};
  function scoreInput(item, disabled) {
    const v = validScore(item, st.scores);
    if (!canScores) return h('span', { class: 'val' }, v === null ? '—' : fmt(v));
    const inp = h('input', {
      type: 'text', inputmode: 'decimal', enterkeyhint: 'next', autocomplete: 'off', disabled: !!disabled,
      placeholder: disabled ? '未選択' : '',
      value: v === null ? '' : String(v), 'aria-label': `${item.label || ''} ${fieldName[item.fieldId] || ''} 得点（満点${item.max}）`,
    });
    const apply = () => {
      const raw = inp.value.normalize('NFKC').trim();
      if (raw === '') { if (!(item.id in st.scores)) return; delete st.scores[item.id]; inp.classList.remove('invalid'); }
      else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0 || n > item.max) { inp.classList.add('invalid'); inp.title = `0〜${item.max}で入力してください`; return; }
        inp.classList.remove('invalid'); inp.title = '';
        if (st.scores[item.id] === n) return;
        st.scores[item.id] = n;
      }
      recompute(); queueScores();
    };
    inp.addEventListener('input', (e) => { if (!e.isComposing) apply(); });
    inp.addEventListener('compositionend', apply);
    inp.addEventListener('change', apply);
    inp.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault(); apply();
      const all = [...document.querySelectorAll('.item-body input:not(:disabled)')];
      const next = all[all.indexOf(inp) + 1];
      if (next) next.focus(); else inp.blur();
    });
    return inp;
  }
  const itemBox = (it, disabled) => {
    avgEls[it.id] = avgEls[it.id] || h('div', { class: 'item-avg' });
    return h('div', { class: 'item' + (disabled ? ' off' : '') },
      h('div', { class: 'item-head' }, it.label ? h('span', { class: 'qno' }, it.label) : null, h('span', null, fieldName[it.fieldId] || '')),
      h('div', { class: 'item-body' }, scoreInput(it, disabled), h('span', { class: 'max' }, `/${fmt(it.max)}`)),
      avgEls[it.id]);
  };
  // ---- 選択問題: 大問ごとに「選択する」チェック。選べる数に達したら他は選べない
  const groupDefs = test.choiceGroups || [];
  function choiceGroupView(g) {
    const box = h('div', { class: 'choice-group' });
    const gItems = items.filter((it) => it.cg === `${testId}:${g.id}`);
    const blocks = [];
    for (const it of gItems) { let b = blocks.find((x) => x.key === it.block); if (!b) blocks.push((b = { key: it.block, items: [] })); b.items.push(it); }
    const pick = Math.min(Number(g.pick) || 1, blocks.length);
    const selected = () => {
      const set = new Set((st.choices[g.id] || []).filter((k) => blocks.some((b) => b.key === k)));
      for (const b of blocks) if (b.items.some((it) => validScore(it, st.scores) !== null)) set.add(b.key);
      return set;
    };
    function draw() {
      const sel = selected();
      fill(box,
        h('div', { class: 'row' }, h('b', null, g.name || '選択問題'),
          h('span', { class: 'pill accent' }, `${blocks.length}つの大問から${pick}つ選択`),
          h('span', { class: 'small ' + (sel.size === pick ? 'ok' : 'muted') }, `選択中 ${sel.size} / ${pick}`)),
        blocks.map((b) => {
          const on = sel.has(b.key);
          const cb = h('input', { type: 'checkbox', checked: on, disabled: !canScores || (!on && sel.size >= pick), 'aria-label': `${blockName(b.key)}を選択` });
          cb.addEventListener('change', () => {
            const cur = selected();
            if (cb.checked) { if (cur.size >= pick) { cb.checked = false; return; } cur.add(b.key); }
            else {
              cur.delete(b.key);
              let cleared = false;
              for (const it of b.items) if (it.id in st.scores) { delete st.scores[it.id]; cleared = true; }
              if (cleared) toast(`${blockName(b.key)}の点数を消しました`);
            }
            st.choices[g.id] = [...cur];
            draw(); recompute(); queueScores();
          });
          const bMax = b.items.reduce((a, it) => a + it.max, 0);
          return h('div', { class: 'choice-block' + (on ? '' : ' off') },
            h('label', { class: 'row small choice-head' }, cb, h('b', null, blockName(b.key)), h('span', { class: 'muted' }, `（${fmt(bMax)}点）`), on ? h('span', { class: 'pill good' }, '選択') : null),
            h('div', { class: 'items qgrid' }, b.items.map((it) => itemBox(it, !on))));
        }));
    }
    draw();
    return box;
  }
  const requiredItems = items.filter((it) => !it.cg);
  const questionGrid = h('div', { class: 'stack', style: 'gap:12px' },
    !items.length ? h('p', { class: 'muted small' }, 'このテストにはまだ問題がありません。') : null,
    requiredItems.length ? h('div', { class: 'items qgrid' }, requiredItems.map((it) => itemBox(it, false))) : null,
    groupDefs.filter((g) => items.some((it) => it.cg === `${testId}:${g.id}`)).map(choiceGroupView));
  const totalEl = h('div', { class: 'subtotal big-total' });

  // ---- 目標・メモ
  const numberInput = (value, label, onValue) => {
    const el = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', value: isNum(value) ? String(value) : '', 'aria-label': label });
    const apply = () => { const raw = el.value.normalize('NFKC').trim(); const n = Number(raw); if (raw === '') onValue(null); else if (Number.isFinite(n) && n >= 0) onValue(n); };
    el.addEventListener('input', (e) => { if (!e.isComposing) apply(); });
    el.addEventListener('compositionend', apply);
    return el;
  };
  let targetBox;
  if (kyotsu) {
    targetBox = h('div', { class: 'target' }, h('span', { class: 'label' }, '目標（全体の目標から換算）'), h('span', { class: 'num', id: 'test-target' }));
  } else {
    const el = canNotes ? numberInput(st.target, '目標点', (n) => { st.target = n; recompute(); queueNotes(); }) : h('span', { class: 'num' }, isNum(st.target) ? fmt(st.target) : '—');
    targetBox = h('label', { class: 'target' }, h('span', { class: 'label' }, '目標点'), h('span', { class: 'row', style: 'gap:4px' }, el, `点 / ${fmt(max)}点`));
  }
  let memoEl;
  if (canNotes) {
    memoEl = h('textarea', { rows: 3, maxlength: 1000, placeholder: '振り返り・メモ（間違えた原因、次にやること など）', 'aria-label': '振り返り・メモ' });
    memoEl.value = st.memo;
    memoEl.addEventListener('input', () => { st.memo = memoEl.value; queueNotes(); });
  } else memoEl = h('div', { class: 'memo-text' }, st.memo || h('span', { class: 'muted' }, '（メモなし）'));

  // ---- まとめ・分野・分布
  const T = {};
  const tile = (key, label) => { T[key] = h('span', { class: 'v' }); return h('div', { class: 'tile' }, h('span', { class: 'label' }, label), T[key]); };
  const tiles = h('div', { class: 'tiles' }, tile('score', '得点'), tile('rate', '得点率'), tile('goal', '目標'), tile('avg', 'クラス平均'), tile('rank', '順位'), tile('dev', '偏差値'));
  const fieldsBox = h('div');
  const distBox = h('div');

  function recompute() {
    const all = { ...st.others };
    if (Object.keys(st.scores).length) all[uid] = st.scores;
    const me = evalGroup(items, st.scores);
    const cmp = compare(items, all, uid, 'complete');
    for (const it of items) {
      const vals = Object.values(all).map((sc) => validScore(it, sc)).filter((v) => v !== null);
      avgEls[it.id].textContent = vals.length ? `平均 ${f1(vals.reduce((a, b) => a + b, 0) / vals.length)}` : '';
    }
    fill(totalEl, h('span', { class: 'k' }, '合計'), h('span', { class: 'v' + (me.count && !me.complete ? ' partial' : '') }, me.count ? fmt(me.sum) : ''), h('span', { class: 'm' }, `/${fmt(max)}`));
    const target = kyotsu ? kyotsuTarget(st.goal, max) : st.target;
    const tEl = document.getElementById('test-target');
    if (tEl) tEl.textContent = target === null ? (kyotsu ? '未設定（ホームで設定）' : '—') : `${fmt(target)}点`;
    fill(T.score, me.count ? fmt(me.sum) : '—', h('small', null, `/ ${fmt(max)}`), me.count && !me.complete ? h('small', null, '（記入途中）') : '');
    fill(T.rate, pct(me.rate));
    fill(T.goal, target === null ? '—' : fmt(target),
      target === null ? '' : !me.complete ? h('small', null, '点') : me.sum >= target ? h('span', { class: 'pill good' }, '達成') : h('span', { class: 'pill warn' }, `あと${fmt(Math.round((target - me.sum) * 10) / 10)}点`));
    fill(T.avg, cmp.n ? f1(cmp.avg) : '—', cmp.n ? h('small', null, `点（${cmp.n}人）`) : '');
    fill(T.rank, cmp.rank ? String(cmp.rank) : '—', cmp.rank ? h('small', null, `位 / ${cmp.n}人`) : '');
    T.dev.textContent = cmp.mine !== null && cmp.n > 1 ? f1(deviation(cmp.mine, cmp)) : '—';
    fill(fieldsBox, fieldLegend(), fieldRowsView(fields, items, all, st.scores, uid, (it) => it.label || '問題'));
    fill(distBox, distributionView(cmp.values, max, cmp.mine, { note: '（全問記入した人）' }));
  }

  S.cleanups.push(onSnapshot(query(collection(db, 'scores'), where('testId', '==', testId)), (snap) => {
    const others = {};
    for (const d of snap.docs) {
      const x = d.data();
      if (x.uid === uid) { if (mode === 'teacher-view') { st.scores = { ...(x.scores || {}) }; st.date = x.date || ''; } continue; }
      if (!peers.has(x.uid)) continue;
      others[x.uid] = x.scores || {};
    }
    st.others = others;
    recompute();
  }, (e) => setSave('error', '集計を読み込めませんでした: ' + errMsg(e))));

  const back = isPreview ? h('a', { href: '#/' }, '← 得点表の管理') : teacherMode ? h('a', { href: `#/t/test/${testId}/results` }, '← 成績一覧') : h('a', { href: '#/' }, '← 自分の得点表');
  const sw = mode === 'teacher-view' ? h('a', { class: 'btn small', href: `#/t/test/${testId}/u/${uid}/edit` }, 'この生徒の点数を修正する')
    : mode === 'teacher-edit' ? h('a', { class: 'btn small', href: `#/t/test/${testId}/u/${uid}` }, '修正を終える') : null;
  mount(
    pageHead(h('span', null, back, '　', catPill(test)), test.title, teacherMode || isPreview ? `${studentLine(who)} さんの記録` : studentLine(who), h('div', { class: 'row' }, sw, saveEl)),
    isPreview ? h('p', { class: 'notice warn small' }, '生徒の画面のプレビューです。点数を入れて動きを確かめられますが、保存されず、集計にも入りません。') : null,
    test.description ? h('p', { class: 'notice' }, test.description) : null,
    inSets.length ? h('p', { class: 'small' }, 'このテストを含むセット: ', inSets.map((s, i) => [i ? '、' : '', h('a', { href: teacherMode ? `#/t/set/${s.id}/u/${uid}` : isPreview ? `#/t/set/${s.id}/results` : `#/set/${s.id}` }, s.title)])) : null,
    tiles,
    h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', null, '得点の記入'), h('span', { class: 'spacer' }), st.date ? h('span', { class: 'small muted' }, `記入日 ${st.date}`) : null),
      h('div', { class: 'qwrap' }, questionGrid, totalEl),
      canScores ? h('p', { class: 'small muted' }, '問題ごとに点数を入れると自動で保存されます（Enter で次の欄へ）。') : null),
    h('section', { class: 'card' }, h('h2', null, '目標と振り返り'), targetBox, h('div', { class: 'memo field' }, memoEl)),
    section('分野別の結果', fieldsBox),
    section('得点分布', distBox),
  );
  recompute();
}

// ---------------------------------------------------------------- セット（テストのまとまり）
async function viewSet(setId, uid, mode) {
  const sSnap = await getDoc(doc(db, 'sets', setId));
  if (!sSnap.exists()) throw Object.assign(new Error(), { code: 'not-found' });
  const set = { id: setId, ...sSnap.data() };
  const kyotsu = isKyotsu(set);
  const teacherMode = mode === 'teacher-view';
  const [fields, tests, classes, gSnap, pSnap] = await Promise.all([
    loadFields(catOf(set)), loadAll('tests'), loadClasses(),
    kyotsu ? getDoc(doc(db, 'goals', uid)) : null,
    teacherMode ? getDoc(doc(db, 'users', uid)) : null,
  ]);
  const who = teacherMode ? (pSnap.exists() ? pSnap.data() : { displayName: '（削除されたユーザー）' }) : S.profile;
  const goal = gSnap && gSnap.exists() && isNum(gSnap.data().kyotsu) ? gSnap.data().kyotsu : null;
  const testsById = Object.fromEntries(tests.map((t) => [t.id, t]));
  const members = (set.testIds || []).map((id) => testsById[id]).filter(Boolean);
  const items = setItems(set, testsById);
  const peers = peersOf(set, who.classIds || [], classes);
  peers.add(uid);
  const onlyPeers = (scoresByUid) => Object.fromEntries(Object.entries(scoresByUid || {}).filter(([u]) => peers.has(u)));

  const T = {};
  const tile = (key, label) => { T[key] = h('span', { class: 'v' }); return h('div', { class: 'tile' }, h('span', { class: 'label' }, label), T[key]); };
  const tiles = h('div', { class: 'tiles' }, tile('done', '記入済みのテスト'), tile('rate', '得点率（記入済み）'), tile('total', 'セット合計（記入済み）'), kyotsu ? tile('goal', '目標を達成したテスト') : null, tile('avg', 'クラス平均の得点率'), tile('rank', '順位（得点率）'), tile('dev', '偏差値'));
  const tableBox = h('div', { class: 'tscroll' });
  const fieldsBox = h('div');
  const distBox = h('div');

  function render(rawByTest, meta) {
    const byTest = Object.fromEntries(Object.entries(rawByTest).map(([t, m]) => [t, onlyPeers(m)]));
    const all = mergeScores(members.map((t) => t.id), byTest);
    const my = all[uid] || {};
    const me = evalGroup(items, my);
    const cmpRate = compare(items, all, uid, 'rate');
    const cmpTotal = compare(items, all, uid, 'complete');
    let done = 0, achieved = 0;
    const rows = members.map((t) => {
      const ti = qItems(t);
      const sc = (byTest[t.id] || {})[uid] || {};
      const g = evalGroup(ti, sc);
      const c = compare(ti, byTest[t.id] || {}, uid, 'complete');
      const target = kyotsu ? kyotsuTarget(goal, g.max) : null;
      if (g.complete) { done++; if (target !== null && g.sum >= target) achieved++; }
      return h('tr', null,
        h('td', null, h('a', { href: teacherMode ? `#/t/test/${t.id}/u/${uid}` : `#/test/${t.id}` }, t.title)),
        h('td', { class: 'r num' }, g.count ? fmt(g.sum) : '—', g.count && !g.complete ? '*' : '', h('span', { class: 'muted' }, ` / ${fmt(g.max)}`)),
        h('td', { class: `r num ${heat(g.rate)}` }, pct(g.rate)),
        h('td', { class: 'r num' }, c.n ? f1(c.avg) : '—'),
        h('td', { class: 'r num' }, c.rank ? `${c.rank} / ${c.n}` : '—'),
        kyotsu ? h('td', null, g.complete && target !== null ? (g.sum >= target ? h('span', { class: 'pill good' }, '達成') : h('span', { class: 'pill warn' }, `あと${fmt(Math.round((target - g.sum) * 10) / 10)}`)) : '') : null,
        h('td', { class: 'num small muted' }, (meta[`${t.id}_${uid}`] || {}).date || '—'));
    });
    fill(tableBox, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'テスト'), h('th', { class: 'r' }, '得点'), h('th', { class: 'r' }, '得点率'), h('th', { class: 'r' }, '平均点'), h('th', { class: 'r' }, '順位'), kyotsu ? h('th', null, '目標') : null, h('th', null, '記入日'))),
      h('tbody', null, rows.length ? rows : h('tr', null, h('td', { class: 'muted' }, 'このセットにはまだテストがありません。')))));
    fill(T.done, String(done), h('small', null, `/ ${members.length}`));
    fill(T.rate, pct(me.rate), me.count ? h('small', null, `${fmt(me.sum)}/${fmt(me.enteredMax)}`) : '');
    const myMax = evalGroup(items.filter((it) => !unchosenIds(items, my).has(it.id)), {}).max;
    fill(T.total, me.count ? fmt(me.sum) : '—', h('small', null, `/ ${fmt(me.count ? me.enteredMax : myMax)}`),
      me.count && me.enteredMax < myMax ? h('small', null, `（満点 ${fmt(myMax)}）`) : null,
      me.complete && cmpTotal.rank ? h('small', null, ` ${cmpTotal.rank}位`) : null);
    if (T.goal) fill(T.goal, isNum(goal) ? String(achieved) : '—', isNum(goal) ? h('small', null, `/ ${done}`) : h('small', null, '目標点が未設定'));
    fill(T.avg, cmpRate.n ? pct(cmpRate.avg) : '—', cmpRate.n ? h('small', null, `${cmpRate.n}人`) : '');
    fill(T.rank, cmpRate.rank ? String(cmpRate.rank) : '—', cmpRate.rank ? h('small', null, `位 / ${cmpRate.n}人`) : '');
    T.dev.textContent = cmpRate.mine !== null && cmpRate.n > 1 ? f1(deviation(cmpRate.mine, cmpRate)) : '—';
    fill(fieldsBox, fieldLegend(), fieldRowsView(fields, items, all, my, uid, (it) => `${it.testTitle}${it.label ? ' ' + it.label : ''}`));
    fill(distBox, distributionView(cmpRate.values, 1, cmpRate.mine, { unit: 'rate', note: '（1問以上記入した人・得点率）' }));
  }
  S.cleanups.push(watchScores(members.map((t) => t.id), render, (e) => toast(errMsg(e))));

  mount(
    pageHead(h('span', null, teacherMode ? h('a', { href: `#/t/set/${setId}/results` }, '← セットの成績一覧') : h('a', { href: '#/' }, '← 自分の得点表'), '　', catPill(set), ' ', h('span', { class: 'pill' }, 'セット')),
      set.title, teacherMode ? `${studentLine(who)} さんの記録` : studentLine(who)),
    set.description ? h('p', { class: 'notice' }, set.description) : null,
    tiles,
    section('テストごとの結果', tableBox, h('p', { class: 'small muted' }, '「*」は記入途中のテストです。平均点・順位は全問記入した人どうしで比べます。')),
    section('分野別チェック（セット全体）', fieldsBox),
    section('得点率の分布（セット全体）', distBox),
  );
}

// ---------------------------------------------------------------- teacher: home
async function viewTeacherHome() {
  const [tests, sets, classes, oldWbs] = await Promise.all([
    loadAll('tests'), loadAll('sets'), loadClasses(),
    getDocs(collection(db, 'workbooks')).then(docsOf).catch(() => []),
  ]);
  const legacy = oldWbs.filter((w) => !w.migratedAt);
  let cat = loadCat();
  const mine = myTeachingIds(classes);
  // 表示するクラス: 担当クラス（mine）／すべて（all）／クラスID／配信先なし（none）
  let clsFilter = (() => { try { return localStorage.getItem('clsFilter') || ''; } catch (e) { return ''; } })();
  if (!clsFilter || (!['mine', 'all', 'none'].includes(clsFilter) && !classes.some((c) => c.id === clsFilter)) || (clsFilter === 'mine' && !mine.length)) clsFilter = mine.length ? 'mine' : 'all';
  const matches = (x) => {
    const ids = x.classIds || [];
    if (clsFilter === 'all') return true;
    if (clsFilter === 'none') return !ids.length;
    if (clsFilter === 'mine') return ids.some((c) => mine.includes(c));
    return ids.includes(clsFilter);
  };
  const newClassIds = () => (clsFilter === 'mine' ? [...mine] : ['all', 'none'].includes(clsFilter) ? [] : [clsFilter]);
  const body = h('div', { class: 'stack' });
  const tabsBox = h('div');

  async function createTest(title) {
    const ref = await addDoc(collection(db, 'tests'), { title, description: '', category: cat, published: false, classIds: newClassIds(), visibleTo: [], questions: [], createdAt: Date.now(), updatedAt: Date.now() });
    location.hash = `#/t/test/${ref.id}/edit`;
  }
  async function createSet(title) {
    const ref = await addDoc(collection(db, 'sets'), { title, description: '', category: cat, published: false, classIds: newClassIds(), visibleTo: [], testIds: [], createdAt: Date.now(), updatedAt: Date.now() });
    location.hash = `#/t/set/${ref.id}/edit`;
  }
  const createRow = (placeholder, label, fn) => {
    const inp = h('input', { type: 'text', maxlength: 60, placeholder, style: 'flex:1;min-width:12em' });
    const msg = h('span', { class: 'err small' });
    const btn = h('button', { class: 'btn primary', type: 'button' }, label);
    btn.onclick = async () => {
      const t = inp.value.trim();
      if (!t) { msg.textContent = '名前を入力してください。'; return; }
      btn.disabled = true;
      try { await fn(t); } catch (e) { msg.textContent = errMsg(e); btn.disabled = false; }
    };
    return h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'row' }, inp, btn), msg);
  };
  const pubToggle = (col, x) => {
    const b = h('button', { class: 'btn small', type: 'button' }, x.published ? '非公開にする' : '生徒に公開する');
    b.onclick = async () => {
      b.disabled = true;
      if (!x.published && !(x.classIds || []).length) { toast('配信するクラスを選んでから公開してください（「編集」から選べます）'); return; }
      try { await updateDoc(doc(db, col, x.id), { published: !x.published, visibleTo: visibleFor(!x.published, x.classIds), updatedAt: Date.now() }); route(); }
      catch (e) { toast(errMsg(e)); b.disabled = false; }
    };
    return b;
  };
  const pubPill = (x) => (x.published ? h('span', { class: 'pill good' }, '公開中') : h('span', { class: 'pill warn' }, '非公開（生徒には見えません）'));

  const classCell = (x) => {
    const names = classNames(x.classIds, classes);
    return h('td', { class: 'small wrap' }, names.length ? names.join('、') : h('span', { class: 'pill warn' }, 'クラス未選択'));
  };
  function render() {
    const ts = tests.filter((t) => catOf(t) === cat && matches(t));
    const ss = sets.filter((s) => catOf(s) === cat && matches(s));
    const testsById = Object.fromEntries(tests.map((t) => [t.id, t]));
    const counts = { kyotsu: tests.filter((t) => isKyotsu(t) && matches(t)).length, other: tests.filter((t) => !isKyotsu(t) && matches(t)).length };
    fill(tabsBox, catTabs(cat, counts, (k) => { cat = k; render(); }));
    fill(body,
      !classes.length ? h('div', { class: 'card notice warn' }, h('h2', null, 'まずクラスを作りましょう'),
        h('p', { class: 'small' }, 'テストやセットは、配信するクラスの生徒にだけ表示されます。'), h('div', null, h('a', { class: 'btn primary', href: '#/t/classes' }, 'クラスを作る'))) : null,
      legacy.length ? h('div', { class: 'card notice warn' },
        h('h2', null, '以前の形式の得点表があります'),
        h('p', { class: 'small' }, `${legacy.map((w) => w.title).join('、')} を新しい形式（テスト＋セット）に変換できます。回は1つずつのテストに、得点表の中のセットは「セット」に変換され、記入済みの点数も引き継がれます（目標・メモは引き継がれません）。`),
        h('div', null, confirmButton('新しい形式に変換する', 'もう一度押すと変換を始めます', () => migrateLegacy(legacy), 'btn primary'))) : null,
      fieldListEditor(cat),
      h('section', { class: 'card' },
        h('h2', null, 'セット'),
        h('p', { class: 'small muted' }, 'テストをまとめたものです（例: 「セット1」＝第1回＋第2回、「数学ⅠA 全体」＝第1回〜第14回）。セットごとに分野別の統計と得点率の分布が出ます。'),
        createRow('例: セット1', 'セットを作る', createSet),
        ss.length ? h('div', { class: 'tscroll' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'セット'), h('th', null, 'テスト'), h('th', null, '配信先'), h('th', null, '状態'), h('th', null, '操作'))),
          h('tbody', null, ss.map((s) => h('tr', null,
            h('td', null, h('b', null, s.title)),
            h('td', { class: 'small wrap' }, (() => {
              const names = (s.testIds || []).map((id) => testsById[id]?.title).filter(Boolean);
              if (!names.length) return h('span', { class: 'muted' }, 'なし');
              return names.length <= 3 ? names.join('、') : `${names.length}件（${names[0]} 〜 ${names[names.length - 1]}）`;
            })()),
            classCell(s),
            h('td', null, pubPill(s)),
            h('td', { class: 'row', style: 'flex-wrap:nowrap' },
              h('a', { class: 'btn primary small', href: `#/t/set/${s.id}/results` }, '成績'),
              h('a', { class: 'btn small', href: `#/t/set/${s.id}/edit` }, '編集'),
              pubToggle('sets', s))))))) : h('p', { class: 'muted small' }, 'まだセットがありません。')),
      h('section', { class: 'card' },
        h('h2', null, 'テスト'),
        h('p', { class: 'small muted' }, '1回分のテスト（問題番号・分野・配点）です。「複製」で同じ構成のテストを作れます（名前の数字は自動で次の番号になります）。公開すると生徒が記入できます。'),
        createRow(cat === 'kyotsu' ? '例: 第1回 数学Ⅰ・A' : '例: 二次対策 数学 演習1', 'テストを作る', createTest),
        ts.length ? h('div', { class: 'tscroll' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'テスト'), h('th', { class: 'r' }, '問題数'), h('th', { class: 'r' }, '満点'), h('th', null, '配信先'), h('th', null, '状態'), h('th', null, '操作'))),
          h('tbody', null, ts.map((t) => h('tr', null,
            h('td', null, h('b', null, t.title)),
            h('td', { class: 'r num' }, (t.questions || []).length),
            h('td', { class: 'r num' }, fmt(testMax(t))),
            classCell(t),
            h('td', null, pubPill(t)),
            h('td', { class: 'row', style: 'flex-wrap:nowrap' },
              h('a', { class: 'btn primary small', href: `#/t/test/${t.id}/results` }, '成績'),
              h('a', { class: 'btn small', href: `#/t/test/${t.id}/edit` }, '編集'),
              h('a', { class: 'btn small', href: `#/t/test/${t.id}/preview` }, '試す'),
              h('button', { class: 'btn small', type: 'button', onclick: () => duplicateTest(t, tests) }, '複製'),
              pubToggle('tests', t))))))) : h('p', { class: 'muted small' }, 'まだテストがありません。')));
  }

  const clsSel = h('select', { id: 'cls-filter', 'aria-label': '表示するクラス' },
    mine.length ? h('option', { value: 'mine', selected: clsFilter === 'mine' }, '担当クラス') : null,
    h('option', { value: 'all', selected: clsFilter === 'all' }, 'すべてのクラス'),
    classes.map((c) => h('option', { value: c.id, selected: clsFilter === c.id }, c.name)),
    h('option', { value: 'none', selected: clsFilter === 'none' }, 'クラス未選択のもの'));
  clsSel.onchange = () => { clsFilter = clsSel.value; try { localStorage.setItem('clsFilter', clsFilter); } catch (e) { /* noop */ } render(); };
  mount(
    pageHead('先生用', '得点表の管理', null, h('div', { class: 'row' }, h('label', { class: 'label', for: 'cls-filter' }, '表示するクラス'), clsSel, h('a', { class: 'btn small', href: '#/t/classes' }, 'クラスの管理'))),
    tabsBox,
    body);
  render();
}

// 「第1回 数学」→「第2回 数学」のように、名前の中の最後の数字を空いている次の番号にする
function nextTitle(title, existing) {
  const m = title.match(/^(.*?)(\d+)(\D*)$/);
  if (!m) return `${title}（コピー）`;
  let n = Number(m[2]) + 1;
  while (existing.includes(`${m[1]}${n}${m[3]}`)) n++;
  return `${m[1]}${n}${m[3]}`;
}
async function duplicateTest(t, all) {
  try {
    const ref = await addDoc(collection(db, 'tests'), {
      title: nextTitle(t.title, all.map((x) => x.title)).slice(0, 60), description: t.description || '', category: catOf(t), published: false,
      classIds: [...(t.classIds || [])], visibleTo: [],
      questions: (t.questions || []).map((q) => ({ ...q })), choiceGroups: (t.choiceGroups || []).map((g) => ({ ...g })), createdAt: Date.now(), updatedAt: Date.now(),
    });
    toast('複製しました（非公開で作成しています）');
    location.hash = `#/t/test/${ref.id}/edit`;
  } catch (e) { toast(errMsg(e)); }
}

// ---------------------------------------------------------------- teacher: 分野リスト（タブ全体で共通）
function fieldListEditor(cat) {
  const box = h('div', { class: 'ed-fields' });
  const msg = h('span', { class: 'small' });
  let fields = [];
  let dirty = false;
  const card = h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', null, `分野（${CAT_SHORT[cat]}で共通）`)),
    h('p', { class: 'small muted' }, `ここで決めた分野を、${CAT_SHORT[cat]}のすべてのテストで使います。分野名を変えると、すべてのテストと集計に反映されます。`),
    box,
    h('div', { class: 'row' },
      h('button', { class: 'btn small', type: 'button', onclick: () => { fields.push({ id: rid('f_'), name: '' }); dirty = true; render(); box.querySelector('.ed-field:last-child input')?.focus(); } }, '＋ 分野を追加'),
      h('button', { class: 'btn small primary', type: 'button', onclick: save }, '分野を保存'), msg));
  function render() {
    fill(box, fields.length ? fields.map((f, i) => {
      const inp = h('input', { type: 'text', value: f.name, maxlength: 30, placeholder: '分野名（例: 2次関数）', 'aria-label': '分野名' });
      inp.addEventListener('input', () => { f.name = inp.value; dirty = true; msg.className = 'small err'; msg.textContent = '未保存の変更があります'; });
      const mv = (d) => { const j = i + d; if (j < 0 || j >= fields.length) return; [fields[i], fields[j]] = [fields[j], fields[i]]; dirty = true; render(); };
      return h('div', { class: 'ed-field' }, inp, h('span'),
        h('button', { class: 'btn small', type: 'button', onclick: () => mv(-1), 'aria-label': '上へ' }, '↑'),
        h('button', { class: 'btn small', type: 'button', onclick: () => mv(1), 'aria-label': '下へ' }, '↓'),
        h('button', { class: 'btn small danger', type: 'button', onclick: () => { fields.splice(i, 1); dirty = true; render(); } }, '削除'));
    }) : h('p', { class: 'muted small' }, 'まだ分野がありません。'));
  }
  async function save() {
    if (fields.some((f) => !f.name.trim())) { msg.className = 'small err'; msg.textContent = '名前のない分野があります。'; return; }
    try {
      await setDoc(doc(db, 'fieldLists', cat), { fields: fields.map((f) => ({ id: f.id, name: f.name.trim() })), updatedAt: Date.now() });
      dirty = false; msg.className = 'small ok'; msg.textContent = '保存しました';
    } catch (e) { msg.className = 'small err'; msg.textContent = errMsg(e); }
  }
  loadFields(cat).then((f) => { fields = f.map((x) => ({ ...x })); render(); }).catch((e) => { msg.className = 'small err'; msg.textContent = errMsg(e); });
  const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  S.cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
  return card;
}

// ---------------------------------------------------------------- teacher: テストの編集
async function viewTestEditor(testId) {
  const snap = await getDoc(doc(db, 'tests', testId));
  if (!snap.exists()) throw Object.assign(new Error(), { code: 'not-found' });
  const orig = { id: testId, ...snap.data() };
  const t = { title: orig.title, description: orig.description || '', category: catOf(orig), published: !!orig.published, classIds: [...(orig.classIds || [])], questions: (orig.questions || []).map((q) => ({ ...q })), choiceGroups: (orig.choiceGroups || []).map((g) => ({ ...g })) };
  let fields = await loadFields(t.category);
  const classes = await loadClasses();
  let dirty = false;
  const statusEl = h('span', { class: 'small muted' });
  const markDirty = () => { dirty = true; statusEl.className = 'small err'; statusEl.textContent = '未保存の変更があります'; };
  const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  S.cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

  const box = h('div', { class: 'stack' });
  const totalEl = h('span', { class: 'small muted' });
  const draft = () => ({ id: testId, choiceGroups: t.choiceGroups, questions: t.questions.map((q) => ({ ...q, max: Number(q.max) || 0 })) });
  const renderTotal = () => {
    totalEl.textContent = `問題 ${t.questions.length}問 ・ 満点 ${fmt(testMax(draft()))}点${t.choiceGroups.length ? '（選択問題は選ぶ数のぶん）' : ''}`;
    renderGroupInfo();
  };
  // 選択グループに入っている大問の一覧（問題番号の先頭で自動的にまとまる）
  const groupInfoEls = {};
  const blocksIn = (g) => {
    const out = [];
    for (const q of t.questions.filter((x) => x.choiceGroup === g.id)) {
      const k = blockOf(q); let b = out.find((x) => x.key === k);
      if (!b) out.push((b = { key: k, max: 0, labels: [] }));
      b.max += Number(q.max) || 0; b.labels.push(q.label || '?');
    }
    return out;
  };
  function renderGroupInfo() {
    for (const g of t.choiceGroups) {
      const el = groupInfoEls[g.id]; if (!el) continue;
      const bl = blocksIn(g);
      const maxes = [...new Set(bl.map((b) => b.max))];
      fill(el, !bl.length ? h('span', { class: 'err' }, 'まだ問題が割り当てられていません。下の問題の「必答/選択」で選んでください。')
        : [h('span', null, `大問 ${bl.map((b) => `${blockName(b.key)}（${b.labels.join(', ')}）`).join('、')} の${bl.length}つから${g.pick}つ選択`),
          Number(g.pick) >= bl.length ? h('span', { class: 'err' }, ' ・ 選ぶ数が大問の数以上です') : null,
          maxes.length > 1 ? h('span', { class: 'err' }, ` ・ 大問ごとの満点が違います（${maxes.join(', ')}点）。満点の大きい順に数えます`) : h('span', { class: 'muted' }, ` ・ 大問1つ ${fmt(maxes[0])}点`)]);
    }
  }
  const textIn = (obj, key, attrs = {}) => {
    const el = h('input', { type: 'text', value: obj[key] ?? '', ...attrs });
    el.addEventListener('input', () => { obj[key] = el.value; markDirty(); });
    return el;
  };
  // 「1-1」→「1-2」、「2」→「3」のように次の問題番号を推測する
  const nextLabel = (l) => { const m = (l || '').match(/^(.*?)(\d+)$/); return m ? `${m[1]}${Number(m[2]) + 1}` : ''; };

  function render() {
    const catSel = h('select', { id: 'ed-cat' }, CATS.map(([k, label]) => h('option', { value: k, selected: t.category === k }, label)));
    catSel.addEventListener('change', async () => { t.category = catSel.value; fields = await loadFields(t.category); markDirty(); render(); });
    const pub = h('input', { type: 'checkbox', checked: t.published, id: 'ed-pub' });
    pub.addEventListener('change', () => { t.published = pub.checked; markDirty(); render(); });
    const desc = h('textarea', { rows: 2, maxlength: 300, id: 'ed-desc', placeholder: '生徒の画面の上に表示されます（任意）' });
    desc.value = t.description;
    desc.addEventListener('input', () => { t.description = desc.value; markDirty(); });
    const fieldSelect = (q) => {
      const sel = h('select', { 'aria-label': '分野' }, h('option', { value: '' }, '（分野なし）'),
        fields.map((f) => h('option', { value: f.id, selected: q.fieldId === f.id }, f.name)));
      sel.addEventListener('change', () => { q.fieldId = sel.value || null; markDirty(); });
      return sel;
    };
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= t.questions.length) return; [t.questions[i], t.questions[j]] = [t.questions[j], t.questions[i]]; markDirty(); render(); };
    const choiceSelect = (q) => {
      const sel = h('select', { 'aria-label': '必答/選択' }, h('option', { value: '' }, '必答'),
        t.choiceGroups.map((g) => h('option', { value: g.id, selected: q.choiceGroup === g.id }, `選択: ${g.name || '選択問題'}`)));
      sel.addEventListener('change', () => { q.choiceGroup = sel.value || null; markDirty(); renderTotal(); });
      return sel;
    };
    const rows = t.questions.map((q, i) => {
      const maxIn = h('input', { type: 'number', min: 1, step: 'any', value: q.max ?? '', 'aria-label': '配点' });
      maxIn.addEventListener('input', () => { q.max = maxIn.value === '' ? null : Number(maxIn.value); markDirty(); renderTotal(); });
      const labelIn = textIn(q, 'label', { maxlength: 10, placeholder: '1-1', 'aria-label': '問題番号' });
      labelIn.addEventListener('input', renderGroupInfo);
      return h('div', { class: 'ed-item ed-q' + (t.choiceGroups.length ? ' with-choice' : '') },
        labelIn,
        fieldSelect(q), maxIn,
        t.choiceGroups.length ? choiceSelect(q) : null,
        h('span', { class: 'row', style: 'flex-wrap:nowrap;gap:4px' },
          h('button', { class: 'btn small', type: 'button', onclick: () => move(i, -1), 'aria-label': '上へ' }, '↑'),
          h('button', { class: 'btn small', type: 'button', onclick: () => move(i, 1), 'aria-label': '下へ' }, '↓'),
          h('button', { class: 'btn small danger', type: 'button', onclick: () => { t.questions.splice(i, 1); markDirty(); render(); } }, '削除')));
    });
    const addQ = () => {
      const last = t.questions[t.questions.length - 1];
      t.questions.push({ id: rid('q_'), label: last ? nextLabel(last.label) : '1', fieldId: last ? last.fieldId : null, max: last ? last.max : 10, choiceGroup: last ? last.choiceGroup || null : null });
      markDirty(); render();
      const ins = box.querySelectorAll('.ed-q input[aria-label="問題番号"]');
      ins[ins.length - 1]?.focus();
    };
    fill(box,
      h('div', { class: 'card' },
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'ed-title' }, 'テストの名前'), textIn(t, 'title', { id: 'ed-title', maxlength: 60 })),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'ed-desc' }, '説明'), desc),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'ed-cat' }, '種類'), catSel),
        h('div', { class: 'field' }, h('span', { class: 'label' }, '配信するクラス'), classPicker(classes, t.classIds, (ids) => { t.classIds = ids; markDirty(); render(); })),
        h('label', { class: 'row' }, pub, '生徒に公開する（オンにすると、選んだクラスの生徒が記入できます）'),
        t.published && !t.classIds.length ? h('p', { class: 'err' }, 'クラスを選ばないと、公開しても生徒には表示されません。') : null),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', null, '問題'), h('span', { class: 'spacer' }), totalEl),
        h('p', { class: 'small muted' }, `分野は「${CAT_SHORT[t.category]}」タブ共通の分野リストから選びます（得点表の管理画面で追加できます）。`),
        !fields.length ? h('p', { class: 'notice small' }, '分野がまだありません。得点表の管理画面の「分野」で先に追加すると、ここで選べるようになります。') : null,
        h('div', { class: 'ed-items' },
          h('div', { class: 'ed-item ed-q label' + (t.choiceGroups.length ? ' with-choice' : '') }, h('span', null, '問題番号'), h('span', null, '分野'), h('span', null, '配点'), t.choiceGroups.length ? h('span', null, '必答/選択') : null, h('span')),
          rows),
        h('div', null, h('button', { class: 'btn small', type: 'button', onclick: addQ }, '＋ 問題を追加'))),
      h('div', { class: 'card' },
        h('h2', null, '選択問題'),
        h('p', { class: 'small muted' }, '「第4問〜第7問から3問選択」のような問題があるときに使います。グループを作り、上の問題の「必答/選択」でグループを選びます。問題番号の先頭（4-1、4-2 → 第4問）で大問にまとまります。生徒は大問ごとに選んで記入し、満点は選ぶ数のぶんだけ数えます。'),
        t.choiceGroups.map((g, gi) => {
          const nameIn = textIn(g, 'name', { maxlength: 30, placeholder: '例: 第4問〜第7問', 'aria-label': '選択グループの名前' });
          nameIn.addEventListener('input', () => {
            for (const o of box.querySelectorAll(`select[aria-label="必答/選択"] option[value="${g.id}"]`)) o.textContent = `選択: ${g.name || '選択問題'}`;
          });
          const pickIn = h('input', { type: 'number', min: 1, step: 1, value: g.pick ?? 1, 'aria-label': '選ぶ数', style: 'width:5em' });
          pickIn.addEventListener('input', () => { g.pick = Math.max(1, parseInt(pickIn.value, 10) || 1); markDirty(); renderTotal(); });
          groupInfoEls[g.id] = h('div', { class: 'small' });
          return h('div', { class: 'choice-ed' },
            h('div', { class: 'row' }, nameIn, h('span', { class: 'small' }, 'から'), pickIn, h('span', { class: 'small' }, 'つ選択'), h('span', { class: 'spacer' }),
              h('button', { class: 'btn small danger', type: 'button', onclick: () => { t.choiceGroups.splice(gi, 1); for (const q of t.questions) if (q.choiceGroup === g.id) q.choiceGroup = null; markDirty(); render(); } }, 'グループを削除')),
            groupInfoEls[g.id]);
        }),
        h('div', null, h('button', { class: 'btn small', type: 'button', onclick: () => { t.choiceGroups.push({ id: rid('g_'), name: '', pick: 1 }); markDirty(); render(); } }, '＋ 選択グループを追加'))));
    renderTotal();
  }

  async function save() {
    const problems = [];
    if (!t.title.trim()) problems.push('テストの名前を入力してください。');
    if (t.questions.some((q) => !(Number(q.max) > 0))) problems.push('配点が空または0以下の問題があります。');
    for (const g of t.choiceGroups) {
      const n = blocksIn(g).length;
      if (!n) problems.push(`選択グループ「${g.name || '選択問題'}」に問題がありません。`);
      else if (!(Number(g.pick) >= 1 && Number(g.pick) < n)) problems.push(`選択グループ「${g.name || '選択問題'}」の選ぶ数は1〜${n - 1}にしてください。`);
    }
    if (problems.length) { statusEl.className = 'small err'; statusEl.textContent = problems.join(' '); return; }
    saveBtn.disabled = true;
    try {
      await updateDoc(doc(db, 'tests', testId), {
        title: t.title.trim(), description: t.description.trim(), category: t.category, published: t.published,
        classIds: t.classIds, visibleTo: visibleFor(t.published, t.classIds),
        questions: t.questions.map((q) => ({ id: q.id, label: (q.label || '').trim(), fieldId: q.fieldId || null, max: Number(q.max), choiceGroup: t.choiceGroups.some((g) => g.id === q.choiceGroup) ? q.choiceGroup : null })),
        choiceGroups: t.choiceGroups.map((g) => ({ id: g.id, name: (g.name || '').trim(), pick: Number(g.pick) || 1 })),
        updatedAt: Date.now(),
      });
      dirty = false; statusEl.className = 'small ok'; statusEl.textContent = '保存しました'; toast('保存しました');
    } catch (e) { statusEl.className = 'small err'; statusEl.textContent = errMsg(e); }
    finally { saveBtn.disabled = false; }
  }
  const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: save }, '保存する');
  const delBtn = confirmButton('このテストを削除', 'もう一度押すと、生徒の記録ごと削除します', async () => {
    try {
      for (const col of ['scores', 'notes']) {
        const s = await getDocs(query(collection(db, col), where('testId', '==', testId)));
        for (let i = 0; i < s.docs.length; i += 400) { const b = writeBatch(db); s.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref)); await b.commit(); }
      }
      const sets = docsOf(await getDocs(query(collection(db, 'sets'), where('testIds', 'array-contains', testId))));
      for (const s of sets) await updateDoc(doc(db, 'sets', s.id), { testIds: s.testIds.filter((x) => x !== testId), updatedAt: Date.now() });
      await deleteDoc(doc(db, 'tests', testId));
      dirty = false; toast('削除しました'); location.hash = '#/';
    } catch (e) { toast(errMsg(e)); }
  });
  render();
  mount(
    pageHead(h('a', { href: '#/' }, '← 得点表の管理'), 'テストの編集', null,
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: async () => { if (dirty) await save(); const all = docsOf(await getDocs(collection(db, 'tests'))); duplicateTest({ ...orig, ...t, id: testId }, all); } }, 'このテストを複製'),
        h('a', { class: 'btn small', href: `#/t/test/${testId}/preview` }, '生徒の画面を試す'),
        h('a', { class: 'btn small', href: `#/t/test/${testId}/results` }, '成績一覧'))),
    h('p', { class: 'notice warn small' }, '生徒が記入を始めた後に問題を削除すると、その問題の点数は集計に使われなくなります。'),
    box,
    h('div', { class: 'sticky-save' }, saveBtn, statusEl, h('span', { class: 'spacer' }), delBtn));
}

// ---------------------------------------------------------------- teacher: セットの編集
async function viewSetEditor(setId) {
  const snap = await getDoc(doc(db, 'sets', setId));
  if (!snap.exists()) throw Object.assign(new Error(), { code: 'not-found' });
  const orig = snap.data();
  const s = { title: orig.title, description: orig.description || '', category: catOf(orig), published: !!orig.published, classIds: [...(orig.classIds || [])], testIds: [...(orig.testIds || [])] };
  const [tests, classes] = await Promise.all([loadAll('tests'), loadClasses()]);
  const testsById = Object.fromEntries(tests.map((t) => [t.id, t]));
  let dirty = false;
  const statusEl = h('span', { class: 'small muted' });
  const markDirty = () => { dirty = true; statusEl.className = 'small err'; statusEl.textContent = '未保存の変更があります'; };
  const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  S.cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
  const box = h('div', { class: 'stack' });

  function render() {
    const title = h('input', { type: 'text', id: 'set-title', value: s.title, maxlength: 60 });
    title.addEventListener('input', () => { s.title = title.value; markDirty(); });
    const desc = h('textarea', { rows: 2, maxlength: 300, id: 'set-desc' });
    desc.value = s.description;
    desc.addEventListener('input', () => { s.description = desc.value; markDirty(); });
    const pub = h('input', { type: 'checkbox', checked: s.published, id: 'set-pub' });
    pub.addEventListener('change', () => { s.published = pub.checked; markDirty(); render(); });
    const candidates = tests.filter((t) => catOf(t) === s.category && !s.testIds.includes(t.id));
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= s.testIds.length) return; [s.testIds[i], s.testIds[j]] = [s.testIds[j], s.testIds[i]]; markDirty(); render(); };
    fill(box,
      h('div', { class: 'card' },
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'set-title' }, 'セットの名前'), title),
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'set-desc' }, '説明'), desc),
        h('p', { class: 'small muted' }, `種類: ${CATS.find((c) => c[0] === s.category)[1]}`),
        h('div', { class: 'field' }, h('span', { class: 'label' }, '配信するクラス'), classPicker(classes, s.classIds, (ids) => { s.classIds = ids; markDirty(); render(); })),
        h('label', { class: 'row' }, pub, '生徒に公開する'),
        s.published && !s.classIds.length ? h('p', { class: 'err' }, 'クラスを選ばないと、公開しても生徒には表示されません。') : null,
        h('p', { class: 'small muted' }, 'セットの中のテストも、同じクラスに公開しておく必要があります。')),
      h('div', { class: 'card' },
        h('h2', null, `このセットのテスト（${s.testIds.length}）`),
        s.testIds.length ? h('div', { class: 'stack', style: 'gap:6px' }, s.testIds.map((id, i) => h('div', { class: 'row set-member' },
          h('span', { class: 'num muted' }, `${i + 1}.`), h('b', null, testsById[id]?.title || '（削除されたテスト）'),
          testsById[id] && !testsById[id].published ? h('span', { class: 'pill warn' }, '非公開') : null,
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', type: 'button', onclick: () => move(i, -1) }, '↑'),
          h('button', { class: 'btn small', type: 'button', onclick: () => move(i, 1) }, '↓'),
          h('button', { class: 'btn small danger', type: 'button', onclick: () => { s.testIds.splice(i, 1); markDirty(); render(); } }, '外す')))) : h('p', { class: 'muted small' }, 'まだテストがありません。下から追加してください。'),
        h('h3', null, '追加できるテスト'),
        candidates.length ? h('div', { class: 'row' }, candidates.map((t) => h('button', { class: 'btn small', type: 'button', onclick: () => { s.testIds.push(t.id); markDirty(); render(); } }, `＋ ${t.title}`)),
          h('button', { class: 'btn small link', type: 'button', onclick: () => { s.testIds.push(...candidates.map((t) => t.id)); markDirty(); render(); } }, 'すべて追加'))
          : h('p', { class: 'muted small' }, `追加できる${CAT_SHORT[s.category]}のテストはありません。`)));
  }
  async function save() {
    if (!s.title.trim()) { statusEl.className = 'small err'; statusEl.textContent = 'セットの名前を入力してください。'; return; }
    try {
      await updateDoc(doc(db, 'sets', setId), { title: s.title.trim(), description: s.description.trim(), published: s.published, classIds: s.classIds, visibleTo: visibleFor(s.published, s.classIds), testIds: s.testIds.filter((id) => testsById[id]), updatedAt: Date.now() });
      dirty = false; statusEl.className = 'small ok'; statusEl.textContent = '保存しました'; toast('保存しました');
    } catch (e) { statusEl.className = 'small err'; statusEl.textContent = errMsg(e); }
  }
  const delBtn = confirmButton('このセットを削除', 'もう一度押すと削除（テストと記録は残ります）', async () => {
    try { await deleteDoc(doc(db, 'sets', setId)); dirty = false; toast('削除しました'); location.hash = '#/'; } catch (e) { toast(errMsg(e)); }
  });
  render();
  mount(
    pageHead(h('a', { href: '#/' }, '← 得点表の管理'), 'セットの編集', null, h('a', { class: 'btn small', href: `#/t/set/${setId}/results` }, '成績一覧')),
    box,
    h('div', { class: 'sticky-save' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, '保存する'), statusEl, h('span', { class: 'spacer' }), delBtn));
}

// ---------------------------------------------------------------- teacher: 成績一覧（テスト・セット共通）
async function viewResults(kind, id) {
  const snap = await getDoc(doc(db, kind === 'test' ? 'tests' : 'sets', id));
  if (!snap.exists()) throw Object.assign(new Error(), { code: 'not-found' });
  const obj = { id, ...snap.data() };
  const kyotsu = isKyotsu(obj);
  const [fields, tests, classes, uSnap, goalsSnap] = await Promise.all([
    loadFields(catOf(obj)), kind === 'set' ? loadAll('tests') : Promise.resolve([obj]), loadClasses(),
    getDocs(query(collection(db, 'users'), where('role', '==', 'student'))),
    kyotsu ? getDocs(collection(db, 'goals')) : Promise.resolve(null),
  ]);
  const testsById = Object.fromEntries(tests.map((t) => [t.id, t]));
  const members = kind === 'set' ? (obj.testIds || []).map((x) => testsById[x]).filter(Boolean) : [obj];
  const items = kind === 'set' ? setItems(obj, testsById) : qItems(obj);
  const students = docsOf(uSnap).map((u) => ({ ...u, uid: u.id })).sort(byNumber);
  const goals = goalsSnap ? Object.fromEntries(goalsSnap.docs.map((d) => [d.id, d.data().kyotsu])) : {};
  let notes = {};
  if (kind === 'test') notes = Object.fromEntries((await getDocs(query(collection(db, 'notes'), where('testId', '==', id)))).docs.map((d) => [d.data().uid, d.data()]));
  const max = evalGroup(items, {}).max;
  const targetClasses = classes.filter((c) => (obj.classIds || []).includes(c.id));
  const mineHere = targetClasses.filter((c) => (c.teacherIds || []).includes(S.user.uid));
  const st = { mode: kind === 'test' ? 'questions' : 'tests', prefix: '', sort: 'number', cls: mineHere.length === 1 ? mineHere[0].id : targetClasses.length ? 'targets' : 'everyone' };
  const inClass = (s) => {
    if (st.cls === 'everyone') return true;
    const ids = st.cls === 'targets' ? targetClasses.map((c) => c.id) : [st.cls];
    return classes.some((c) => ids.includes(c.id) && (c.studentIds || []).includes(s.uid));
  };
  const clsSel = h('select', { 'aria-label': 'クラス' },
    targetClasses.map((c) => h('option', { value: c.id, selected: st.cls === c.id }, c.name)),
    targetClasses.length > 1 ? h('option', { value: 'targets', selected: st.cls === 'targets' }, '配信先のクラスすべて') : null,
    h('option', { value: 'everyone', selected: st.cls === 'everyone' }, 'すべての生徒'));
  clsSel.onchange = () => { st.cls = clsSel.value; render(); };
  let byTest = {}, meta = {};

  const prefixSel = h('select', { 'aria-label': '出席番号で絞り込み' }, h('option', { value: '' }, 'すべての生徒'), prefixesOf(students).map((p) => h('option', { value: p }, `出席番号 ${p}xx`)));
  prefixSel.onchange = () => { st.prefix = prefixSel.value; render(); };
  const sortSel = h('select', { 'aria-label': '並び順' }, h('option', { value: 'number' }, '出席番号順'), h('option', { value: 'rate' }, '得点率の高い順'));
  sortSel.onchange = () => { st.sort = sortSel.value; render(); };
  const modes = kind === 'test' ? [['questions', '問題別'], ['fields', '分野別']] : [['tests', 'テスト別'], ['fields', '分野別']];
  const modeTabs = modes.map(([k, label]) => {
    const b = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(k === st.mode) }, label);
    b.onclick = () => { st.mode = k; modeTabs.forEach((x, i) => x.setAttribute('aria-selected', String(modes[i][0] === k))); render(); };
    return b;
  });
  const summary = h('div', { class: 'tiles' });
  const tableBox = h('div', { class: 'tscroll' });
  const distBox = h('div');

  function columns() {
    if (st.mode === 'questions') return items.map((it) => ({ label: `${it.label || '問'}${it.cg ? '（選択）' : ''}`, sub: fields.find((f) => f.id === it.fieldId)?.name || '', items: [it], kind: 'pt' }));
    if (st.mode === 'tests') return members.map((t) => ({ label: t.title, sub: `/${fmt(testMax(t))}`, items: items.filter((it) => it.testId === t.id), kind: 'complete' }));
    const cols = fields.map((f) => ({ label: f.name, items: items.filter((it) => it.fieldId === f.id), kind: 'rate' })).filter((c) => c.items.length);
    return cols.map((c) => ({ ...c, sub: `満点${fmt(evalGroup(c.items, {}).max)}` }));
  }

  function render() {
    const all = kind === 'set' ? mergeScores(members.map((t) => t.id), byTest) : (byTest[id] || {});
    const cols = columns();
    const rows = students.filter((s) => inClass(s) && (!st.prefix || (s.studentNo || '').startsWith(st.prefix))).map((s) => {
      const sc = all[s.uid] || {};
      return { s, sc, g: evalGroup(items, sc), cells: cols.map((c) => evalGroup(c.items, sc)) };
    });
    const totalMode = kind === 'test' ? 'complete' : 'rate';
    const cmp = compare(items, Object.fromEntries(rows.map((r) => [r.s.uid, r.sc])), null, totalMode);
    const rateVals = rows.filter((r) => r.g.count).map((r) => r.g.rate);
    if (st.sort === 'rate') rows.sort((a, b) => (b.g.rate ?? -1) - (a.g.rate ?? -1));
    fill(summary,
      h('div', { class: 'tile' }, h('span', { class: 'label' }, '生徒数'), h('span', { class: 'v' }, String(rows.length), h('small', null, '人'))),
      h('div', { class: 'tile' }, h('span', { class: 'label' }, '記入している生徒'), h('span', { class: 'v' }, String(rateVals.length), h('small', null, '人'))),
      kind === 'test'
        ? h('div', { class: 'tile' }, h('span', { class: 'label' }, '平均点（全問記入）'), h('span', { class: 'v' }, cmp.n ? f1(cmp.avg) : '—', h('small', null, `/ ${fmt(max)}`)))
        : h('div', { class: 'tile' }, h('span', { class: 'label' }, '平均得点率'), h('span', { class: 'v' }, pct(describe(rateVals).avg))),
      h('div', { class: 'tile' }, h('span', { class: 'label' }, '最高'), h('span', { class: 'v' }, kind === 'test' ? (cmp.n ? fmt(cmp.max) : '—') : pct(describe(rateVals).max))));

    const colAvg = cols.map((c, i) => {
      const gs = rows.map((r) => r.cells[i]);
      if (c.kind === 'rate') return pct(describe(gs.filter((g) => g.count).map((g) => g.rate)).avg);
      const vals = gs.filter((g) => (c.kind === 'complete' ? g.complete : g.count)).map((g) => g.sum);
      return vals.length ? f1(describe(vals).avg) : '—';
    });
    const cell = (c, g) => {
      if (!g.count) return h('td', { class: 'r muted' }, '—');
      if (c.kind === 'rate') return h('td', { class: `r num ${heat(g.rate)}` }, pct(g.rate));
      return h('td', { class: `r num ${g.complete ? heat(g.rate) : 'partial'}` }, fmt(g.sum), g.complete ? '' : '*');
    };
    const targetOf = (r) => (kind !== 'test' ? null : kyotsu ? kyotsuTarget(goals[r.s.uid], max) : (notes[r.s.uid] || {}).target);
    const linkOf = (r) => (kind === 'test' ? `#/t/test/${id}/u/${r.s.uid}` : `#/t/set/${id}/u/${r.s.uid}`);
    fill(tableBox, h('table', null,
      h('thead', null, h('tr', null,
        h('th', { class: 'r' }, '出席番号'), h('th', { class: 'sticky' }, '名前'),
        cols.map((c) => h('th', { class: 'r' }, c.label, h('br'), h('span', null, c.sub))),
        h('th', { class: 'r' }, kind === 'test' ? '合計' : '記入済み'), h('th', { class: 'r' }, '得点率'), h('th', { class: 'r' }, '順位'),
        kind === 'test' ? h('th', { class: 'r' }, '目標') : null, h('th', null, '記入日'))),
      h('tbody', null,
        h('tr', { class: 'avg-row' }, h('td'), h('td', { class: 'sticky' }, '平均'), colAvg.map((v) => h('td', { class: 'r num' }, v)),
          h('td', { class: 'r num' }, kind === 'test' && cmp.n ? f1(cmp.avg) : ''), h('td', { class: 'r num' }, pct(describe(rateVals).avg)), h('td'), kind === 'test' ? h('td') : null, h('td')),
        rows.map((r) => {
          const target = targetOf(r);
          const dates = members.map((t) => (meta[`${t.id}_${r.s.uid}`] || {}).date).filter(Boolean).sort();
          const rank = kind === 'test' ? (r.g.complete ? rankOf(cmp.values, r.g.sum) : null) : (r.g.count ? rankOf(rateVals, r.g.rate) : null);
          const doneTests = members.filter((t) => evalGroup(items.filter((it) => it.testId === t.id), r.sc).complete).length;
          return h('tr', null,
            h('td', { class: 'r num' }, r.s.studentNo || ''),
            h('td', { class: 'sticky' }, h('a', { href: linkOf(r) }, r.s.displayName)),
            cols.map((c, i) => cell(c, r.cells[i])),
            h('td', { class: 'r num' }, kind === 'test' ? (r.g.count ? `${fmt(r.g.sum)}${r.g.complete ? '' : '*'}` : '—') : `${doneTests}/${members.length}`),
            h('td', { class: `r num ${heat(r.g.rate)}` }, pct(r.g.rate)),
            h('td', { class: 'r num' }, rank ?? '—'),
            kind === 'test' ? h('td', { class: 'r num' }, isNum(target) ? (r.g.complete ? h('span', { class: r.g.sum >= target ? 'heat-hi' : 'heat-lo' }, fmt(target)) : fmt(target)) : '—') : null,
            h('td', { class: 'num small muted' }, dates.length ? dates[dates.length - 1] : '—'));
        }))));
    fill(distBox, kind === 'test'
      ? distributionView(cmp.values, max, null, { note: '（全問記入した人）' })
      : distributionView(rateVals, 1, null, { unit: 'rate', note: '（1問以上記入した人・得点率）' }));
  }

  function exportCsv() {
    const all = kind === 'set' ? mergeScores(members.map((t) => t.id), byTest) : (byTest[id] || {});
    const head = ['出席番号', '名前'];
    for (const it of items) head.push(`${kind === 'set' ? it.testTitle + ' ' : ''}${it.label || ''} ${fields.find((f) => f.id === it.fieldId)?.name || ''} (/${it.max})`.replace(/\s+/g, ' ').trim());
    if (kind === 'set') for (const t of members) head.push(`${t.title} 合計 (/${testMax(t)})`);
    for (const f of fields) if (items.some((it) => it.fieldId === f.id)) head.push(`${f.name} 得点率(%)`);
    head.push(kind === 'test' ? `合計 (/${max})` : `合計（全テスト記入時） (/${max})`, '得点率(%)');
    if (kind === 'test') head.push('目標', '振り返り');
    const lines = [head];
    for (const s of students.filter((x) => inClass(x) && (!st.prefix || (x.studentNo || '').startsWith(st.prefix)))) {
      const sc = all[s.uid] || {};
      const row = [s.studentNo || '', s.displayName];
      for (const it of items) { const v = validScore(it, sc); row.push(v === null ? '' : v); }
      if (kind === 'set') for (const t of members) { const g = evalGroup(items.filter((it) => it.testId === t.id), sc); row.push(g.complete ? g.sum : ''); }
      for (const f of fields) { const fi = items.filter((it) => it.fieldId === f.id); if (fi.length) { const g = evalGroup(fi, sc); row.push(g.count ? f1(g.rate * 100) : ''); } }
      const g = evalGroup(items, sc);
      row.push(g.complete ? g.sum : '', g.count ? f1(g.rate * 100) : '');
      if (kind === 'test') { const tg = kyotsu ? kyotsuTarget(goals[s.uid], max) : (notes[s.uid] || {}).target; row.push(isNum(tg) ? tg : '', (notes[s.uid] || {}).memo || ''); }
      lines.push(row);
    }
    downloadText(`${obj.title}_成績_${today()}.csv`, lines.map((r) => r.map(csvCell).join(',')).join('\r\n'));
  }

  S.cleanups.push(watchScores(members.map((t) => t.id), (b, m) => { byTest = b; meta = m; render(); }, (e) => toast(errMsg(e))));
  mount(
    pageHead(h('span', null, h('a', { href: '#/' }, '← 得点表の管理'), '　', catPill(obj), kind === 'set' ? [' ', h('span', { class: 'pill' }, 'セット')] : null),
      obj.title, '成績一覧（リアルタイムで更新されます）',
      h('div', { class: 'row' },
        h('a', { class: 'btn small', href: kind === 'test' ? `#/t/test/${id}/edit` : `#/t/set/${id}/edit` }, '編集'),
        kind === 'test' ? h('a', { class: 'btn small', href: `#/t/test/${id}/preview` }, '生徒の画面を試す') : null,
        h('button', { class: 'btn small', type: 'button', onclick: exportCsv }, 'CSVでダウンロード'))),
    summary,
    h('div', { class: 'row' }, h('div', { class: 'tabs', role: 'tablist' }, modeTabs), h('span', { class: 'spacer' }), clsSel, prefixSel, sortSel),
    tableBox,
    h('p', { class: 'small muted' }, '名前を押すと、その生徒の記録（目標・振り返りを含む）を見られます。「*」は記入途中です。色: 得点率 70%以上=緑、50〜70%=橙、50%未満=赤。'),
    section(kind === 'test' ? '得点分布' : '得点率の分布', distBox));
}

// ---------------------------------------------------------------- teacher: 以前の形式（得点表）からの変換
async function migrateLegacy(wbs) {
  try {
    toast('変換しています…');
    const fieldCache = {};
    // 変換したテスト・セットは、自分が担当するクラス（なければすべてのクラス）に配信する
    const allClasses = await loadClasses();
    const legacyClassIds = myTeachingIds(allClasses).length ? myTeachingIds(allClasses) : allClasses.map((c) => c.id);
    for (const w of wbs) {
      const cat = catOf(w);
      if (!fieldCache[cat]) fieldCache[cat] = await loadFields(cat);
      const list = fieldCache[cat];
      // 分野は名前でまとめる（同じ名前があれば使い回す）
      const fmap = {};
      for (const f of w.fields || []) {
        let hit = list.find((x) => x.name === f.name);
        if (!hit) { hit = { id: rid('f_'), name: f.name }; list.push(hit); }
        fmap[f.id] = hit.id;
      }
      await setDoc(doc(db, 'fieldLists', cat), { fields: list, updatedAt: Date.now() });
      // 回 → テスト、得点表の中のセット → セット、得点表全体 → セット
      const roundToTest = {};
      const allIds = [];
      for (const s of w.sets || []) {
        const ids = [];
        for (const r of s.rounds || []) {
          const ref = await addDoc(collection(db, 'tests'), {
            title: `${w.title} ${r.label}`.slice(0, 60), description: w.description || '', category: cat, published: !!w.published,
            classIds: legacyClassIds, visibleTo: visibleFor(!!w.published, legacyClassIds),
            questions: (r.items || []).map((it) => ({ id: it.id, label: it.label || '', fieldId: fmap[it.fieldId] || null, max: it.max })),
            createdAt: Date.now(), updatedAt: Date.now(),
          });
          roundToTest[r.id] = { testId: ref.id, itemIds: (r.items || []).map((it) => it.id) };
          ids.push(ref.id); allIds.push(ref.id);
        }
        await addDoc(collection(db, 'sets'), { title: `${w.title} ${s.label}`.slice(0, 60), description: '', category: cat, published: !!w.published, classIds: legacyClassIds, visibleTo: visibleFor(!!w.published, legacyClassIds), testIds: ids, createdAt: Date.now(), updatedAt: Date.now() });
      }
      if ((w.sets || []).length > 1) await addDoc(collection(db, 'sets'), { title: `${w.title} 全体`.slice(0, 60), description: '', category: cat, published: !!w.published, classIds: legacyClassIds, visibleTo: visibleFor(!!w.published, legacyClassIds), testIds: allIds, createdAt: Date.now(), updatedAt: Date.now() });
      // 点数
      const old = await getDocs(query(collection(db, 'scores'), where('wbId', '==', w.id)));
      let batch = writeBatch(db), n = 0;
      for (const d of old.docs) {
        const x = d.data();
        for (const [rId, info] of Object.entries(roundToTest)) {
          const sc = {};
          for (const iid of info.itemIds) if (isNum((x.scores || {})[iid])) sc[iid] = x.scores[iid];
          if (!Object.keys(sc).length) continue;
          batch.set(doc(db, 'scores', `${info.testId}_${x.uid}`), { testId: info.testId, uid: x.uid, scores: sc, date: (x.dates || {})[rId] || '', updatedAt: Date.now() });
          if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(db); }
        }
      }
      await batch.commit();
      await updateDoc(doc(db, 'workbooks', w.id), { migratedAt: Date.now() });
    }
    toast('変換しました');
    route();
  } catch (e) { console.error(e); toast('変換できませんでした: ' + errMsg(e)); }
}

// ---------------------------------------------------------------- teacher: クラス
async function viewClasses() {
  const [classes, users] = await Promise.all([loadClasses(), getDocs(collection(db, 'users')).then(docsOf)]);
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const inp = h('input', { type: 'text', id: 'new-class', maxlength: 40, placeholder: '例: 3年1組、数学選択A', style: 'flex:1;min-width:12em' });
  const msg = h('span', { class: 'err small' });
  const btn = h('button', { class: 'btn primary', type: 'button' }, 'クラスを作る');
  btn.onclick = async () => {
    const name = inp.value.trim();
    if (!name) { msg.textContent = 'クラスの名前を入力してください。'; return; }
    btn.disabled = true;
    try {
      const ref = await addDoc(collection(db, 'classes'), { name, teacherIds: [S.user.uid], studentIds: [], createdAt: Date.now(), updatedAt: Date.now() });
      location.hash = `#/t/class/${ref.id}`;
    } catch (e) { msg.textContent = errMsg(e); btn.disabled = false; }
  };
  const mine = myTeachingIds(classes);
  mount(
    pageHead('先生用', 'クラス'),
    h('p', { class: 'notice small' }, 'クラスごとに担当の先生と生徒を登録します。テストやセットは「配信するクラス」を選ぶと、そのクラスの生徒にだけ表示されます。生徒の画面の平均・順位・分布は、同じクラスの人どうしで計算します。1人の生徒が複数のクラスに入ることもできます。'),
    h('div', { class: 'card' }, h('h2', null, '新しいクラスを作る'), h('div', { class: 'row' }, inp, btn), msg),
    classes.length ? h('div', { class: 'tscroll' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'クラス'), h('th', null, '担当の先生'), h('th', { class: 'r' }, '生徒'), h('th', null, ''))),
      h('tbody', null, classes.map((c) => h('tr', null,
        h('td', null, h('b', null, c.name), mine.includes(c.id) ? h('span', { class: 'pill accent', style: 'margin-left:8px' }, '担当') : null),
        h('td', { class: 'small wrap' }, (c.teacherIds || []).map((t) => byId[t]?.displayName).filter(Boolean).join('、') || h('span', { class: 'muted' }, 'なし')),
        h('td', { class: 'r num' }, `${(c.studentIds || []).filter((u) => byId[u]).length}人`),
        h('td', null, h('a', { class: 'btn small', href: `#/t/class/${c.id}` }, '編集'))))))) : h('p', { class: 'muted' }, 'まだクラスがありません。'));
}

async function viewClassEditor(classId) {
  const [snap, users] = await Promise.all([getDoc(doc(db, 'classes', classId)), getDocs(collection(db, 'users')).then(docsOf)]);
  if (!snap.exists()) throw Object.assign(new Error(), { code: 'not-found' });
  const orig = snap.data();
  const c = { name: orig.name || '', teacherIds: [...(orig.teacherIds || [])], studentIds: [...(orig.studentIds || [])] };
  const teachers = users.filter((u) => u.role === 'teacher').sort(byNumber);
  const students = users.filter((u) => u.role === 'student').sort(byNumber);
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const byNo = Object.fromEntries(students.map((u) => [u.studentNo, u]));
  let dirty = false;
  const statusEl = h('span', { class: 'small muted' });
  const markDirty = () => { dirty = true; statusEl.className = 'small err'; statusEl.textContent = '未保存の変更があります'; };
  const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);
  S.cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
  const box = h('div', { class: 'stack' });

  // 「3101 3102」「3101-3140」「3101,3105」のように書かれた出席番号を読む
  function parseNumbers(text) {
    const out = [];
    for (const part of text.normalize('NFKC').split(/[\s,、，]+/).filter(Boolean)) {
      const m = part.match(/^(\d{4})[-〜~](\d{4})$/);
      if (m) { for (let n = Number(m[1]); n <= Number(m[2]) && out.length < 2000; n++) out.push(String(n).padStart(4, '0')); }
      else out.push(part);
    }
    return out;
  }

  function render() {
    const nameIn = h('input', { type: 'text', id: 'class-name', value: c.name, maxlength: 40 });
    nameIn.addEventListener('input', () => { c.name = nameIn.value; markDirty(); });
    const members = c.studentIds.map((id) => byId[id]).filter(Boolean).sort(byNumber);
    const addIn = h('textarea', { rows: 2, id: 'class-add', placeholder: '出席番号を入力（例: 3101-3140、または 3101 3102 3105）' });
    const addMsg = h('span', { class: 'small' });
    const addBtn = h('button', {
      class: 'btn small primary', type: 'button', onclick: () => {
        const text = addIn.value.normalize('NFKC');
        // 範囲指定（3101-3140）のときは、登録されていない番号があっても知らせない
        const rangeUsed = /\d{4}\s*[-〜~]\s*\d{4}/.test(text);
        const nums = parseNumbers(text);
        const found = nums.map((n) => byNo[n]).filter((u) => u && !c.studentIds.includes(u.id)).map((u) => u.id);
        const missing = rangeUsed ? [] : nums.filter((n) => !byNo[n]);
        c.studentIds.push(...new Set(found));
        if (found.length) markDirty();
        render();
        const m = box.querySelector('#class-add-msg');
        m.className = 'small ' + (found.length ? 'ok' : 'err');
        m.textContent = `${new Set(found).size}人を追加しました。「保存する」で確定します。`
          + (missing.length ? `（登録されていない番号: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}）` : '');
      },
    }, '追加');
    addMsg.id = 'class-add-msg';
    const prefixes = prefixesOf(students);
    fill(box,
      h('div', { class: 'card' },
        h('div', { class: 'field' }, h('label', { class: 'label', for: 'class-name' }, 'クラスの名前'), nameIn)),
      h('div', { class: 'card' },
        h('h2', null, '担当の先生'),
        h('div', { class: 'row' }, teachers.map((t) => {
          const cb = h('input', { type: 'checkbox', checked: c.teacherIds.includes(t.id) });
          cb.addEventListener('change', () => { c.teacherIds = cb.checked ? [...new Set([...c.teacherIds, t.id])] : c.teacherIds.filter((x) => x !== t.id); markDirty(); });
          return h('label', { class: 'row chk' }, cb, t.displayName, h('span', { class: 'small muted' }, t.email || ''));
        }))),
      h('div', { class: 'card' },
        h('h2', null, `生徒（${members.length}人）`),
        h('div', { class: 'stack', style: 'gap:8px' },
          h('div', { class: 'row' }, addIn),
          h('div', { class: 'row' }, addBtn,
            prefixes.length ? [h('span', { class: 'small muted' }, 'まとめて追加:'), prefixes.map((p) => h('button', {
              class: 'btn small', type: 'button', onclick: () => {
                const add = students.filter((u) => u.studentNo.startsWith(p) && !c.studentIds.includes(u.id)).map((u) => u.id);
                c.studentIds.push(...add); if (add.length) markDirty(); render();
              },
            }, `${p}xx`))] : null),
          addMsg),
        members.length ? h('div', { class: 'tscroll' }, h('table', null,
          h('thead', null, h('tr', null, h('th', { class: 'r' }, '出席番号'), h('th', null, '名前'), h('th', null, ''))),
          h('tbody', null, members.map((u) => h('tr', null,
            h('td', { class: 'r num' }, u.studentNo), h('td', null, u.displayName),
            h('td', null, h('button', { class: 'btn small danger', type: 'button', onclick: () => { c.studentIds = c.studentIds.filter((x) => x !== u.id); markDirty(); render(); } }, 'クラスから外す'))))))) : h('p', { class: 'muted small' }, 'まだ生徒がいません。上の欄に出席番号を入れて追加してください。')));
  }

  async function save() {
    if (!c.name.trim()) { statusEl.className = 'small err'; statusEl.textContent = 'クラスの名前を入力してください。'; return; }
    const before = new Set(orig.studentIds || []);
    const after = new Set(c.studentIds);
    const added = [...after].filter((x) => !before.has(x) && byId[x]);
    const removed = [...before].filter((x) => !after.has(x) && byId[x]);
    try {
      // クラスと生徒の「所属クラス」を一緒に更新する（どちらからも同じ内容が見えるように）
      const ops = [
        [doc(db, 'classes', classId), { name: c.name.trim(), teacherIds: c.teacherIds, studentIds: [...after], updatedAt: Date.now() }],
        ...added.map((u) => [doc(db, 'users', u), { classIds: arrayUnion(classId) }]),
        ...removed.map((u) => [doc(db, 'users', u), { classIds: arrayRemove(classId) }]),
      ];
      for (let i = 0; i < ops.length; i += 400) { const b = writeBatch(db); ops.slice(i, i + 400).forEach(([r, d]) => b.update(r, d)); await b.commit(); }
      orig.studentIds = [...after];
      dirty = false; statusEl.className = 'small ok'; statusEl.textContent = '保存しました'; toast('保存しました');
    } catch (e) { statusEl.className = 'small err'; statusEl.textContent = errMsg(e); }
  }
  const delBtn = confirmButton('このクラスを削除', 'もう一度押すと削除（生徒・テスト・点数は消えません）', async () => {
    try {
      const ops = [];
      for (const u of orig.studentIds || []) if (byId[u]) ops.push([doc(db, 'users', u), { classIds: arrayRemove(classId) }]);
      for (const col of ['tests', 'sets']) {
        const s = await getDocs(query(collection(db, col), where('classIds', 'array-contains', classId)));
        for (const d of s.docs) ops.push([d.ref, { classIds: arrayRemove(classId), visibleTo: arrayRemove(classId) }]);
      }
      for (let i = 0; i < ops.length; i += 400) { const b = writeBatch(db); ops.slice(i, i + 400).forEach(([r, d]) => b.update(r, d)); await b.commit(); }
      await deleteDoc(doc(db, 'classes', classId));
      dirty = false; toast('クラスを削除しました'); location.hash = '#/t/classes';
    } catch (e) { toast(errMsg(e)); }
  });
  render();
  mount(
    pageHead(h('a', { href: '#/t/classes' }, '← クラス'), 'クラスの編集'),
    box,
    h('div', { class: 'sticky-save' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, '保存する'), statusEl, h('span', { class: 'spacer' }), delBtn));
}

// ---------------------------------------------------------------- teacher: users
async function viewUsers() {
  const [uSnap, tSnap, setSnap, classes] = await Promise.all([
    getDocs(collection(db, 'users')),
    getDoc(doc(db, 'config', 'teachers')).catch(() => null),
    getDoc(doc(db, 'config', 'settings')).catch(() => null),
    loadClasses(),
  ]);
  const mine = myTeachingIds(classes);
  const sortUsers = (list) => list.sort((a, b) => (a.role === b.role ? 0 : a.role === 'teacher' ? -1 : 1) || byNumber(a, b));
  let users = sortUsers(uSnap.docs.map((d) => ({ uid: d.id, ...d.data() })));
  let teacherEmails = (tSnap && tSnap.exists() && Array.isArray(tSnap.data().emails)) ? [...tSnap.data().emails] : [];
  const settings = setSnap && setSnap.exists() ? setSnap.data() : {};

  // ---- 生徒アカウントの一括作成
  const bulk = h('textarea', { rows: 6, id: 'bulk', placeholder: '3101,山田 太郎\n3102,佐藤 花子' });
  const bulkMsg = h('div', { class: 'small' });
  const bulkResult = h('div');
  const bulkBtn = h('button', { class: 'btn primary', type: 'button' }, 'アカウントを作成');
  const bulkClass = h('select', { id: 'bulk-class', 'aria-label': '入れるクラス' },
    classes.map((c) => h('option', { value: c.id, selected: c.id === mine[0] }, c.name)), h('option', { value: '' }, 'クラスに入れない'));
  bulkBtn.onclick = async () => {
    const lines = bulk.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows = [], problems = [], seen = new Set();
    lines.forEach((l, i) => {
      const [no = '', ...rest] = l.split(/[,\t、，]/).map((x) => x.trim());
      const studentNo = normNo(no), name = rest.join(' ').trim();
      if (!STUDENT_NO_RE.test(studentNo) || !name) problems.push(`${i + 1}行目: 「出席番号（4桁）,名前」の形にしてください`);
      else if (seen.has(studentNo)) problems.push(`${i + 1}行目: 出席番号 ${studentNo} が重複しています`);
      else { seen.add(studentNo); rows.push({ studentNo, displayName: name.slice(0, 40) }); }
    });
    if (!rows.length || problems.length) { bulkMsg.className = 'small err'; bulkMsg.textContent = problems.join(' / ') || '1行に「出席番号,名前」の形で入力してください。'; return; }
    bulkBtn.disabled = true;
    bulkMsg.className = 'small muted';
    const a2 = await secondaryAuth();
    const results = [];
    for (const [i, r] of rows.entries()) {
      bulkMsg.textContent = `作成中… ${i + 1} / ${rows.length}`;
      const password = genPassword();
      try {
        const cred = await createUserWithEmailAndPassword(a2, studentEmail(r.studentNo), password);
        try {
          await setDoc(doc(db, 'users', cred.user.uid), { ...r, role: 'student', mustChangePassword: true, createdAt: Date.now(), classIds: bulkClass.value ? [bulkClass.value] : [] });
          if (bulkClass.value) await updateDoc(doc(db, 'classes', bulkClass.value), { studentIds: arrayUnion(cred.user.uid), updatedAt: Date.now() });
        } catch (e) { await cred.user.delete().catch(() => {}); throw e; }
        results.push({ ...r, password, ok: true });
      } catch (e) {
        results.push({ ...r, ok: false, error: e.code === 'auth/email-already-in-use' ? 'この出席番号はすでに登録されています' : errMsg(e) });
      } finally { await signOut(a2).catch(() => {}); }
    }
    bulkBtn.disabled = false;
    const okRows = results.filter((r) => r.ok);
    bulkMsg.className = 'small ' + (okRows.length === results.length ? 'ok' : 'err');
    bulkMsg.textContent = `${okRows.length}件作成しました` + (okRows.length < results.length ? `（${results.length - okRows.length}件は失敗）` : '') + '。初期パスワードはこの画面を離れると再表示できません。控えてから生徒に配ってください。';
    const tsv = ['出席番号\t名前\t初期パスワード', ...okRows.map((r) => [r.studentNo, r.displayName, r.password].join('\t'))].join('\n');
    fill(bulkResult, 
      h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(tsv); toast('コピーしました（表計算ソフトに貼り付けられます）'); } catch (e) { toast('コピーできませんでした'); } } }, '一覧をコピー'),
        h('button', { class: 'btn small', type: 'button', onclick: () => downloadText(`初期パスワード_${today()}.csv`, tsv.replace(/\t/g, ',')) }, 'CSVで保存')),
      h('div', { class: 'tscroll' }, h('table', { class: 'pw-list' },
        h('thead', null, h('tr', null, h('th', null, '出席番号'), h('th', null, '名前'), h('th', null, '初期パスワード / 結果'))),
        h('tbody', null, results.map((r) => h('tr', null, h('td', null, r.studentNo), h('td', null, r.displayName),
          h('td', { class: r.ok ? '' : 'err' }, r.ok ? r.password : r.error)))))));
    if (okRows.length) { bulk.value = ''; await refreshList(); }
  };
  const bulkCard = h('div', { class: 'card' },
    h('h2', null, '生徒アカウントをまとめて作成'),
    h('p', { class: 'small muted' }, '1行に1人、「出席番号（4桁）,名前」の順で入力します（表計算ソフトからの貼り付けも可）。初期パスワードは自動で作られます。生徒は「出席番号・名前・パスワード」でログインし、最初に自分のパスワードへ変更します。'),
    bulk, h('div', { class: 'row' }, h('label', { class: 'label', for: 'bulk-class' }, '入れるクラス'), bulkClass, bulkBtn), bulkMsg, bulkResult);

  // ---- アカウント一覧
  const listBox = h('div', { class: 'tscroll' });
  const filterSel = h('select', { 'aria-label': '出席番号で絞り込み' });
  filterSel.onchange = () => renderList();
  async function refreshList() {
    const s = await getDocs(collection(db, 'users'));
    users = sortUsers(s.docs.map((d) => ({ uid: d.id, ...d.data() })));
    renderList();
  }
  const call = (name) => httpsCallable(fns, name);

  function renderList() {
    const cur = filterSel.value;
    fill(filterSel, h('option', { value: '' }, 'すべて'), h('option', { value: 'teacher', selected: cur === 'teacher' }, '先生のみ'),
      h('option', { value: 'noclass', selected: cur === 'noclass' }, 'クラスに入っていない生徒'),
      classes.map((c) => h('option', { value: 'c:' + c.id, selected: cur === 'c:' + c.id }, c.name)),
      prefixesOf(users).map((p) => h('option', { value: p, selected: p === cur }, `${p}xx`)));
    const f = filterSel.value;
    const shown = users.filter((u) => {
      if (!f) return true;
      if (f === 'teacher') return u.role === 'teacher';
      if (f === 'noclass') return u.role === 'student' && !(u.classIds || []).length;
      if (f.startsWith('c:')) { const id = f.slice(2); return u.role === 'student' ? (u.classIds || []).includes(id) : (classes.find((x) => x.id === id)?.teacherIds || []).includes(u.uid); }
      return u.role === 'student' && (u.studentNo || '').startsWith(f);
    });
    fill(listBox, h('table', null,
      h('thead', null, h('tr', null, h('th', null, '出席番号 / メール'), h('th', null, '名前'), h('th', null, '役割'), h('th', null, 'クラス'), h('th', null, 'パスワード'), h('th', null, '操作'))),
      h('tbody', null, shown.map((u) => userRow(u)))));
  }

  function userRow(u) {
    const tr = h('tr');
    const isMe = u.uid === S.user.uid;
    const student = u.role === 'student';
    const pwCell = h('td', null, !student ? h('span', { class: 'small muted' }, 'メールで再設定') : u.mustChangePassword ? h('span', { class: 'pill warn' }, '初期パスワードのまま') : h('span', { class: 'pill muted' }, '変更済み'));
    const actions = h('td', { class: 'row', style: 'flex-wrap:nowrap' });
    actions.append(h('button', { class: 'btn small', type: 'button', onclick: () => editRow() }, '名前を編集'));
    if (fns && student) {
      actions.append(confirmButton('パスワード再発行', 'もう一度押すと再発行', async () => {
        try { const r = await call('resetPassword')({ uid: u.uid }); u.mustChangePassword = true; fill(pwCell, h('span', { class: 'num' }, `新しいパスワード: ${r.data.password}`)); }
        catch (e) { toast(errMsg(e)); }
      }, 'btn small'));
    }
    if (!isMe) {
      actions.append(confirmButton('削除', student ? 'もう一度押すと記録ごと削除' : 'もう一度押すと削除', async () => {
        try {
          if (fns) await call('deleteAccount')({ uid: u.uid });
          for (const col of ['scores', 'notes']) {
            const s = await getDocs(query(collection(db, col), where('uid', '==', u.uid)));
            const b = writeBatch(db); s.docs.forEach((d) => b.delete(d.ref)); if (s.docs.length) await b.commit();
          }
          if (student) await deleteDoc(doc(db, 'goals', u.uid)).catch(() => {});
          for (const c of classes) {
            if ((c.studentIds || []).includes(u.uid)) await updateDoc(doc(db, 'classes', c.id), { studentIds: arrayRemove(u.uid) });
            if ((c.teacherIds || []).includes(u.uid)) await updateDoc(doc(db, 'classes', c.id), { teacherIds: arrayRemove(u.uid) });
          }
          await deleteDoc(doc(db, 'users', u.uid));
          users = users.filter((x) => x.uid !== u.uid);
          renderList();
          toast(fns ? '削除しました' : '削除しました（ログイン情報は Firebase コンソールの Authentication から削除してください）');
        } catch (e) { toast(errMsg(e)); }
      }));
    }
    tr.append(h('td', { class: 'num' }, student ? u.studentNo : u.email), h('td', null, u.displayName),
      h('td', null, student ? '生徒' : h('span', { class: 'pill accent' }, '先生')),
      h('td', { class: 'small wrap' }, (() => {
        // 生徒は自分の「所属クラス」、先生はクラスの担当者から
        const names = student ? classNames(u.classIds, classes) : classes.filter((c) => (c.teacherIds || []).includes(u.uid)).map((c) => c.name);
        return names.length ? names.join('、') : h('span', { class: student ? 'pill warn' : 'muted' }, student ? '未所属' : '—');
      })()),
      pwCell, actions);

    function editRow() {
      const nm = h('input', { type: 'text', value: u.displayName, maxlength: 40, 'aria-label': '名前' });
      const save = h('button', {
        class: 'btn small primary', type: 'button', onclick: async () => {
          const name = nm.value.trim();
          if (!name) return;
          try { await updateDoc(doc(db, 'users', u.uid), { displayName: name }); u.displayName = name; renderList(); toast('保存しました'); }
          catch (e) { toast(errMsg(e)); }
        },
      }, '保存');
      fill(tr, h('td', { class: 'num' }, student ? u.studentNo : u.email), h('td', null, nm), h('td'), h('td'), h('td'),
        h('td', { class: 'row', style: 'flex-wrap:nowrap' }, save, h('button', { class: 'btn small', type: 'button', onclick: () => renderList() }, 'やめる')));
    }
    return tr;
  }

  // ---- 先生として登録できるメールアドレス
  const tBox = h('div', { class: 'stack', style: 'gap:6px' });
  const tIn = h('input', { type: 'email', id: 't-mail', placeholder: 'sensei@example.ed.jp', style: 'flex:1;min-width:14em' });
  const tMsg = h('span', { class: 'small' });
  async function saveEmails(next) {
    try { await setDoc(doc(db, 'config', 'teachers'), { emails: next }); teacherEmails = next; renderEmails(); tMsg.className = 'small ok'; tMsg.textContent = '保存しました'; }
    catch (e) { tMsg.className = 'small err'; tMsg.textContent = errMsg(e); }
  }
  function renderEmails() {
    fill(tBox, ...teacherEmails.map((m) => h('div', { class: 'row' },
      h('span', { class: 'num' }, m),
      users.some((u) => u.email === m) ? h('span', { class: 'pill good' }, '登録済み') : h('span', { class: 'pill muted' }, '未登録'),
      m === S.profile.email ? null : h('button', { class: 'btn small danger', type: 'button', onclick: () => saveEmails(teacherEmails.filter((x) => x !== m)) }, '一覧から外す'))));
  }
  const tAdd = h('button', {
    class: 'btn', type: 'button', onclick: () => {
      const m = tIn.value.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m)) { tMsg.className = 'small err'; tMsg.textContent = 'メールアドレスの形を確認してください。'; return; }
      if (teacherEmails.includes(m)) { tMsg.className = 'small muted'; tMsg.textContent = 'すでに一覧にあります。'; return; }
      tIn.value = '';
      saveEmails([...teacherEmails, m]);
    },
  }, '追加');
  const teacherCard = h('div', { class: 'card' },
    h('h2', null, '先生として登録できるメールアドレス'),
    h('p', { class: 'small muted' }, 'ここに追加したメールアドレスの人だけが、「先生の新規登録」から先生として登録できます（メールの確認が必要です）。一覧から外しても、すでに登録済みのアカウントは残るので、不要なら上の一覧から削除してください。'),
    tBox, h('div', { class: 'row' }, tIn, tAdd, tMsg));

  // ---- 生徒の自己登録
  const selfChk = h('input', { type: 'checkbox', id: 'self-signup', checked: !!settings.selfSignup });
  const selfMsg = h('span', { class: 'small' });
  selfChk.onchange = async () => {
    try { await setDoc(doc(db, 'config', 'settings'), { selfSignup: selfChk.checked }); settingsCache = null; selfMsg.className = 'small ok'; selfMsg.textContent = selfChk.checked ? '受け付けを始めました' : '受け付けを止めました'; }
    catch (e) { selfChk.checked = !selfChk.checked; selfMsg.className = 'small err'; selfMsg.textContent = errMsg(e); }
  };
  const selfCard = h('div', { class: 'card' },
    h('h2', null, '生徒の自己登録'),
    h('label', { class: 'row' }, selfChk, '生徒が自分でアカウントを作れるようにする', selfMsg),
    h('p', { class: 'small muted' }, 'オンの間は、ログイン画面に「アカウントを作成」が表示され、生徒が出席番号・名前・パスワードを決めて登録できます。出席番号を知っていれば誰でも登録できてしまうため、全員の登録が終わったらオフにしてください。'));

  mount(
    h('div', { class: 'page-head' }, h('div', null, h('div', { class: 'eyebrow' }, '先生用'), h('h1', null, '生徒・アカウント'))),
    !fns ? h('p', { class: 'notice small' }, '生徒がパスワードを忘れた場合: Cloud Functions を有効にすると、この画面から再発行できます（README参照）。有効にしていない場合は、Firebase コンソールの Authentication でその生徒を削除し、ここで同じ出席番号のアカウントを作り直してください（記録は引き継がれません）。') : null,
    bulkCard,
    h('section', { class: 'stack' }, h('div', { class: 'row' }, h('h2', null, 'アカウント一覧'), h('span', { class: 'spacer' }), h('span', { class: 'label' }, '絞り込み'), filterSel), listBox),
    teacherCard,
    selfCard,
  );
  renderList();
  renderEmails();
}
