// Firebase コンソールの「プロジェクトの設定 → マイアプリ → SDK の設定と構成」に出る値を貼り付けてください。
// 空のままだと「お試しモード」（この端末のブラウザ内だけに保存、共有なし）で動きます。
window.NIWAKA_FIREBASE_CONFIG = {
  apiKey: "AIzaSyD2SJc0cx89Sy4cLOzyDQhSPVp-vlM7kiU",
  authDomain: "niwakadome-kuse.firebaseapp.com",
  projectId: "niwakadome-kuse",
  storageBucket: "niwakadome-kuse.firebasestorage.app",
  messagingSenderId: "658000378000",
  appId: "1:658000378000:web:ff93e3afce09bf75c38015"
};

// 地図を最初に表示する場所（久世駅周辺）とズーム
window.NIWAKA_START_VIEW = { lat: 35.0730, lng: 133.7535, zoom: 16 };
