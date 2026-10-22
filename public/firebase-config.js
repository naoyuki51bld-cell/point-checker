// Firebase プロジェクト point-check-9ca84 の設定（Firebase コンソール →「プロジェクトの設定」→「マイアプリ」の値）。
// この値はブラウザに公開される前提のもので、秘密情報ではありません。アクセス制御は firestore.rules で行います。
export const firebaseConfig = {
  apiKey: 'AIzaSyAAq4UR9BsW6lxEMLOrMYXzXxBOBJVPa9s',
  authDomain: 'point-check-9ca84.firebaseapp.com',
  projectId: 'point-check-9ca84',
  storageBucket: 'point-check-9ca84.firebasestorage.app',
  messagingSenderId: '8090874841',
  appId: '1:8090874841:web:4ecd3d2b95bee81e8b9fc8',
  measurementId: 'G-YZT79NBLPF',
};

export const appConfig = {
  // アプリの表示名
  appName: 'デジタル得点表',
  // ユーザー名を Firebase Authentication 用のメールアドレス形式に変換するためのドメイン。
  // 実在しなくてよい。firestore.rules の usernameDomain() と必ず同じ値にする。
  usernameDomain: 'score-note.local',
  // Cloud Functions（functions/）をデプロイした場合は true に。
  // 教師画面から「パスワード再発行」「ログインアカウントの完全削除」ができるようになります（Blaze プランが必要）。
  functionsEnabled: false,
  functionsRegion: 'asia-northeast1',
  // ローカルの Firebase エミュレーターで動かすとき（localhost で開いたとき）に自動で接続する
  useEmulatorsOnLocalhost: true,
};
