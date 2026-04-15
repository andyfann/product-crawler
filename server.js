const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin.endsWith(".vercel.app")) return cb(null, true);
    const allowed = (process.env.FRONTEND_URL || "").split(",").map(s => s.trim());
    if (allowed.some(o => origin.startsWith(o))) return cb(null, true);
    if (origin.includes("localhost")) return cb(null, true);
    cb(new Error("CORS blocked"));
  },
  methods: ["GET", "POST"],
}));

app.use(express.json());

function extractFromHTML(html, url) {
  const $ = cheerio.load(html);
  const data = {};

  data.title =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("h1").first().text().trim() ||
    $("title").text().trim() || null;

  const images = new Set();
  const og = $('meta[property="og:image"]').attr("content");
  if (og) images.add(og);
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (!src) return;
    if (src.includes("icon") || src.includes("logo") || src.includes("sprite")) return;
    if (src.startsWith("http")) images.add(src);
    else if (src.startsWith("//")) images.add("https:" + src);
  });
  data.images = [...images].slice(0, 10);

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (!(item["@type"] || "").toString().toLowerCase().includes("product")) continue;
        if (item.name && !data.title) data.title = item.name;
        if (item.brand?.name && !data.brand) data.brand = item.brand.name;
        if (item.description && !data.description) data.description = item.description.slice(0, 300);
        if (item.sku && !data.sku) data.sku = String(item.sku);
        if (item.image) {
          const imgs = Array.isArray(item.image) ? item.image : [item.image];
          data.images = [...new Set([...imgs.filter(i => typeof i === "string"), ...data.images])].slice(0, 10);
        }
        if (item.offers) {
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (offer?.price && !data.price) data.price = offer.price + (offer.priceCurrency ? " " + offer.priceCurrency : "");
          if (offer?.availability && !data.availability)
            data.availability = offer.availability.includes("InStock") ? "In Stock" : "Out of Stock";
        }
        if (item.aggregateRating && !data.rating) {
          data.rating = item.aggregateRating.ratingValue;
          data.review_count = item.aggregateRating.reviewCount;
        }
        if (item.color && !data.colors) data.colors = [item.color];
        if (item.size && !data.sizes) data.sizes = [item.size];
      }
    } catch (_) {}
  });

  if (!data.price) {
    for (const sel of ["[itemprop=price]","[class*=price]","[id*=price]",".sale-price",".current-price"]) {
      const t = $(sel).first().text().trim();
      if (t && /[\d,\.]+/.test(t)) { data.price = t.slice(0, 60); break; }
    }
  }

  if (!data.description) {
    const d = $('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content");
    if (d) data.description = d.slice(0, 300);
  }

  if (!data.colors) {
    const s = new Set();
    $('[class*=color] [title],[class*=colour] [title],[class*=swatch] [title]').each((_, el) => {
      const t = $(el).attr("title") || $(el).text().trim();
      if (t && t.length < 30) s.add(t);
    });
    if (s.size) data.colors = [...s];
  }

  if (!data.sizes) {
    const s = new Set();
    $('[class*=size] button,[class*=size] li,[class*=Size] option').each((_, el) => {
      const t = $(el).text().trim();
      if (t && t.length < 10) s.add(t);
    });
    if (s.size) data.sizes = [...s];
  }

  const crumbs = [];
  $('[class*=breadcrumb] a, nav[aria-label*=bread] a').each((_, el) => crumbs.push($(el).text().trim()));
  if (crumbs.length) data.category = crumbs.slice(-2).join(" > ");

  try {
    const h = new URL(url).hostname;
    if (h.includes("shopee")) data.platform = "Shopee";
    else if (h.includes("lazada")) data.platform = "Lazada";
    else if (h.includes("tiki")) data.platform = "Tiki";
    else if (h.includes("amazon")) data.platform = "Amazon";
    else if (h.includes("ebay")) data.platform = "eBay";
    else data.platform = h.replace("www.", "");
  } catch (_) {}

  data.url = url;
  return data;
}

app.get("/", (_, res) => res.json({ status: "ok", name: "Product Crawler API", version: "2.0" }));
app.get("/api/health", (_, res) => res.json({ status: "ok" }));

app.post("/api/crawl", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
      },
      maxRedirects: 5,
    });
    res.json({ success: true, method: "http", data: extractFromHTML(response.data, url) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
