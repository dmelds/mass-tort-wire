// Reddit search via the official OAuth API (app-only auth).
// Reliable from datacenter IPs, unlike the public JSON endpoints.
// Requires Netlify env vars: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
// (create a "script" app at reddit.com/prefs/apps - free).
// POST {"searches": [{"q": "...", "subs": ["law"], "limit": 6}]}

const UA = "web:mass-tort-wire:v1.0 (signals desk)";

let cachedToken = null;
let tokenExp = 0;

async function getToken(id, secret) {
  if (cachedToken && Date.now() < tokenExp) return cachedToken;
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(id + ":" + secret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("reddit auth failed");
  cachedToken = data.access_token;
  tokenExp = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function search(token, s) {
  const base = s.subs && s.subs.length
    ? "https://oauth.reddit.com/r/" + s.subs.join("+") + "/search"
    : "https://oauth.reddit.com/search";
  const url = base + "?q=" + encodeURIComponent(s.q) +
    "&sort=new&t=month&limit=" + (s.limit || 6) +
    (s.subs && s.subs.length ? "&restrict_sr=1" : "");
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + token, "User-Agent": UA },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return ((data.data && data.data.children) || []).map((c) => c.data).filter(Boolean);
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: "no_creds" }) };
  }

  let searches;
  try {
    searches = JSON.parse(event.body).searches.slice(0, 8);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_body" }) };
  }

  try {
    const token = await getToken(id, secret);
    const results = await Promise.all(searches.map((s) => search(token, s)));
    const seen = {};
    const items = results.flat()
      .filter((d) => { if (seen[d.id]) return false; seen[d.id] = true; return true; })
      .map((d) => ({
        channel: "reddit",
        title: d.title,
        source: "r/" + d.subreddit,
        url: "https://www.reddit.com" + d.permalink,
        date: new Date(d.created_utc * 1000).toISOString().slice(0, 10),
        meta: d.score + " pts \u00B7 " + d.num_comments + " comments",
        summary: d.selftext ? d.selftext.slice(0, 220) : "",
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 18);

    return { statusCode: 200, headers, body: JSON.stringify({ items }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: String(err.message || err).toUpperCase() }) };
  }
};
