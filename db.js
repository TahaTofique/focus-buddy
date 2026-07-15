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

  async function startSession(label, mode = "study") {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      const req = tx.objectStore("sessions").add({
        label: label || "",
        mode,
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

  async function logTick(sessionId, signals, focusScore) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("ticks", "readwrite");
      tx.objectStore("ticks").add({
        sessionId,
        ts: Date.now(),
        facePresent: !!signals.facePresent,
        lookingAtScreen: !!signals.lookingAtScreen,
        phoneDetected: !!signals.phoneDetected,
        eyesClosed: !!signals.eyesClosed,
        talking: !!signals.talking,
        excessiveMovement: !!signals.excessiveMovement,
        tabAway: !!signals.tabAway,
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
      return {
        n: 0, avgScore: 0, pctPresent: 0, pctLooking: 0,
        phonePickups: 0, eyesClosedSecs: 0, talkingSecs: 0, movementSecs: 0,
        tabAwaySecs: 0, tabSwitches: 0, awayEvents: 0,
      };
    }
    const n = ticks.length;
    const avgScore = ticks.reduce((s, t) => s + t.focusScore, 0) / n;
    const pctPresent = ticks.filter((t) => t.facePresent).length / n;
    const pctLooking = ticks.filter((t) => t.lookingAtScreen).length / n;
    const phonePickups = ticks.filter((t) => t.phoneDetected).length;
    const eyesClosedSecs = ticks.filter((t) => t.eyesClosed).length;
    const talkingSecs = ticks.filter((t) => t.talking).length;
    const movementSecs = ticks.filter((t) => t.excessiveMovement).length;
    const tabAwaySecs = ticks.filter((t) => t.tabAway).length;
    let tabSwitches = 0;
    let awayEvents = 0;
    for (let i = 1; i < ticks.length; i++) {
      if (ticks[i].tabAway && !ticks[i - 1].tabAway) tabSwitches++;
      if (!ticks[i].facePresent && ticks[i - 1].facePresent) awayEvents++;
    }
    return {
      n, avgScore, pctPresent, pctLooking, phonePickups,
      eyesClosedSecs, talkingSecs, movementSecs, tabAwaySecs, tabSwitches, awayEvents,
    };
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

  async function exportCsv() {
    const sessions = await getSessions();
    const rows = [["id", "started_at", "ended_at", "mode", "label", "avg_score",
      "pct_present", "pct_looking", "phone_pickups", "eyes_closed_secs",
      "talking_secs", "movement_secs", "tab_away_secs", "tab_switches", "away_events"]];
    for (const s of sessions) {
      const ticks = await getTicks(s.id);
      const sum = summarize(ticks);
      rows.push([
        s.id,
        new Date(s.startedAt).toISOString(),
        s.endedAt ? new Date(s.endedAt).toISOString() : "",
        s.mode || "study",
        (s.label || "").replace(/,/g, ";"),
        sum.avgScore.toFixed(1),
        (sum.pctPresent * 100).toFixed(0),
        (sum.pctLooking * 100).toFixed(0),
        sum.phonePickups,
        sum.eyesClosedSecs,
        sum.talkingSecs,
        sum.movementSecs,
        sum.tabAwaySecs,
        sum.tabSwitches,
        sum.awayEvents,
      ]);
    }
    return rows.map((r) => r.join(",")).join("\n");
  }

  return { startSession, endSession, logTick, getSessions, getTicks, summarize, clearAll, exportCsv };
})();
