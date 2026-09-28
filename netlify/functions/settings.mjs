// Mass Tort Wire. Copyright (c) 2026 David Meldofsky. All rights reserved.
// No license is granted to copy, modify or redistribute this code.

// Saves the wire's settings on the site, so every window loads the same setup:
// the web app, a regular Safari window, and a private window that can't see saved browser data.
//
// GET  /.netlify/functions/settings  -> { settings: {...} | null }
// PUT  /.netlify/functions/settings  body: the settings object -> { ok: true, savedAt }
//
// Stored with Netlify Blobs, which needs no API key and survives redeploys.

import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const KEY = "settings";

// Only the wire itself may read or write the saved setup. WIRE_KEY is set in the
// Netlify UI, never in the repo; with it unset every request is refused.
//
// Two keys. WIRE_KEY is the viewer key: it reads the setup and runs scans. WIRE_ADMIN_KEY,
// when the site has one, is the editor key: it also saves changes. A firm copy gives the firm
// the viewer key and keeps the editor key with the wire's owner, so a forwarded key can read
// the wire and cannot rewrite it. A site without WIRE_ADMIN_KEY works as before: WIRE_KEY
// reads and writes.
function sameKey(got, want) {
  if (!want || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function gotKey(req) { return req.headers.get("x-wire-key") || ""; }
function isEditor(req) { return sameKey(gotKey(req), process.env.WIRE_ADMIN_KEY || ""); }
function keyOk(req) { return sameKey(gotKey(req), process.env.WIRE_KEY || "") || isEditor(req); }
function canWrite(req) { return process.env.WIRE_ADMIN_KEY ? isEditor(req) : keyOk(req); }
const LISTS = [
  "topics", "outlets", "blockedSources", "trustedSources", "newsFeeds",
  "firmWatch", "firmFeeds", "aiSearches", "aiFeeds", "blockedTerms",
];

// Keep only the fields the page uses, as the types it expects, so a bad write can't break the page.
function clean(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = {};
  LISTS.forEach((k) => {
    if (!Array.isArray(body[k])) return;
    out[k] = body[k].map((v) => String(v).trim().slice(0, 300)).filter(Boolean).slice(0, 80);
  });
  if (Number.isInteger(body.version)) out.version = body.version;
  const days = Number(body.windowDays);
  if (days === 7 || days === 30) out.windowDays = days;
  if (typeof body.topicsOnly === "boolean") out.topicsOnly = body.topicsOnly;
  // A firm build's name for the eyebrow and the home-screen title. Plain text, short.
  if (typeof body.firmName === "string") out.firmName = body.firmName.trim().slice(0, 80);
  return Object.keys(out).length ? out : null;
}

function reply(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async (req) => {
  // Strong consistency: a private window opened right after a change must see that change.
  const store = getStore({ name: "mass-tort-wire", consistency: "strong" });

  if (!keyOk(req)) {
    return reply(401, { error: process.env.WIRE_KEY ? "bad_key" : "WIRE_KEY not set in Netlify" });
  }

  if (req.method === "GET") {
    const settings = await store.get(KEY, { type: "json" });
    // canWrite tells the page which key it holds, so a viewer's page hides the setup form.
    return reply(200, { settings: settings || null, canWrite: canWrite(req) });
  }

  if (req.method === "PUT" || req.method === "POST") {
    if (!canWrite(req)) return reply(403, { error: "read_only" });
    const text = await req.text();
    if (text.length > 100000) return reply(413, { error: "too_large" });
    let body;
    try { body = JSON.parse(text); } catch { return reply(400, { error: "bad_json" }); }
    const settings = clean(body);
    if (!settings) return reply(400, { error: "bad_body" });
    settings.savedAt = new Date().toISOString();
    await store.setJSON(KEY, settings);
    return reply(200, { ok: true, savedAt: settings.savedAt });
  }

  return reply(405, { error: "GET or PUT only" });
};
