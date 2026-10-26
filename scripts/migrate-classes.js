'use strict';
// データの変換（デプロイのたびに GitHub Actions から実行。必要なときだけ動く）
//   1. クラス機能: 生徒・テスト・セットに classIds / visibleTo を追加し、既存の全員を「既存のクラス」に入れる
//   2. 科目: 分野リストに科目（subjects）を追加し、テスト・分野に subjectId を追加する
//      （テスト名に科目名が入っていれば、その科目を割り当てる。分かれないものは null ＝ 科目未設定）
//
// - 既存のデータは削除しない。足りない項目を追加するだけ（分野リストは配列なので、元の項目を残したまま書き直す）。
// - 変換する前に、全データを Firestore の backups コレクションに保存する（アプリからは誰も読めない）。
// - リポジトリが公開なので、ログには件数だけを出し、名前などは出さない。
// - 途中で失敗したら終了コード 1 で止まり、新しいアプリは公開されない。
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp({ projectId: process.env.FIREBASE_PROJECT || 'point-check-9ca84' });
const db = getFirestore();

const DEFAULT_CLASS_ID = 'existing';
const BACKUP_COLLECTIONS = ['users', 'classes', 'tests', 'sets', 'scores', 'notes', 'goals', 'fieldLists', 'config', 'workbooks'];
const CHUNK_BYTES = 600 * 1024;

// はじめから入れておく科目（共通テストは令和7年度以降の出題科目）
const DEFAULT_SUBJECTS = {
  kyotsu: ['国語', '地理総合・地理探究', '歴史総合・日本史探究', '歴史総合・世界史探究', '公共・倫理', '公共・政治・経済',
    '地理総合／歴史総合／公共', '数学Ⅰ・A', '数学Ⅰ', '数学Ⅱ・B・C', '物理基礎', '化学基礎', '生物基礎', '地学基礎',
    '物理', '化学', '生物', '地学', '英語リーディング', '英語リスニング', '情報Ⅰ'],
  other: ['国語', '数学', '英語', '理科', '地歴・公民', '情報'],
};
const subjectIdOf = (cat, i) => `${cat}_s${String(i + 1).padStart(2, '0')}`;
// 「数学Ⅰ・A」と「数学ⅠA」「数学IA」を同じとみなすための正規化
const norm = (s) => String(s || '').normalize('NFKC').replace(/[\s・･\/／]/g, '').toUpperCase();
// テスト名から科目を推測（いちばん長く一致する科目。見つからなければ null）
function guessSubject(title, subjects) {
  const t = norm(title);
  let best = null;
  for (const s of subjects) { const n = norm(s.name); if (n && t.includes(n) && (!best || n.length > norm(best.name).length)) best = s; }
  return best ? best.id : null;
}

async function backup(reason) {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const root = db.collection('backups').doc(id);
  await root.set({ createdAt: Date.now(), reason });
  let total = 0;
  for (const col of BACKUP_COLLECTIONS) {
    const snap = await db.collection(col).get();
    let chunk = [], bytes = 0, part = 0;
    const flush = async () => {
      if (!chunk.length) return;
      await root.collection('chunks').doc(`${col}-${part++}`).set({ col, json: JSON.stringify(chunk) });
      chunk = []; bytes = 0;
    };
    for (const d of snap.docs) {
      const entry = { id: d.id, data: d.data() };
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > CHUNK_BYTES) await flush();
      chunk.push(entry); bytes += size; total++;
    }
    await flush();
    // 保存できたか読み直して件数を確かめる
    const saved = await root.collection('chunks').where('col', '==', col).get();
    const savedCount = saved.docs.reduce((a, d) => a + JSON.parse(d.get('json')).length, 0);
    if (savedCount !== snap.size) throw new Error(`バックアップの件数が合いません: ${col} ${savedCount}/${snap.size}`);
  }
  await root.update({ total, completedAt: Date.now() });
  console.log(`バックアップを保存しました: backups/${id}（${total}件）`);
}

async function commitInBatches(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    for (const [ref, data] of ops.slice(i, i + 400)) batch.update(ref, data);
    await batch.commit();
  }
}

