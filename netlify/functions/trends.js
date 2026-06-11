// Google Trends via the unofficial widget endpoints. Two layers:
//   1) MOMENTUM: interest-over-time for your tracked topics (max 5)
//   2) DISCOVERY: rising/breakout related queries around a seed term
//      ("lawsuit" by default) — surfaces emerging torts you aren't tracking yet.
// No API key. Google may rate-limit datacenter IPs; errors return clearly.
// POST {"keywords": [...], "seed": "lawsuit"}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function stripPrefix(text) {
  const i = text.indexOf("{");
  if (i === -1) throw new Error("unexpected response shape");
  return JSON.parse(text.slice(i));
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function getCookie() {
  const home = await fetch("https://trends.google.com/trends/explore?geo=US&hl=en-US", {
    headers: { "User-Agent": UA },
  });
  return (home.headers.get("set-cookie") || "").split(";")[0];
}

async function explore(keywords, cookie) {
  const req = {
    comparisonItem: keywords.map((k) => ({ keyword: k, geo: "US", time: "today 3-m" })),
    category: 0,
    property: "",
  };
  const res = await fetch(
    "https://trends.google.com/trends/api/explore?hl=en-US&tz=360&req=" +
      encodeURIComponent(JSON.stringify(req)),
    { headers: { "User-Agent": UA, cookie } }
  );
  if (res.status === 429) throw new Error("rate_limited");
  return stripPrefix(await res.text());
}

async function widgetData(endpoint, widget, cookie) {
  const res = await fetch(
    "https://trends.google.com/trends/api/widgetdata/" + endpoint +
      "?hl=en-US&tz=360&req=" + encodeURIComponent(JSON.stringify(widget.request)) +
      "&token=" + widget.token,
    { headers: { "User-Agent": UA, cookie } }
  );
  if (res.status === 429) throw new Error("rate_limited");
  return stripPrefix(await res.text());
}

// Layer 1: interest-over-time for tracked topics
async function momentum(keywords, cookie) {
  const exp = await explore(keywords, cookie);
  const widget = (exp.widgets || []).find((w) => w.id === "TIMESERIES");
  if (!widget) return [];
  const data = await widgetData("multiline", widget, cookie);
  const timeline = data.default && data.default.timelineData;
  if (!timeline || !timeline.length) return [];

  return keywords.map((kw, i) => {
    const series = timeline.map((p) => (p.value && p.value[i]) || 0);
    const latest = series[series.length - 1];
    const recent = mean(series.slice(-7));
    const prior = mean(series.slice(-37, -7));
    const delta = prior > 0 ? Math.round(((recent - prior) / prior) * 100) : 0;
    const arrow = delta > 5 ? "RISING" : delta < -5 ? "FADING" : "STEADY";
    return {
      title: kw,
      source: "google trends \u00B7 tracked \u00B7 US 90d",
      url: "https://trends.google.com/trends/explore?geo=US&q=" + encodeURIComponent(kw),
      date: "",
      summary: arrow + " \u00B7 interest now " + latest + "/100 \u00B7 7-day avg " +
        (delta >= 0 ? "+" : "") + delta + "% vs prior month",
      rising: delta > 5,
    };
  });
}

// Layer 2: rising/breakout queries around the seed term — the discovery layer
async function discovery(seed, tracked, cookie) {
  const exp = await explore([seed], cookie);
  const widget = (exp.widgets || []).find((w) => w.id === "RELATED_QUERIES");
  if (!widget) return [];
  const data = await widgetData("relatedsearches", widget, cookie);
  const lists = (data.default && data.default.rankedList) || [];
  // rankedList[1] is the RISING set when present; fall back to [0]
  const rising = (lists[1] && lists[1].rankedKeyword) || (lists[0] && lists[0].rankedKeyword) || [];

  const trackedLower = tracked.map((t) => t.toLowerCase());
  return rising
    .filter((r) => {
      const q = (r.query || "").toLowerCase();
      // skip queries you already track
      return q && !trackedLower.some((t) => q.includes(t.replace(/ lawsuit$/, "")) || t.includes(q));
    })
    .slice(0, 8)
    .map((r) => {
      const growth = r.formattedValue === "Breakout"
        ? "BREAKOUT (>5000% search growth)"
        : r.formattedValue + " search growth over 90 days";
      return {
        title: r.query,
        source: "google trends \u00B7 rising around \u201C" + seed + "\u201D",
        url: "https://trends.google.com/trends/explore?geo=US&q=" + encodeURIComponent(r.query),
        date: "",
        summary: growth,
        rising: true,
      };
    });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  let keywords, seed;
  try {
    const body = JSON.parse(event.body);
    keywords = (body.keywords || []).slice(0, 5);
    seed = body.seed || "lawsuit";
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_body" }) };
  }

  try {
    const cookie = await getCookie();
    const results = await Promise.allSettled([
      discovery(seed, keywords, cookie),
      keywords.length ? momentum(keywords, cookie) : Promise.resolve([]),
    ]);
    const items = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value)
      .flat()
      .sort((a, b) => (b.rising ? 1 : 0) - (a.rising ? 1 : 0));

    if (!items.length) {
      const firstErr = results.find((r) => r.status === "rejected");
      throw new Error(firstErr ? firstErr.reason.message : "empty response");
    }

    return { statusCode: 200, headers, body: JSON.stringify({ items }) };
  } catch (err) {
    const msg = String(err.message || err);
    const friendly = msg === "rate_limited"
      ? "GOOGLE RATE-LIMITED THIS SERVER. TRY AGAIN IN A FEW MINUTES."
      : "TRENDS FETCH FAILED: " + msg.toUpperCase();
    return { statusCode: 502, headers, body: JSON.stringify({ error: friendly }) };
  }
};
