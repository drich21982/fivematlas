const express = require("express");
const cheerio = require("cheerio");

const router = express.Router();

function cleanText(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return null;
  }
}

function guessTags(text = "") {
  const value = text.toLowerCase();
  const tags = [];

  const map = {
    bcso: ["bcso", "sheriff"],
    sasp: ["sasp", "state police"],
    sahp: ["sahp", "highway patrol"],
    lspd: ["lspd", "police"],
    leo: ["leo", "law enforcement"],
    eup: ["eup", "uniform"],
    livery: ["livery", "liveries"],
    vehicle: ["vehicle", "car", "pack"],
    script: ["script", "resource"],
    qbcore: ["qbcore", "qb-core", "qb"],
    esx: ["esx"],
    standalone: ["standalone"],
    map: ["map", "mlo", "ymap"]
  };

  for (const [tag, words] of Object.entries(map)) {
    if (words.some(word => value.includes(word))) {
      tags.push(tag);
    }
  }

  return [...new Set(tags)];
}

function extractPrice(text = "") {
  const match = text.match(/\$\s?\d+(\.\d{2})?/);
  return match ? match[0].replace(/\s+/g, "") : null;
}

module.exports = function (pool, requireAdmin) {
  router.post("/source/:id", requireAdmin, async (req, res) => {
    const sourceId = Number(req.params.id);
    const { start_url, limit = 100 } = req.body || {};

    try {
      const sourceResult = await pool.query(
        "SELECT * FROM trusted_sources WHERE id = $1",
        [sourceId]
      );

      if (!sourceResult.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Trusted source not found."
        });
      }

      const source = sourceResult.rows[0];
      const crawlUrl = start_url || source.base_url;

      const response = await fetch(crawlUrl, {
        headers: {
          "User-Agent": "FiveMAtlasIndexer/1.0"
        }
      });

      if (!response.ok) {
        return res.status(400).json({
          success: false,
          message: `Failed to fetch source. Status: ${response.status}`
        });
      }

      const html = await response.text();
      const $ = cheerio.load(html);

      const found = [];

      $("a").each((_, el) => {
        const href = $(el).attr("href");
        const title = cleanText($(el).text());

        if (!href || !title || title.length < 3) return;

        const fullUrl = normalizeUrl(href, crawlUrl);
        if (!fullUrl) return;

        const parsed = new URL(fullUrl);

        if (!parsed.hostname.includes(source.domain)) return;

        const lowerUrl = fullUrl.toLowerCase();
        const lowerTitle = title.toLowerCase();

        const likelyAsset =
          lowerUrl.includes("product") ||
          lowerUrl.includes("products") ||
          lowerUrl.includes("collection") ||
          lowerUrl.includes("collections") ||
          lowerUrl.includes("download") ||
          lowerTitle.includes("bcso") ||
          lowerTitle.includes("sasp") ||
          lowerTitle.includes("sahp") ||
          lowerTitle.includes("lspd") ||
          lowerTitle.includes("eup") ||
          lowerTitle.includes("livery") ||
          lowerTitle.includes("pack") ||
          lowerTitle.includes("vehicle") ||
          lowerTitle.includes("script");

        if (!likelyAsset) return;

        found.push({
          title,
          url: fullUrl
        });
      });

      const unique = Array.from(
        new Map(found.map(item => [item.url, item])).values()
      ).slice(0, Number(limit) || 100);

      let indexed = 0;

      for (const item of unique) {
        const combinedText = `${item.title} ${item.url}`;
        const tags = guessTags(combinedText);
        const price = extractPrice(combinedText);

        await pool.query(
          `
          INSERT INTO indexed_assets
          (source_id, source_name, source_domain, title, url, description, category, price, tags, indexed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
          ON CONFLICT (url)
          DO UPDATE SET
            title = EXCLUDED.title,
            source_name = EXCLUDED.source_name,
            source_domain = EXCLUDED.source_domain,
            tags = EXCLUDED.tags,
            indexed_at = NOW();
          `,
          [
            source.id,
            source.name,
            source.domain,
            item.title,
            item.url,
            "",
            "external",
            price,
            tags
          ]
        );

        indexed++;
      }

      await pool.query(
        "INSERT INTO audit_logs (action, details) VALUES ($1, $2)",
        [
          "index_source",
          {
            sourceId: source.id,
            sourceDomain: source.domain,
            startUrl: crawlUrl,
            indexed
          }
        ]
      );

      res.json({
        success: true,
        message: "Source indexed.",
        source: source.domain,
        startUrl: crawlUrl,
        indexed,
        found: unique.length
      });
    } catch (err) {
      console.error("Indexer error:", err);

      res.status(500).json({
        success: false,
        message: "Indexer failed.",
        error: err.message
      });
    }
  });

  router.get("/assets", requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM indexed_assets ORDER BY indexed_at DESC LIMIT 200"
      );

      res.json({
        success: true,
        count: result.rows.length,
        assets: result.rows
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        message: "Failed to load indexed assets.",
        error: err.message
      });
    }
  });

  return router;
};
