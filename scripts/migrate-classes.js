'use strict';
// クラス機能への変換（デプロイのたびに GitHub Actions から実行。必要なときだけ動く）
//
// - 既存のデータは削除も上書きもしない。足りない項目（classIds / visibleTo）を追加するだけ。
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
  console.log(`生徒 ${students.length}人（変換が必要 ${needStudents.length}）・テスト ${tests.size}（${needTests.length}）・セット ${sets.size}（${needSets.length}）`);
  if (!needStudents.length && !needTests.length && !needSets.length) {
    console.log('変換が必要なデータはありません。');
    return;
  }

  await backup('クラス機能への変換前');

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

main().catch((e) => { console.error('変換に失敗しました:', e.message); process.exit(1); });
