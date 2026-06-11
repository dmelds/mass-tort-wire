// Google Trends interest-over-time via the unofficial widget endpoints
// (same JSON the trends.google.com charts use). No API key, but Google may
// rate-limit datacenter IPs; failures return a clear error for the frontend.
// POST {"keywords": ["AFFF lawsuit", ...]} (max 5, a Trends comparison limit)

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

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  let keywords;
  try {
    keywords = JSON.parse(event.body).keywords.slice(0, 5);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "bad_body" }) };
  }
  if (!keywords || !keywords.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "no_keywords" }) };
  }

  try {
    // 1) Hit the explore page to pick up a session cookie
    const home = await fetch("https://trends.google.com/trends/explore?geo=US&hl=en-US", {
      headers: { "User-Agent": UA },
    });
    const cookie = (home.headers.get("set-cookie") || "").split(";")[0];

    // 2) Explore call returns widget tokens
    const req = {
      comparisonItem: keywords.map((k) => ({ keyword: k, geo: "US", time: "today 3-m" })),
      category: 0,
      property: "",
    };
    const exploreUrl =
      "https://trends.google.com/trends/api/explore?hl=en-US&tz=360&req=" +
      encodeURIComponent(JSON.stringify(req));
    const exploreRes = await fetch(exploreUrl, {
      headers: { "User-Agent": UA, cookie },
    });
    if (exploreRes.status === 429) throw new Error("rate_limited");
    const explore = stripPrefix(await exploreRes.text());
    const widget = (explore.widgets || []).find((w) => w.id === "TIMESERIES");
    if (!widget) throw new Error("no timeseries widget");

    // 3) Pull the timeline with the widget token
    const dataUrl =
      "https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=360&req=" +
      encodeURIComponent(JSON.stringify(widget.request)) +
      "&token=" + widget.token;
    const dataRes = await fetch(dataUrl, { headers: { "User-Agent": UA, cookie } });
    if (dataRes.status === 429) throw new Error("rate_limited");
    const data = stripPrefix(await dataRes.text());
    const timeline = data.default && data.default.timelineData;
    if (!timeline || !timeline.length) throw new Error("empty timeline");

    // 4) Per keyword: current level + recent momentum vs prior month
    const items = keywords.map((kw, i) => {
      const series = timeline.map((p) => (p.value && p.value[i]) || 0);
      const latest = series[series.length - 1];
      const recent = mean(series.slice(-7));
      const prior = mean(series.slice(-37, -7));
      const delta = prior > 0 ? Math.round(((recent - prior) / prior) * 100) : 0;
      const arrow = delta > 5 ? "RISING" : delta < -5 ? "FADING" : "STEADY";
      return {
        title: kw,
        source: "google trends \u00B7 US \u00B7 90d",
        url: "https://trends.google.com/trends/explore?geo=US&q=" + encodeURIComponent(kw),
        date: "",
        summary:
          arrow + " \u00B7 interest now " + latest + "/100 \u00B7 7-day avg " +
          (delta >= 0 ? "+" : "") + delta + "% vs prior month",
      };
    }).sort((a, b) => (a.summary.indexOf("RISING") === 0 ? -1 : 1) - (b.summary.indexOf("RISING") === 0 ? -1 : 1));

    return { statusCode: 200, headers, body: JSON.stringify({ items }) };
  } catch (err) {
    const msg = String(err.message || err);
    const friendly = msg === "rate_limited"
      ? "GOOGLE RATE-LIMITED THIS SERVER. TRY AGAIN IN A FEW MINUTES."
      : "TRENDS FETCH FAILED: " + msg.toUpperCase();
    return { statusCode: 502, headers, body: JSON.stringify({ error: friendly }) };
  }
};
