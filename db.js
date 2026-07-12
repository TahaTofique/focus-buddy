/**
 * db.js — Local-only IndexedDB storage for Focus Buddy.
 *
 * Everything lives in this browser's IndexedDB. No network request is
 * ever made to persist data — nothing is sent to a server, ever.
 * Only aggregated per-second signals are stored, never video frames.
 */

const FocusDB = (() => {
  const DB_NAME = "focus_buddy";
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("sessions")) {
          const store = db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
          store.createIndex("startedAt", "startedAt");
        }
        if (!db.objectStoreNames.contains("ticks")) {
          const store = db.createObjectStore("ticks", { keyPath: "id", autoIncrement: true });
          store.createIndex("sessionId", "sessionId");
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  async function startSession(label) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      const req = tx.objectStore("sessions").add({
        label: label || "",
        startedAt: Date.now(),
        endedAt: null,
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function endSession(sessionId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      const store = tx.objectStore("sessions");
      const getReq = store.get(sessionId);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (record) {
          record.endedAt = Date.now();
          store.put(record);
        }
        resolve();
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function logTick(sessionId, facePresent, lookingAtScreen, phoneDetected, focusScore) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("ticks", "readwrite");
      tx.objectStore("ticks").add({
        sessionId,
        ts: Date.now(),
        facePresent,
        lookingAtScreen,
        phoneDetected,
        focusScore,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getSessions() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readonly");
      const req = tx.objectStore("sessions").getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.startedAt - a.startedAt));
      req.onerror = () => reject(req.error);
    });
  }

  async function getTicks(sessionId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("ticks", "readonly");
      const idx = tx.objectStore("ticks").index("sessionId");
      const req = idx.getAll(IDBKeyRange.only(sessionId));
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.ts - b.ts));
      req.onerror = () => reject(req.error);
    });
  }

  function summarize(ticks) {
    if (!ticks.length) {
      return { n: 0, avgScore: 0, pctPresent: 0, pctLooking: 0, phonePickups: 0 };
    }
    const n = ticks.length;
    const avgScore = ticks.reduce((s, t) => s + t.focusScore, 0) / n;
    const pctPresent = ticks.filter((t) => t.facePresent).length / n;
    const pctLooking = ticks.filter((t) => t.lookingAtScreen).length / n;
    const phonePickups = ticks.filter((t) => t.phoneDetected).length;
    return { n, avgScore, pctPresent, pctLooking, phonePickups };
  }

  async function clearAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "ticks"], "readwrite");
      tx.objectStore("sessions").clear();
      tx.objectStore("ticks").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { startSession, endSession, logTick, getSessions, getTicks, summarize, clearAll };
})();
