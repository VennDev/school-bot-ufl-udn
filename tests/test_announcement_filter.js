const assert = require("assert");

function filterAnnouncements(announcements, todayStr, isRequestingAll = false) {
  const today = new Date(todayStr);
  const todayReset = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const currentYear = today.getFullYear().toString();

  const parseDate = (dateStr) => {
    if (!dateStr) return null;
    const parts = dateStr.split("/");
    if (parts.length === 3) {
      const year = parts[2].length === 2 ? 2000 + parseInt(parts[2], 10) : parseInt(parts[2], 10);
      return new Date(year, parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    }
    return null;
  };

  const oneWeekAgo = new Date(todayReset);
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  const isRecentOrFutureAnnouncement = (item) => {
    const content = typeof item === "string" ? item : (item.content || JSON.stringify(item));
    const dates = content.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g);
    if (dates && dates.length > 0) {
      const parsedDates = dates.map(parseDate).filter(Boolean);
      if (parsedDates.length > 0) {
        return parsedDates.some(d => d >= oneWeekAgo);
      }
    }
    return content.includes(currentYear) || content.includes("/" + currentYear.slice(2));
  };

  return isRequestingAll
    ? announcements.slice(0, 5)
    : announcements.filter(isRecentOrFutureAnnouncement).slice(0, 3);
}

const mockAnnouncements = [
  { content: "Nghỉ ngày 20/03/2026 (Quá 7 ngày so với 30/03)" },
  { content: "Nghỉ ngày 24/03/2026 (Trong vòng 7 ngày - lấy)" },
  { content: "Nghỉ ngày 15/04/2026 (Tương lai - lấy)" }
];

const filtered = filterAnnouncements(mockAnnouncements, "2026-03-30");

assert.strictEqual(filtered.length, 2);
assert.strictEqual(filtered.some(a => a.content.includes("24/03/2026")), true);
assert.strictEqual(filtered.some(a => a.content.includes("15/04/2026")), true);
assert.strictEqual(filtered.some(a => a.content.includes("20/03/2026")), false);

console.log("Weekly filter test passed OK!");
