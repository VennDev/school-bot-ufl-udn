function normalize(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đĐ]/g, "d")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

function isGradeTable(table) {
  const headers = (table?.headers || []).map(normalize);
  return headers.some(h => h.includes("ten hoc phan")) &&
    headers.some(h => /tbchp|diem tk|diem tong ket|diem chu|diem thi/.test(h));
}

function gradeKey(table, row) {
  const headers = (table?.headers || []).map(normalize);
  const codeIdx = headers.findIndex(h => /ma hoc phan|ma lop hoc phan|ky hieu|ma hp/.test(h));
  const nameIdx = headers.findIndex(h => h.includes("ten hoc phan"));
  const code = String(row?.[codeIdx >= 0 ? codeIdx : 1] || "").trim();
  const name = String(row?.[nameIdx >= 0 ? nameIdx : 2] || "").trim();
  return code || name ? `${code}|${name}` : "";
}

function snapshotStats(data) {
  const tables = Array.isArray(data) ? data.filter(isGradeTable) : [];
  const keys = new Set();
  tables.forEach(table => (table.rows || []).forEach(row => {
    const key = gradeKey(table, row);
    if (key) keys.add(key);
  }));
  return { tables, rows: keys.size, keys };
}

// A portal scrape can suddenly return more historical semesters than the
// baseline had. Those rows are recovered old data, not new grades. One-time
// silent re-baseline prevents a notification storm; the merged snapshot is
// saved so later syncs compare against the complete history.
function isLikelyGradeBaselineExpansion(oldData, newData) {
  const oldStats = snapshotStats(oldData);
  const newStats = snapshotStats(newData);
  if (!oldStats.rows || !newStats.rows || newStats.rows <= oldStats.rows) return false;
  const added = newStats.rows - oldStats.rows;
  const newOnlyGroups = new Map();
  const newOnlyKeys = new Set();
  const yearStart = value => Number(String(value || "").match(/^(\d{4})/)?.[1] || 0);
  let latestYear = 0;
  newStats.tables.forEach(table => {
    const year = String(table.year || "").trim();
    const semester = String(table.semester || "").trim();
    latestYear = Math.max(latestYear, yearStart(year));
    (table.rows || []).forEach(row => {
      const key = gradeKey(table, row);
      if (key && !oldStats.keys.has(key)) {
        newOnlyKeys.add(key);
        newOnlyGroups.set(`${year}|${semester}`, yearStart(year));
      }
    });
  });
  // One new current-semester table can be a legitimate update. Recovery from
  // a truncated baseline produces rows in several semester groups, or adds a
  // whole historical semester that the old baseline had lost.
  const onlyHistorical = newOnlyGroups.size > 0 &&
    [...newOnlyGroups.values()].every(start => start > 0 && start < latestYear);
  return added >= 5 &&
    newStats.rows >= oldStats.rows * 1.1 &&
    (newOnlyGroups.size >= 2 || (onlyHistorical && newOnlyKeys.size >= 2));
}

// Keep historical grade rows when portal returns only a subset of semesters.
// New rows with the same subject key replace old rows, allowing score updates.
function mergeGradeSnapshots(oldData, newData) {
  if (!Array.isArray(newData)) return oldData || newData;
  if (!Array.isArray(oldData)) return newData;

  const oldGradeTables = oldData.filter(isGradeTable);
  const newGradeTables = newData.filter(isGradeTable);
  if (!oldGradeTables.length || !newGradeTables.length) {
    // A non-grade/empty replacement must not erase a known grade snapshot.
    return oldGradeTables.length && !newGradeTables.length ? oldData : newData;
  }

  const newKeys = new Set();
  newGradeTables.forEach(table => (table.rows || []).forEach(row => {
    const key = gradeKey(table, row);
    if (key) newKeys.add(key);
  }));

  const preservedTables = oldGradeTables.map(table => {
    const rows = (table.rows || []).filter(row => {
      const key = gradeKey(table, row);
      return !key || !newKeys.has(key);
    });
    return rows.length ? { ...table, rows } : null;
  }).filter(Boolean);

  return [...newData, ...preservedTables];
}

module.exports = {
  mergeGradeSnapshots,
  isLikelyGradeBaselineExpansion,
  snapshotStats,
  isGradeTable,
  gradeKey,
};
