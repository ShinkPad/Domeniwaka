// Firebase コンソールの「プロジェクトの設定 → マイアプリ → SDK の設定と構成」に出る値を貼り付けてください。
// 空のままだと「お試しモード」（この端末のブラウザ内だけに保存、共有なし）で動きます。
window.NIWAKA_FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

// 管理者の Google アカウント（メールアドレス）。ここは画面の表示用で、
// 実際の権限は firestore.rules の admins() に同じアドレスを書いて決めます。
window.NIWAKA_ADMIN_EMAILS = [
  // "example@gmail.com",
];

// 地図を最初に表示する場所（久世駅周辺）とズーム
window.NIWAKA_START_VIEW = { lat: 35.0730, lng: 133.7535, zoom: 16 };
