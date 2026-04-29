const cheerio = require("cheerio");
const { detectPlatform } = require("./detectPlatform");
const { runShopifyIndexer } = require("./shopifyIndexer");
const { runTebexIndexer } = require("./tebexIndexer");
const { runGenericIndexer } = require("./genericIndexer");

function normalizeBaseUrl(url = "") {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "FiveMAtlasIndexer/1.0 (+https://fivematlas.com)",
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    throw new Error(`Fetch failed with status ${response.status}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "FiveMAtlasIndexer/1.0 (+https://fivematlas.com)",
      Accept: "application/json,text/plain,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`JSON fetch failed with status ${response.status}`);
  }

  return response.json();
}

async function saveProducts(pool, products = []) {
  let indexed = 0;
  let failed = 0;
  const productErrors = [];

  for (const product of products) {
    try {
      await pool.query(
        `
        INSERT INTO indexed_assets
        (source_id, source_name, source_domain, title, url, description, category, price, image_url, tags, indexed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        ON CONFLICT (url)
        DO UPDATE SET
          source_id = EXCLUDED.source_id,
          source_name = EXCLUDED.source_name,
          source_domain = EXCLUDED.source_domain,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          category = EXCLUDED.category,
          price = EXCLUDED.price,
          image_url = EXCLUDED.image_url,
          tags = EXCLUDED.tags,
          indexed_at = NOW();
        `,
        [
          product.source_id,
          product.source_name,
          product.source_domain,
          product.title,
          product.url,
          product.description,
          product.category,
          product.price,
          product.image_url,
          product.tags
        ]
      );

      indexed++;
    } catch (err) {
      failed++;
      productErrors.push({
        url: product.url,
        error: err.message
      });
    }
  }

  return { indexed, failed, productErrors };
}

async function runIndexer(pool, options = {}) {
  const {
    sourceId,
    startUrl,
    limit = 250,
    save = true
  } = options;

  if (!sourceId) {
    throw new Error("Missing sourceId.");
  }

  const sourceResult = await pool.query(
    "SELECT * FROM trusted_sources WHERE id = $1 AND enabled = true",
    [sourceId]
  );

  if (!sourceResult.rows.length) {
    throw new Error("Trusted source not found or disabled.");
  }

  const source = sourceResult.rows[0];
  const baseUrl = normalizeBaseUrl(startUrl || source.base_url);

  if (!baseUrl) {
    throw new Error("Trusted source is missing base_url.");
  }

  const firstHtml = await fetchHtml(baseUrl);
  const platform = await detectPlatform({
    html: firstHtml,
    url: baseUrl
  });

  let indexResult;

  if (platform === "shopify") {
    indexResult = await runShopifyIndexer({
      source,
      baseUrl,
      fetchHtml,
      fetchJson,
      cheerio,
      limit
    });
  } else if (platform === "tebex") {
    indexResult = await runTebexIndexer({
      source,
      baseUrl,
      fetchHtml,
      limit
    });
  } else {
    indexResult = await runGenericIndexer({
      source,
      baseUrl,
      fetchHtml,
      limit
    });
  }

  let saveResult = {
    indexed: 0,
    failed: 0,
    productErrors: []
  };

  if (save) {
    saveResult = await saveProducts(pool, indexResult.products);
  }

  await pool.query(
    "INSERT INTO audit_logs (action, details) VALUES ($1, $2)",
    [
      save ? "index_source" : "test_index_source",
      {
        sourceId: source.id,
        sourceName: source.name,
        sourceDomain: source.domain,
        baseUrl,
        platform,
        found: indexResult.products.length,
        indexed: saveResult.indexed,
        failed: saveResult.failed,
        pagesCrawled: indexResult.pagesCrawled?.length || 0,
        linksFound: indexResult.linksFound || 0,
        pageErrors: indexResult.pageErrors?.slice(0, 10) || [],
        productErrors: [
          ...(indexResult.productErrors?.slice(0, 10) || []),
          ...(saveResult.productErrors?.slice(0, 10) || [])
        ]
      }
    ]
  );

  return {
    success: true,
    message: save ? "Source indexed." : "Indexer test completed.",
    source: {
      id: source.id,
      name: source.name,
      domain: source.domain,
      baseUrl
    },
    platform,
    pagesCrawled: indexResult.pagesCrawled?.length || 0,
    linksFound: indexResult.linksFound || 0,
    found: indexResult.products.length,
    indexed: saveResult.indexed,
    failed: saveResult.failed,
    products: save ? undefined : indexResult.products.slice(0, 25),
    pageErrors: indexResult.pageErrors?.slice(0, 10) || [],
    productErrors: [
      ...(indexResult.productErrors?.slice(0, 10) || []),
      ...(saveResult.productErrors?.slice(0, 10) || [])
    ]
  };
}

module.exports = { runIndexer };
