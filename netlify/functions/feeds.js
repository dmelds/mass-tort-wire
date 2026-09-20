// News Wire + Firm Wire: fetches RSS/Atom feeds server-side (browsers can't, due to CORS).
// No API key required.
//
// POST {
//   "urls":    ["https://...", {"url": "https://...", "topic": "...", "watch": "...", "label": "..."}],
//                                           // required, max 12. For search feeds:
//                                           //   topic -> every item is tagged with that topic (`matched`)
//                                           //   watch -> every item is tagged with that firm (`watch`)
//                                           //   label -> name shown in the health report
//   "topics":  ["AFFF lawsuit", ...],       // optional: items get a `matched` list
//   "days":    30,                          // optional: drop dated items older than this
//   "perFeed": 8,                           // optional: items kept per feed (max 15)
//   "blockSources": ["Yahoo Sports", "sports.yahoo.com"],
//                                           // optional: drop items from these publishers
//                                           // (a name, or a domain when the entry has a dot)
//   "trustSources": ["Reuters", "reuters.com"]
//                                           // optional: publishers exempt from the topic
//                                           // check on a topic search, so a story that
//                                           // never names the term is still kept
// }
//
// Returns { items: [...], feeds: [...] }.
// `items` keeps the original shape (title, url, date, summary, source) plus
// `host` and `matched`. `feeds` is a per-feed health report.

const UA = "Mozilla/5.0 (SignalsDesk RSS reader)";
const FETCH_MS = 6000;   // per request
const BUDGET_MS = 9000;  // whole invocation; slow feeds are reported as timeouts

const NAMED = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201D", ldquo: "\u201C",
  ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", middot: "\u00B7",
  copy: "\u00A9", reg: "\u00AE", trade: "\u2122", eacute: "\u00E9",
};

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X"
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    const v = NAMED[code.toLowerCase()];
    return v !== undefined ? v : " ";
  });
}

// Descriptions often arrive as escaped HTML (&lt;p&gt;), so decode, strip, decode again.
function clean(s) {
  let t = (s || "").replace(/<!\[CDATA\[|\]\]>/g, "");
  t = decode(t);
  t = t.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<[^>]+>/g, " ");
  t = decode(t);
  return t.replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? m[1] : "";
}

function isoDate(raw) {
  if (!raw) return "";
  const d = new Date(raw.trim());
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function truncate(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut) + "\u2026";
}

// A feed with zero items (a quiet search) is still a feed, so check the root element, not the items.
function looksLikeFeed(text) {
  if (/<html[\s>]/i.test(text.slice(0, 2000))) return false;
  return /<(rss|rdf:RDF)[\s>]/i.test(text) || /<feed[\s>][^>]*http:\/\/www\.w3\.org\/2005\/Atom/i.test(text) || /<feed[\s>]/i.test(text.slice(0, 500));
}

// The feed's own title (text before the first item/entry) names the firm better than a hostname.
function feedTitle(xml, fallback) {
  const head = xml.split(/<(?:item|entry)[\s>]/i)[0];
  const t = clean(tag(head, "title"));
  return t && t.length <= 80 ? t : fallback;
}

const AGGREGATORS = /(^|\.)news\.google\.com$/i;

