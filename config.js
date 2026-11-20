// ตั้งค่าโครงการ — แก้ไฟล์นี้ไฟล์เดียวเมื่อย้ายที่เก็บโมเดล
window.APP_CONFIG = {
  projectTitle: "TCT — บันทึกความเสียหาย",
  // ที่อยู่ไฟล์ metadata.json ของ Potree 2.0
  pointCloudUrl: "https://infraplus-ru.org/web-proj/potreeconverter-data/TCT/model/OUTPUT/metadata.json",
  // มุมมองเริ่มต้น (พิกัด UTM 47N เหมือนลิงก์ TCT01 เดิม)
  startView: { x: 668232.968, y: 1509954.001, z: 66.6, yaw: -0.1, pitch: -0.45 },
  tagsUrl: "tags.json",
  // ฐานข้อมูลออนไลน์: Google Sheet/Drive ผ่าน Apps Script (บัญชี siriphong10@gmail.com)
  gasUrl: "https://script.google.com/macros/s/AKfycbxWCmEiFaKL6MnJnyH2-Cmwu4mg2ovoYsa-kHwz90tg4wpEaoy36Opa7LcBR1SBDuJn/exec",
  pollMs: 30000,
  // Firebase เดิม (เลิกใช้ 20 พ.ย. 2569 — เก็บค่าไว้อ้างอิงเท่านั้น ระบบใช้ gasUrl ก่อนเสมอ) — ค่าเหล่านี้เปิดเผยได้ตามปกติ สิทธิ์ควบคุมด้วย security rules
  firebase: {
    apiKey: "AIzaSyBTzLOFaNySTIjj-61VjK39EFBc95iToZk",
    authDomain: "tct-damage-viewer.firebaseapp.com",
    projectId: "tct-damage-viewer",
    storageBucket: "tct-damage-viewer.firebasestorage.app",
    messagingSenderId: "550927735384",
    appId: "1:550927735384:web:d09371d9b4162b17f3882d"
  },
  projectKey: "TCT",
  ownerEmail: "siriphong10@gmail.com",
  // จำนวนจุดสูงสุดที่แสดงพร้อมกัน
  pointBudgetDesktop: 3000000,
  pointBudgetMobile: 1000000
};
