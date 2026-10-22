// 任意: 教師画面から「パスワード再発行」「ログインアカウントの削除」を行うための Cloud Functions。
// Blaze（従量課金）プランが必要です。使う場合は public/firebase-config.js の functionsEnabled を true にしてください。
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('node:crypto');

initializeApp();
const REGION = 'asia-northeast1';

async function assertTeacher(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'ログインしてください。');
  const me = await getFirestore().doc(`users/${req.auth.uid}`).get();
  if (!me.exists || me.get('role') !== 'teacher') throw new HttpsError('permission-denied', '教師のみ実行できます。');
}

function targetUid(req) {
  const uid = typeof req.data?.uid === 'string' ? req.data.uid : '';
  if (!/^[A-Za-z0-9]{1,128}$/.test(uid)) throw new HttpsError('invalid-argument', 'uid が不正です。');
  if (uid === req.auth.uid) throw new HttpsError('failed-precondition', '自分自身には実行できません。');
  return uid;
}

function genPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(8), (b) => chars[b % chars.length]).join('');
}

exports.resetPassword = onCall({ region: REGION }, async (req) => {
  await assertTeacher(req);
  const uid = targetUid(req);
  const profile = getFirestore().doc(`users/${uid}`);
  if (!(await profile.get()).exists) throw new HttpsError('not-found', 'ユーザーが見つかりません。');
  const password = genPassword();
  await getAuth().updateUser(uid, { password });
  await profile.update({ mustChangePassword: true });
  return { password };
});

exports.deleteAccount = onCall({ region: REGION }, async (req) => {
  await assertTeacher(req);
  const uid = targetUid(req);
  try {
    await getAuth().deleteUser(uid);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }
  return { ok: true };
});
