// Fetches law firm blog RSS/Atom feeds server-side (browsers can't, due to CORS).
// No API key required. POST {"urls": ["https://...", ...]} and it returns
// normalized items from each feed that responds.

function strip(s) {
  return (s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#?\w+;/g, " ")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? m[1] : "";
}

function parseFeed(xml, feedUrl) {
  const items = [];
  const host = (() => {
    try { return new URL(feedUrl).hostname.replace(/^www\./, ""); } catch { return feedUrl; }
  })();

  // RSS <item> blocks
  const rss = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  rss.forEach((block) => {
    const date = strip(tag(block, "pubDate"));
    items.push({
      title: strip(tag(block, "title")),
      url: strip(tag(block, "link")) || strip(tag(block, "guid")),
      date: date ? new Date(date).toISOString().slice(0, 10) : "",
      summary: strip(tag(block, "description")).slice(0, 220),
      source: host,
    });
  });

  // Atom <entry> blocks
  const atom = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  atom.forEach((block) => {
    const linkM = block.match(/<link[^>]*href=["']([^"']+)["']/i);
    const date = strip(tag(block, "updated")) || strip(tag(block, "published"));
    items.push({
      title: strip(tag(block, "title")),
      url: linkM ? linkM[1] : "",
      date: date ? new Date(date).toISOString().slice(0, 10) : "",
      summary: strip(tag(block, "summary") || tag(block, "content")).slice(0, 220),
      source: host,
    });
  });

  return items.filter((i) => i.title && i.url).slice(0, 6);
}

async function fetchFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (SignalsDesk RSS reader)" },
    });
    const text = await res.text();

    // If we got an HTML page instead of a feed, try the common /feed/ path once
    if (!/<(rss|feed|item|entry)[\s>]/i.test(text) && !url.match(/\/feed\/?$/)) {
      clearTimeout(timer);
      return fetchFeed(url.replace(/\/$/, "") + "/feed/");
    }
    return parseFeed(text, url);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
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

  let urls;
  try {
    urls = JSON.parse(event.body).urls.slice(0, 12);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_body" }) };
  }

  const results = await Promise.all(urls.map(fetchFeed));
  const items = results.flat().sort((a, b) => (a.date < b.date ? 1 : -1));

  return { statusCode: 200, headers, body: JSON.stringify({ items }) };
};
