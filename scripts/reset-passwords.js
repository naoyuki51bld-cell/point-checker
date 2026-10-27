'use strict';
// 生徒のパスワード再発行（GitHub Actions から10分ごと・または手動で実行）
//
// 先生がアプリで作った受付票（resetRequests/{生徒のuid}, status = 'pending'）を処理する。
// - 新しい仮パスワードを Firebase Authentication に設定し、受付票に書く（受付票は先生だけが読める）
// - 生徒には次のログインで自分のパスワードに変えてもらう（mustChangePassword = true）
// - 変えるのはパスワードだけ。点数・目標・クラスなどのデータには触れない
// - リポジトリが公開なので、ログには件数だけを出し、パスワードや名前は出さない
// - 処理済みの受付票は24時間たったら消す（仮パスワードを残しておかないため）
const crypto = require('node:crypto');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({ projectId: process.env.FIREBASE_PROJECT || 'point-check-9ca84' });
const db = getFirestore();
const auth = getAuth();
const KEEP_MS = 24 * 60 * 60 * 1000;

function genPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(8), (b) => chars[b % chars.length]).join('');
}

async function main() {
  const pending = await db.collection('resetRequests').where('status', '==', 'pending').get();
  let done = 0, failed = 0;
  for (const req of pending.docs) {
    const uid = req.id;
    const fail = async (message) => { failed++; await req.ref.update({ status: 'error', message, doneAt: Date.now() }); };
    try {
      const [student, teacher] = await Promise.all([
        db.doc(`users/${uid}`).get(),
        db.doc(`users/${req.get('requestedBy') || '_'}`).get(),
      ]);
      // 念のため、依頼したのが先生で、対象が生徒であることを確かめる
      if (!teacher.exists || teacher.get('role') !== 'teacher') { await fail('依頼した人が先生ではありません。'); continue; }
      if (!student.exists || student.get('role') !== 'student') { await fail('生徒のアカウントが見つかりません。'); continue; }
      const password = genPassword();
      await auth.updateUser(uid, { password });
      await db.doc(`users/${uid}`).update({ mustChangePassword: true });
      await req.ref.update({ status: 'done', password, doneAt: Date.now() });
      done++;
    } catch (e) {
      await fail(e.code === 'auth/user-not-found' ? 'ログイン情報が見つかりません（Firebase コンソールで削除されている可能性があります）。' : '再発行できませんでした。');
    }
  }
  // 古い受付票（処理済み・失敗）を消す
  const old = await db.collection('resetRequests').where('doneAt', '<', Date.now() - KEEP_MS).get();
  for (const d of old.docs) await d.ref.delete();
  console.log(`パスワード再発行: 受付 ${pending.size}件（再発行 ${done}・失敗 ${failed}）・古い受付票の削除 ${old.size}件`);
}

main().catch((e) => { console.error('処理に失敗しました:', e.message); process.exit(1); });