function parseFeed(xml, feedUrl) {
  const host = hostOf(feedUrl);
  const source = feedTitle(xml, host);
  const items = [];

  const aggregator = AGGREGATORS.test(host);

  (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).forEach((block) => {
    // Aggregators (Google News) name the publisher per item and append it to the headline.
    const pub = clean(tag(block, "source"));
    const pubUrl = (block.match(/<source[^>]*\burl=["']([^"']+)["']/i) || [])[1] || "";
    let title = clean(tag(block, "title"));
    if (pub && title.endsWith(" - " + pub)) title = title.slice(0, -(pub.length + 3)).trim();
    items.push({
      title,
      url: clean(tag(block, "link")) || clean(tag(block, "guid")),
      date: isoDate(clean(tag(block, "pubDate")) || clean(tag(block, "dc:date"))),
      // Aggregator descriptions only repeat the headline and publisher.
      summary: aggregator ? "" : truncate(clean(tag(block, "description")), 220),
      source: pub || source,
      sourceUrl: pubUrl ? decode(pubUrl) : "",
      host,
    });
  });

  (xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []).forEach((block) => {
    const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
      || block.match(/<link[^>]*href=["']([^"']+)["']/i);
    items.push({
      title: clean(tag(block, "title")),
      url: alt ? decode(alt[1]) : "",
      date: isoDate(clean(tag(block, "published")) || clean(tag(block, "updated"))),
      summary: truncate(clean(tag(block, "summary") || tag(block, "content")), 220),
      source,
      host,
    });
  });

  return items.filter((i) => i.title && /^https?:\/\//i.test(i.url));
}

// Find the feed an HTML page advertises in <link rel="alternate" type="application/rss+xml">.
function discoverFeed(html, pageUrl) {
  const links = html.match(/<link\b[^>]*>/gi) || [];
  for (const l of links) {
    if (!/rel=["']?alternate/i.test(l)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(l)) continue;
    if (/comments/i.test(l)) continue;
    const h = l.match(/href=["']([^"']+)["']/i);
    if (h) {
      try { return new URL(decode(h[1]), pageUrl).toString(); } catch { /* skip */ }
    }
  }
  return null;
}

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5",
      },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

function feedLabel(e) {
  const name = e.label || e.topic || e.watch;
  if (name) return AGGREGATORS.test(hostOf(e.url)) ? "Google News: " + name : name;
  return hostOf(e.url);
}

async function fetchFeed(entry) {
  const { url, topic, watch } = entry;
  const report = { url, topic, watch, search: !!(topic || watch || entry.label), resolved: url, source: feedLabel(entry), status: "error", count: 0, error: "" };
  try {
    let r = await get(url);
    if (!r.ok) throw new Error("HTTP " + r.status);

    if (!looksLikeFeed(r.text)) {
      // 1) the page's advertised feed, 2) the WordPress /feed/ path
      const candidates = [];
      const found = discoverFeed(r.text, r.finalUrl);
      if (found) candidates.push(found);
      if (!/\/feed\/?$/i.test(url)) candidates.push(url.replace(/\/+$/, "") + "/feed/");

      let hit = null;
      for (const c of candidates) {
        if (c === url) continue;
        try {
          const rc = await get(c);
          if (rc.ok && looksLikeFeed(rc.text)) { hit = rc; report.resolved = c; break; }
        } catch { /* try next */ }
      }
      if (!hit) throw new Error("no feed found at this URL");
      r = hit;
    }

    const items = parseFeed(r.text, report.resolved);
    if (!report.search && !AGGREGATORS.test(hostOf(report.resolved))) {
      report.source = feedTitle(r.text, report.source);
    }
    report.status = items.length ? "ok" : "empty";
    report.items = items;
    return report;
  } catch (err) {
    report.error = err && err.name === "AbortError" ? "timed out" : String((err && err.message) || err);
    report.items = [];
    return report;
  }
}

// Topic matching: drop generic legal words so "Roundup settlement" matches any Roundup post.
const GENERIC = /\b(lawsuits?|litigation|settlements?|claims?|mdl|class action|verdicts?)\b/gi;

// Terms that are also ordinary English words. "Roundup" names a herbicide and a news digest,
// so matching the word alone tags faith, sports and regional roundups as mass tort coverage.
const AMBIGUOUS_TERMS = { roundup: 1 };

const LEGAL_WORDS = /\b(lawsuits?|litigation|settlements?|verdicts?|mdl|class action|claims?|court|judge|jury|trial|plaintiffs?|attorneys?|sued?|suing|damages|complaint|defendants?)\b/i;

function topicTerms(topics) {
  return topics
    .map((t) => {
      const core = t.replace(GENERIC, " ").replace(/\s+/g, " ").trim();
      return { topic: t, term: (core || t).toLowerCase() };
    })
    .filter((x) => x.term.length >= 3);
}

function matchTopics(item, terms) {
  const hay = (item.title + " " + item.summary).toLowerCase();
  let legal = null;
  return terms
    .filter(({ term }) => {
      // Trailing (?:e?s)? so "hair relaxer" matches a headline saying "Hair Relaxers".
      const re = new RegExp("\\b" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+") + "(?:e?s)?\\b", "i");
      if (!re.test(hay)) return false;
      if (!AMBIGUOUS_TERMS[term]) return true;
      // Matched an everyday word, so the item has to read like litigation news to count.
      if (legal === null) legal = LEGAL_WORDS.test(hay);
      return legal;
    })
    .map(({ topic }) => topic);
}

// Publisher list matcher, used for both the blocklist and the trusted list: entries with a
// dot match the publisher's domain (or its subdomains), others match the publisher name,
// case-insensitively.
function makeSourceMatcher(list) {
  const names = [], domains = [];
  list.forEach((raw) => {
    const e = String(raw).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (!e) return;
    (e.includes(".") ? domains : names).push(e);
  });
  return (item) => {
    const name = (item.source || "").toLowerCase().trim();
    if (names.includes(name)) return true;
    const hosts = [item.sourceUrl ? hostOf(item.sourceUrl) : "", item.host || "", hostOf(item.url)]
      .map((h) => h.toLowerCase());
    return domains.some((d) => hosts.some((h) => h === d || h.endsWith("." + d)));
  };
}

// Same article from two feeds: ignore tracking params, fragments, trailing slash, www.
function dedupeKey(url) {
  try {
    const u = new URL(url);
    [...u.searchParams.keys()].forEach((k) => { if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) u.searchParams.delete(k); });
    u.hash = "";
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "") + u.search).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  let urls, topics, days, perFeed, blockSources, trustSources;
  try {
    const body = JSON.parse(event.body);
    const seenUrls = new Set();
    urls = (body.urls || [])
      .map((u) => (typeof u === "string"
        ? { url: u.trim(), topic: "", watch: "", label: "" }
        : {
            url: String((u && u.url) || "").trim(),
            topic: String((u && u.topic) || "").trim(),
            watch: String((u && u.watch) || "").trim(),
            label: String((u && u.label) || "").trim(),
          }))
      .filter((e) => /^https?:\/\//i.test(e.url) && !seenUrls.has(e.url) && seenUrls.add(e.url))
      .slice(0, 12);
    topics = Array.isArray(body.topics) ? body.topics.map(String).slice(0, 20) : [];
    days = Number(body.days) > 0 ? Number(body.days) : 0;
    perFeed = Math.min(Math.max(Number(body.perFeed) || 8, 1), 15);
    blockSources = Array.isArray(body.blockSources) ? body.blockSources.slice(0, 50) : [];
    trustSources = Array.isArray(body.trustSources) ? body.trustSources.slice(0, 50) : [];
    if (!urls.length) throw new Error("no urls");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_body" }) };
  }

  // Every feed races the shared budget; anything still running is reported, not waited on.
  let budgetTimer;
  const deadline = new Promise((resolve) => { budgetTimer = setTimeout(resolve, BUDGET_MS, null); });
  const reports = await Promise.all(
    urls.map((e) =>
      Promise.race([fetchFeed(e), deadline]).then((r) =>
        r || { url: e.url, topic: e.topic, watch: e.watch, search: !!(e.topic || e.watch || e.label), resolved: e.url, source: feedLabel(e), status: "error", count: 0, error: "timed out", items: [] }
      )
    )
  );
  clearTimeout(budgetTimer);

  const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : "";
  const terms = topicTerms(topics);
  const blocked = makeSourceMatcher(blockSources);
  const trusted = makeSourceMatcher(trustSources);
  const seen = new Map();
  const items = [];
  const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  reports.forEach((rep) => {
    const inWindow = rep.items.filter((i) => !cutoff || !i.date || i.date >= cutoff);
    const allowed = inWindow.filter((i) => !blocked(i));
    rep.blocked = inWindow.length - allowed.length;

    // A search for an everyday word answers with everyday news: "Roundup settlement" brought
    // back a film premiere and a faith digest, both wearing the topic as a tag. Those topics
    // make an item prove itself by carrying the term. A specific term like PFAS or AFFF needs
    // no such proof, and demanding it costs real coverage, because a Google News feed carries
    // no summary and only the headline is left to match. A trusted publisher is always exempt.
    const ownTerms = rep.topic ? topicTerms([rep.topic]) : null;
    const needsProof = !!ownTerms && ownTerms.some(({ term }) => AMBIGUOUS_TERMS[term]);
    const onTopic = needsProof
      ? allowed.filter((i) => trusted(i) || matchTopics(i, ownTerms).length)
      : allowed;
    rep.offtopic = allowed.length - onTopic.length;

    const kept = onTopic
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, perFeed);
    rep.found = kept.length;  // in window, not blocked, on topic, before cross-feed dedupe
    rep.count = 0;           // unique items this feed added
    kept.forEach((i) => {
      const key = dedupeKey(i.url);
      const tkey = "t:" + norm(i.title) + "|" + norm(i.source);
      const dup = seen.get(key) || seen.get(tkey);
      if (dup) {
        // Same story from a second search feed: keep one copy, carry both topics.
        if (rep.topic && !dup.matched.includes(rep.topic)) dup.matched.push(rep.topic);
        if (rep.watch && !dup.watch.includes(rep.watch)) dup.watch.push(rep.watch);
        return;
      }
      seen.set(key, i);
      seen.set(tkey, i);
      i.matched = terms.length ? matchTopics(i, terms) : [];
      if (rep.topic && !i.matched.includes(rep.topic)) i.matched.unshift(rep.topic);
      i.watch = rep.watch ? [rep.watch] : [];
      items.push(i);
      rep.count++;
    });
    if (rep.status === "ok" && rep.found === 0) rep.status = "empty";
    delete rep.items;
  });

  // Newest first; undated items go last.
  items.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });

  return { statusCode: 200, headers, body: JSON.stringify({ items, feeds: reports }) };
};
