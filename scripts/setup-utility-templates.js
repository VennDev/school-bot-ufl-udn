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
 * Creates 4 templates:
 *   1. ufl_account_update  — grade changes, account status (replaces ACCOUNT_UPDATE tag)
 *   2. ufl_exam_reminder   — exam date/time/room reminders (replaces CONFIRMED_EVENT_UPDATE tag)
 *   3. ufl_tuition_alert   — tuition debt warnings
 *   4. ufl_announcement    — general academic announcements
 *
 * ponytail: if template content needs adjustment, edit TEMPLATES below and re-run.
 * Templates auto-approve within seconds. Check Facebook Business Manager if rejected.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const PAGE_TOKEN = process.env.FB_PAGE_TOKEN || "";
const PAGE_ID = process.env.FB_PAGE_ID || "";

if (!PAGE_TOKEN || !PAGE_ID) {
  console.error("Missing FB_PAGE_TOKEN or FB_PAGE_ID in .env");
  process.exit(1);
}

const API_BASE = `https://graph.facebook.com/v21.0/${PAGE_ID}/message_templates`;

const TEMPLATES = [
  {
    name: "ufl_account_update",
    language: "vi",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "{{1}}",
      },
    ],
  },
  {
    name: "ufl_exam_reminder",
    language: "vi",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "[UFL Bot] Nhắc thi:\nMôn: {{1}}\nNgày: {{2}} - Giờ: {{3}}\nPhòng: {{4}} - Hình thức: {{5}}",
      },
    ],
  },
  {
    name: "ufl_tuition_alert",
    language: "vi",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "{{1}}",
      },
    ],
  },
  {
    name: "ufl_announcement",
    language: "vi",
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        text: "{{1}}",
      },
    ],
  },
];

async function createTemplate(tmpl) {
  const url = `${API_BASE}?access_token=${PAGE_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tmpl),
  });
  const data = await res.json();
  return data;
}

async function main() {
  console.log(`Creating ${TEMPLATES.length} Utility Templates for Page ${PAGE_ID}...\n`);

  for (const tmpl of TEMPLATES) {
    console.log(`Creating: ${tmpl.name} ...`);
    const result = await createTemplate(tmpl);
    if (result.error) {
      // Template may already exist (idempotent)
      if (result.error.code === 100 && result.error.error_subcode === 2654) {
        console.log(`  (already exists, skipping) ${result.error.message}`);
      } else {
        console.error(`  FAILED: ${result.error.message} (code: ${result.error.code}, subcode: ${result.error.error_subcode})`);
      }
    } else {
      console.log(`  OK — id: ${result.id}, status: ${result.status}, category: ${result.category}`);
    }
  }

  console.log("\nDone. Verify templates at: https://business.facebook.com/latest/inbox/templates");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