async function main() {
  const [users, tests, sets] = await Promise.all(['users', 'tests', 'sets'].map((c) => db.collection(c).get()));
  const students = users.docs.filter((d) => d.get('role') === 'student');
  const teachers = users.docs.filter((d) => d.get('role') === 'teacher');
  const needStudents = students.filter((d) => !Array.isArray(d.get('classIds')));
  const lacks = (d) => !Array.isArray(d.get('classIds')) || !Array.isArray(d.get('visibleTo'));
  const needTests = tests.docs.filter(lacks);
  const needSets = sets.docs.filter(lacks);
  const fieldDocs = await Promise.all(['kyotsu', 'other'].map((c) => db.collection('fieldLists').doc(c).get()));
  const needSubjectLists = fieldDocs.filter((d) => !d.exists || !Array.isArray(d.get('subjects')) || (d.get('fields') || []).some((f) => !('subjectId' in f)));
  const needTestSubjects = tests.docs.filter((d) => d.get('subjectId') === undefined);
  console.log(`生徒 ${students.length}人（変換が必要 ${needStudents.length}）・テスト ${tests.size}（${needTests.length}）・セット ${sets.size}（${needSets.length}）`);
  console.log(`科目: 分野リスト（変換が必要 ${needSubjectLists.length}）・テストの科目（${needTestSubjects.length}）`);
  if (!needStudents.length && !needTests.length && !needSets.length && !needSubjectLists.length && !needTestSubjects.length) {
    console.log('変換が必要なデータはありません。');
    return;
  }

  await backup(needStudents.length || needTests.length || needSets.length ? 'クラス機能への変換前' : '科目への変換前');
  await migrateClasses({ students, teachers, needStudents, needTests, needSets });
  await migrateSubjects({ tests, fieldDocs, needTestSubjects });
}

async function migrateClasses({ teachers, needStudents, needTests, needSets }) {
  if (!needStudents.length && !needTests.length && !needSets.length) return;

  // 既存の全員が入った「既存のクラス」（すでにあれば生徒を追加するだけ）
  const defRef = db.collection('classes').doc(DEFAULT_CLASS_ID);
  const def = await defRef.get();
  if (!def.exists) {
    await defRef.set({
      name: '既存のクラス', teacherIds: teachers.map((d) => d.id), studentIds: needStudents.map((d) => d.id),
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    console.log('「既存のクラス」を作りました。');
  } else if (needStudents.length) {
    for (let i = 0; i < needStudents.length; i += 100) {
      await defRef.update({ studentIds: FieldValue.arrayUnion(...needStudents.slice(i, i + 100).map((d) => d.id)), updatedAt: Date.now() });
    }
  }

  const ops = [];
  for (const d of needStudents) ops.push([d.ref, { classIds: [DEFAULT_CLASS_ID] }]);
  for (const d of [...needTests, ...needSets]) {
    const classIds = Array.isArray(d.get('classIds')) ? d.get('classIds') : [DEFAULT_CLASS_ID];
    ops.push([d.ref, { classIds, visibleTo: d.get('published') === true ? classIds : [] }]);
  }
  await commitInBatches(ops);
  console.log(`変換しました: 生徒 ${needStudents.length}人・テスト ${needTests.length}・セット ${needSets.length}（削除したデータはありません）`);
}

async function migrateSubjects({ tests, fieldDocs, needTestSubjects }) {
  const lists = {};
  for (const d of fieldDocs) {
    const cat = d.id;
    const data = d.exists ? d.data() : {};
    const subjects = Array.isArray(data.subjects) ? data.subjects : DEFAULT_SUBJECTS[cat].map((name, i) => ({ id: subjectIdOf(cat, i), name }));
    lists[cat] = { ref: d.ref, exists: d.exists, data, subjects, fields: Array.isArray(data.fields) ? data.fields : [] };
  }
  // テストの科目（テスト名から推測）
  const testSubject = {};
  const ops = [];
  for (const d of tests.docs) {
    const cat = d.get('category') === 'kyotsu' ? 'kyotsu' : 'other';
    let sid = d.get('subjectId');
    if (sid === undefined) { sid = guessSubject(d.get('title'), lists[cat].subjects); ops.push([d.ref, { subjectId: sid }]); }
    testSubject[d.id] = { cat, sid };
  }
  // 分野の科目（その分野を使うテストがすべて同じ科目なら、その科目）
  for (const [cat, l] of Object.entries(lists)) {
    const used = {};
    for (const d of tests.docs) {
      if (testSubject[d.id].cat !== cat) continue;
      for (const q of d.get('questions') || []) if (q.fieldId) (used[q.fieldId] = used[q.fieldId] || new Set()).add(testSubject[d.id].sid);
    }
    let changed = !l.exists || !Array.isArray(l.data.subjects);
    const fields = l.fields.map((f) => {
      if ('subjectId' in f) return f;
      changed = true;
      const s = used[f.id];
      return { ...f, subjectId: s && s.size === 1 && [...s][0] ? [...s][0] : null };
    });
    if (!changed) continue;
    // 元の項目（fields の各分野の id・name、updatedAt など）は残し、subjects と subjectId を足す
    await l.ref.set({ ...l.data, fields, subjects: l.subjects, updatedAt: Date.now() });
  }
  await commitInBatches(ops);
  const assigned = ops.filter(([, d]) => d.subjectId).length;
  console.log(`科目を追加しました: テスト ${ops.length}（うち科目を割り当て ${assigned}）（削除したデータはありません）`);
}

main().catch((e) => { console.error('変換に失敗しました:', e.message); process.exit(1); });
