/**
 * insights.js — Cross-session aggregate stats, computed entirely
 * client-side from the same local IndexedDB history db.js already
 * stores. No new data collection, no network calls — just summarizing
 * what's already on disk in this browser.
 */

const FocusInsights = (() => {
  /**
   * @param {Array<{session: object, summary: object}>} withSummaries -
   *   sessions paired with their FocusDB.summarize() result
   * @param {string|null} projectFilter - if set, only sessions tagged
   *   with this exact project string are included
   */
  function compute(withSummaries, projectFilter = null) {
    const scoped = projectFilter
      ? withSummaries.filter((x) => (x.session.project || "") === projectFilter)
      : withSummaries;
    const completed = scoped.filter((x) => x.session.endedAt);
    if (!completed.length) {
      return {
        totalSessions: 0, totalMinutes: 0, allTimeAvg: 0, streak: 0,
        bestLabel: null, topDistraction: null, trend: [],
      };
    }

    const totalSessions = completed.length;
    const totalMinutes = completed.reduce((sum, x) => {
      return sum + (x.session.endedAt - x.session.startedAt) / 60000;
    }, 0);

    const scoredSessions = completed.filter((x) => x.summary.n > 0);
    const allTimeAvg = scoredSessions.length
      ? scoredSessions.reduce((s, x) => s + x.summary.avgScore, 0) / scoredSessions.length
      : 0;

    // Day streak: consecutive calendar days with >=1 session, walking
    // backward from today. If today has no session yet, that shouldn't
    // zero out an active streak — start the walk from yesterday instead.
    const dayKeys = new Set(completed.map((x) => new Date(x.session.startedAt).toDateString()));
    let streak = 0;
    const cursor = new Date();
    if (!dayKeys.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);
    while (dayKeys.has(cursor.toDateString())) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }

    // Best-performing label (only labels used 1+ times with score data).
    const byLabel = {};
    for (const x of scoredSessions) {
      const label = x.session.label || "Untitled";
      if (!byLabel[label]) byLabel[label] = [];
      byLabel[label].push(x.summary.avgScore);
    }
    let bestLabel = null;
    let bestLabelAvg = -1;
    for (const [label, scores] of Object.entries(byLabel)) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      if (avg > bestLabelAvg) { bestLabelAvg = avg; bestLabel = label; }
    }

    // Most frequent distraction type across all history. These are on
    // different scales (seconds vs event counts), so this is directional
    // ("what shows up most often relative to itself"), not a precise
    // apples-to-apples ranking — noted in the UI/README as a caveat.
    const totals = { phone: 0, eyesClosed: 0, movement: 0, tabSwitches: 0, awayEvents: 0 };
    for (const x of completed) {
      totals.phone += x.summary.phonePickups || 0;
      totals.eyesClosed += x.summary.eyesClosedSecs || 0;
      totals.movement += x.summary.movementSecs || 0;
      totals.tabSwitches += x.summary.tabSwitches || 0;
      totals.awayEvents += x.summary.awayEvents || 0;
    }
    const labels = {
      phone: "Phone checks", eyesClosed: "Eyes closing", movement: "Restlessness",
      tabSwitches: "Tab switching", awayEvents: "Stepping away",
    };
    let topDistraction = null;
    let topVal = 0;
    for (const [key, val] of Object.entries(totals)) {
      if (val > topVal) { topVal = val; topDistraction = labels[key]; }
    }

    // Trend: avg score per session, most recent last, for the sparkline.
    const trend = completed
      .slice()
      .sort((a, b) => a.session.startedAt - b.session.startedAt)
      .slice(-20)
      .map((x) => Math.round(x.summary.avgScore || 0));

    return {
      totalSessions,
      totalMinutes: Math.round(totalMinutes),
      allTimeAvg: Math.round(allTimeAvg),
      streak,
      bestLabel: bestLabel && bestLabelAvg >= 0 ? { label: bestLabel, avg: Math.round(bestLabelAvg) } : null,
      topDistraction,
      trend,
    };
  }

  /** Distinct project tags across all sessions, sorted, for a filter dropdown. */
  function listProjects(withSummaries) {
    const set = new Set();
    for (const x of withSummaries) {
      if (x.session.project) set.add(x.session.project);
    }
    return Array.from(set).sort();
  }

  /**
   * Plain-text share-safe summary for one session — the "copy as email"
   * format. Deliberately excludes granular signals (phone/eyes/talking/
   * movement/tab-switch breakdown); includes only what's appropriate to
   * hand to someone else: title, project, duration, and one overall
   * engagement number.
   */
  function formatRedactedSummary(session, summary) {
    const date = new Date(session.startedAt).toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
    });
    const mins = session.endedAt ? Math.round((session.endedAt - session.startedAt) / 60000) : null;
    const lines = [
      `Meeting: ${session.label || "Untitled"}`,
      session.project ? `Project: ${session.project}` : null,
      `Date: ${date}`,
      mins !== null ? `Duration: ${mins} min` : null,
      summary && summary.n ? `Engagement: ${Math.round(summary.avgScore)}/100` : null,
    ].filter(Boolean);
    return lines.join("\n");
  }

  return { compute, listProjects, formatRedactedSummary };
})();
