// Mass Tort Wire. Copyright (c) 2026 David Meldofsky. All rights reserved.
// No license is granted to copy, modify or redistribute this code.

// The DOCKET tab's store. The docket watch in network-ops (scripts/docket_alert.py) posts the
// court entries it finds on the tracked MDL and case dockets, and the page reads them back.
//
// GET  /.netlify/functions/docket  X-Wire-Key   -> { entries: [...], lastRun: {...} | null }
// POST /.netlify/functions/docket  X-Docket-Key body { entries: [...], run: {...} } -> { ok, added, total }
//
// Two keys, so neither side holds more than it needs. The page reads with the wire key it
// already sends to settings and feeds. The docket watch writes with DOCKET_KEY, a separate
// Netlify secret that can post docket entries and nothing else: it cannot read or change the
// wire's settings, and the wire key cannot post docket entries. With DOCKET_KEY unset, every
// POST is refused.
//
// Entries are keyed by the watch's own id for each docket entry, so a rerun, a retry, or the
// watch resending its whole window never adds the same entry twice. Each entry keeps the time it
// first reached the wire (addedAt), which is what NEW counts from on every device.

import { getStore } from "@netlify/blobs";
import { timingSafeEqual } from "node:crypto";

const KEY = "docket";
const MAX_ENTRIES = 600;   // kept on the site, newest filing first
const KEEP_DAYS = 90;      // entries filed earlier than this fall off
const MAX_POST = 400;      // entries accepted in one POST

function sameKey(got, want) {
  if (!want || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function wireKeyOk(req) {
  const got = req.headers.get("x-wire-key") || "";
  return sameKey(got, process.env.WIRE_KEY || "") || sameKey(got, process.env.WIRE_ADMIN_KEY || "");
}
function docketKeyOk(req) {
  return sameKey(req.headers.get("x-docket-key") || "", process.env.DOCKET_KEY || "");
}

function reply(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function str(v, n) { return v == null ? "" : String(v).trim().slice(0, n); }

// Links on an entry go to the court, CourtListener, or one of the network's own sites. Anything
// else is dropped rather than shown, so a bad post cannot put an outside link on the wire.
const LINK_HOSTS = /(^|\.)(uscourts\.gov|courtlistener\.com|lawsuitinformer\.com|lawsuitintelligencer\.com|lawsuit\.center)$/i;
function link(v) {
  const s = str(v, 600);
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" && LINK_HOSTS.test(u.hostname) ? u.href : "";
  } catch { return ""; }
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isoTime(v) {
  const s = str(v, 40);
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toISOString();
}

function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
  const id = str(e.id, 200);
  const filed = str(e.filed, 10);
  if (!id || !DAY_RE.test(filed)) return null;
  return {
    id,
    court: str(e.court, 12).toLowerCase(),
    number: str(e.number, 40),
    label: str(e.label, 120),
    caseName: str(e.caseName, 200),
    desc: str(e.desc, 400),
    docNum: str(e.docNum, 12),
    filed,
    time: isoTime(e.time),
    source: e.source === "recap" ? "recap" : "rss",
    freeUrl: link(e.freeUrl),
    docUrl: link(e.docUrl),
    docketUrl: link(e.docketUrl),
    pages: Array.isArray(e.pages) ? e.pages.map((p) => str(p, 200)).filter(Boolean).slice(0, 6) : [],
  };
}

function cleanRun(r) {
  if (!r || typeof r !== "object") return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return {
    at: isoTime(r.at) || new Date().toISOString(),
    cases: n(r.cases),
    inWindow: n(r.inWindow),
    listed: n(r.listed),
    routine: n(r.routine),
    pacerFetch: r.pacerFetch === true,
  };
}

function newestFirst(a, b) {
  const ka = a.time || a.filed + "T00:00:00.000Z";
  const kb = b.time || b.filed + "T00:00:00.000Z";
  return kb.localeCompare(ka);
}

export default async (req) => {
  const store = getStore({ name: "mass-tort-wire", consistency: "strong" });

  if (req.method === "GET") {
    if (!wireKeyOk(req)) {
      return reply(401, { error: process.env.WIRE_KEY ? "bad_key" : "WIRE_KEY not set in Netlify" });
    }
    const data = (await store.get(KEY, { type: "json" })) || {};
    return reply(200, { entries: data.entries || [], lastRun: data.lastRun || null });
  }

  if (req.method === "POST") {
    if (!docketKeyOk(req)) {
      return reply(401, { error: process.env.DOCKET_KEY ? "bad_key" : "DOCKET_KEY not set in Netlify" });
    }
    const text = await req.text();
    if (text.length > 600000) return reply(413, { error: "too_large" });
    let body;
    try { body = JSON.parse(text); } catch { return reply(400, { error: "bad_json" }); }
    if (!body || !Array.isArray(body.entries)) return reply(400, { error: "bad_body" });

    const data = (await store.get(KEY, { type: "json" })) || {};
    const firstLoad = !Array.isArray(data.entries) || !data.entries.length;
    const byId = {};
    (data.entries || []).forEach((e) => { byId[e.id] = e; });

    const now = new Date().toISOString();
    let added = 0;
    body.entries.slice(0, MAX_POST).forEach((raw) => {
      const e = cleanEntry(raw);
      if (!e) return;
      const had = byId[e.id];
      // An entry already on the wire keeps the time it first arrived, so a resend never makes
      // it NEW again. Its text and links take the newer copy (a free PDF can appear later).
      // On the very first load the whole backlog arrives at once; each entry is stamped with
      // its filing date instead, so the tab does not open with every entry marked NEW.
      e.addedAt = had ? had.addedAt : (firstLoad ? (e.time || e.filed + "T12:00:00.000Z") : now);
      if (!had) added++;
      byId[e.id] = e;
    });

    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
    const entries = Object.values(byId)
      .filter((e) => e.filed >= cutoff)
      .sort(newestFirst)
      .slice(0, MAX_ENTRIES);
    const lastRun = cleanRun(body.run) || data.lastRun || null;
    await store.setJSON(KEY, { entries, lastRun, savedAt: now });
    return reply(200, { ok: true, added, total: entries.length });
  }

  return reply(405, { error: "GET or POST only" });
};
