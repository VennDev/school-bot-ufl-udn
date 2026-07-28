#!/usr/bin/env node
/**
 * One-time setup: create Utility Templates for school notification bot.
 * Run after deploying messenger.js changes, BEFORE the April 27, 2026 deadline.
 *
 * Usage:
 *   node scripts/setup-utility-templates.js
 *
 * Requires: FB_PAGE_TOKEN and FB_PAGE_ID in .env
 *
 * Creates 2 approved templates:
 *   1. ufl_exam_reminder_v2   — exam date/time/room reminders
 *   2. ufl_announcement_v2    — all other academic notifications
 *
 * All notification categories use these two approved templates. Do not add
 * generic placeholder-only templates; Meta rejects them.
 *
 * ponytail: if template content needs adjustment, edit TEMPLATES below and re-run.
 * Templates auto-approve within seconds. Check Facebook Business Manager if rejected.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

async function getCredentials() {
  // Try DB first (set via admin UI), fall back to .env
  try {
    const db = require("../src/db");
    const token = await db.getSystemSetting("fb_page_token", "");
    const pageId = await db.getSystemSetting("fb_page_id", "");
    if (token && pageId) return { token, pageId };
  } catch (e) {
    console.log("DB not available, falling back to .env");
  }
  return {
    token: process.env.FB_PAGE_TOKEN || "",
    pageId: process.env.FB_PAGE_ID || "",
  };
}

async function main() {
  const { token: PAGE_TOKEN, pageId: PAGE_ID } = await getCredentials();

  if (!PAGE_TOKEN || !PAGE_ID) {
    console.error("Missing FB_PAGE_TOKEN or FB_PAGE_ID (set via admin UI or .env)");
    process.exit(1);
  }

  const API_BASE = `https://graph.facebook.com/v21.0/${PAGE_ID}/message_templates`;

  const TEMPLATES = [
    {
      name: "ufl_exam_reminder_v2",
      language: "vi",
      category: "UTILITY",
      components: [{
        type: "BODY",
        text: "[UFL Bot] Nhắc thi:\nMôn: {{1}}\nNgày: {{2}} - Giờ: {{3}}\nPhòng: {{4}} - Hình thức: {{5}}\n\nMở UFL Bot để xem chi tiết.",
        example: { body_text: [["Lập trình", "20/06/2026", "07:00", "A101", "Thi viết"]] },
      }],
    },
    {
      name: "ufl_announcement_v2",
      language: "vi",
      category: "UTILITY",
      components: [{
        type: "BODY",
        text: "[UFL Bot] Thông báo học vụ:\n{{1}}\n\nMở UFL Bot để xem chi tiết.",
        example: { body_text: [["Có thông báo mới từ nhà trường"]] },
      }],
    },
  ];

  async function listTemplates() {
    const url = `${API_BASE}?fields=name,status,category,language&access_token=${PAGE_TOKEN}`;
    const res = await fetch(url);
    return res.json();
  }

  async function createTemplate(tmpl) {
    const url = `${API_BASE}?access_token=${PAGE_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tmpl),
    });
    return res.json();
  }

  console.log(`Checking ${TEMPLATES.length} approved Utility Templates for Page ${PAGE_ID}...\n`);
  const existing = await listTemplates();
  if (existing.error) throw new Error(existing.error.message);
  const byName = new Map((existing.data || []).map(t => [`${t.name}:${t.language}`, t]));

  for (const tmpl of TEMPLATES) {
    const current = byName.get(`${tmpl.name}:${tmpl.language}`);
    if (current) {
      console.log(`  ${tmpl.name}: ${current.status}`);
      continue;
    }
    console.log(`Creating: ${tmpl.name} ...`);
    const result = await createTemplate(tmpl);
    if (result.error) {
      console.error(`  FAILED: ${result.error.message} (code: ${result.error.code}, subcode: ${result.error.error_subcode})`);
    } else {
      const label = result.status === "APPROVED" ? "APPROVED" : `NOT APPROVED (${result.status || "unknown"})`;
      console.log(`  Created — id: ${result.id}, status: ${label}, category: ${result.category}`);
    }
  }

  console.log("\nDone. Verify templates at: https://business.facebook.com/latest/inbox/templates");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await require("mongoose").disconnect();
  } catch {}
});
