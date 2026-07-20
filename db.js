/**
 * db.js — Local-only IndexedDB storage for Focus Buddy.
 *
 * Everything lives in this browser's IndexedDB. No network request is
 * ever made to persist data — nothing is sent to a server, ever.
 * Only aggregated per-second signals are stored, never video frames.
 */

const FocusDB = (() => {
  const DB_NAME = "focus_buddy";
  const DB_VERSION = 2; // v2 adds the "settings" store (persisted calibration, etc.)
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
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings"); // out-of-line keys, e.g. "calibration"
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  async function setSetting(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getSetting(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readonly");
      const req = tx.objectStore("settings").get(key);
      req.onsuccess = () => resolve(req.result !== undefined ? req.result : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteSetting(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("settings", "readwrite");
      tx.objectStore("settings").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Full local backup — every session, every per-second tick, and every
   * setting (calibration, templates, theme is in localStorage so it's
   * not included here). Downloadable as JSON, re-importable via
   * restoreBackup(). This is the answer to "what if I clear my browser
   * data" — everything otherwise lives only in this one IndexedDB.
   */
  async function exportBackup() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "ticks", "settings"], "readonly");
      const sessionsReq = tx.objectStore("sessions").getAll();
      const ticksReq = tx.objectStore("ticks").getAll();
      const settingsKeysReq = tx.objectStore("settings").getAllKeys();
      const settingsValsReq = tx.objectStore("settings").getAll();
      tx.oncomplete = () => {
        const settings = {};
        settingsKeysReq.result.forEach((k, i) => { settings[k] = settingsValsReq.result[i]; });
        resolve({
          app: "focus-buddy",
          version: 1,
          exportedAt: new Date().toISOString(),
          sessions: sessionsReq.result,
          ticks: ticksReq.result,
          settings,
        });
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Restores a backup produced by exportBackup(). This REPLACES all
   * current sessions/ticks/settings — it's a restore, not a merge, so
   * the caller should confirm with the user before calling this.
   * Explicit "id" keys on session/tick records are preserved (IndexedDB
   * accepts an explicit key on an autoIncrement store and advances its
   * internal counter past it), which keeps tick→session references intact.
   */
  async function restoreBackup(data) {
    if (!data || typeof data !== "object" || !Array.isArray(data.sessions) || !Array.isArray(data.ticks)) {
      throw new Error("This doesn't look like a Focus Buddy backup file.");
    }
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "ticks", "settings"], "readwrite");
      const sessionsStore = tx.objectStore("sessions");
      const ticksStore = tx.objectStore("ticks");
      const settingsStore = tx.objectStore("settings");
      sessionsStore.clear();
      ticksStore.clear();
      settingsStore.clear();
      for (const s of data.sessions) sessionsStore.put(s);
      for (const t of data.ticks) ticksStore.put(t);
      if (data.settings) {
        for (const [k, v] of Object.entries(data.settings)) settingsStore.put(v, k);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Session templates: saved {name, label, project, mode, duration} presets. */
  async function getTemplates() {
    const templates = await getSetting("templates");
    return Array.isArray(templates) ? templates : [];
  }

  async function saveTemplate(template) {
    const templates = await getTemplates();
    const existingIdx = templates.findIndex((t) => t.name === template.name);
    if (existingIdx >= 0) templates[existingIdx] = template;
    else templates.push(template);
    await setSetting("templates", templates);
    return templates;
  }

  async function deleteTemplate(name) {
    const templates = await getTemplates();
    const filtered = templates.filter((t) => t.name !== name);
    await setSetting("templates", filtered);
    return filtered;
  }

  async function startSession(label, mode = "study", project = "") {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      const req = tx.objectStore("sessions").add({
        label: label || "",
        mode,
        project: project || "",
        notes: "",
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

  /** Generic partial update — used for notes autosave and project edits. */
  async function updateSession(sessionId, patch) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      const store = tx.objectStore("sessions");
      const getReq = store.get(sessionId);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (record) {
          Object.assign(record, patch);
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
      const tx = db.transaction(["sessions", "ticks", "settings"], "readwrite");
      tx.objectStore("sessions").clear();
      tx.objectStore("ticks").clear();
      tx.objectStore("settings").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function exportCsv() {
    const sessions = await getSessions();
    const rows = [["id", "started_at", "ended_at", "mode", "project", "label", "notes", "avg_score",
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
        (s.project || "").replace(/,/g, ";"),
        (s.label || "").replace(/,/g, ";"),
        (s.notes || "").replace(/,/g, ";").replace(/\n/g, " | "),
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

  /**
   * Timesheet-format export: Date, Project, Task, Duration (decimal
   * hours), Notes — the shape most time-tracking/billing tools (Toggl,
   * Harvest, etc.) expect for CSV import. Deliberately omits engagement
   * metrics entirely; this is for time accounting, not attention data.
   */
  async function exportTimesheetCsv() {
    const sessions = await getSessions();
    const rows = [["Date", "Project", "Task", "Duration (hours)", "Notes"]];
    for (const s of sessions) {
      if (!s.endedAt) continue; // only completed sessions have a duration
      const hours = (s.endedAt - s.startedAt) / 3600000;
      rows.push([
        new Date(s.startedAt).toLocaleDateString("en-CA"), // YYYY-MM-DD, widely accepted
        (s.project || "").replace(/,/g, ";"),
        (s.label || "Untitled").replace(/,/g, ";"),
        hours.toFixed(2),
        (s.notes || "").replace(/,/g, ";").replace(/\n/g, " | "),
      ]);
    }
    return rows.map((r) => r.join(",")).join("\n");
  }

  return {
    startSession, endSession, updateSession, logTick, getSessions, getTicks, summarize, clearAll,
    exportCsv, exportTimesheetCsv, setSetting, getSetting, deleteSetting,
    exportBackup, restoreBackup, getTemplates, saveTemplate, deleteTemplate,
  };
})();
