const cheerio = require("cheerio");

function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function normalizeBaseUrl(url = "") {
  return String(url || "").trim().replace(/\/+$/, "");
}

function normalizeUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return null;
  }
}

function stripUrlNoise(url) {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function cleanDomain(input = "") {
  return String(input)
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase()
    .trim();
}

function extractPrice(text = "") {
  const match = String(text).match(/\$\s?\d+(?:\.\d{2})?/);
  return match ? match[0].replace(/\s+/g, "") : null;
}

function guessTags(text = "") {
  const value = String(text).toLowerCase();
  const tags = [];

  const map = {
    bcso: ["bcso", "sheriff"],
    sasp: ["sasp", "state police"],
    sahp: ["sahp", "highway patrol"],
    lspd: ["lspd", "police"],
    leo: ["leo", "law enforcement", "police", "sheriff"],
    eup: ["eup", "uniform"],
    livery: ["livery", "liveries"],
    vehicle: ["vehicle", "vehicles", "car", "truck", "suv", "cvpi", "charger", "tahoe", "explorer"],
    script: ["script", "resource"],
    qbcore: ["qbcore", "qb-core", "qb"],
    esx: ["esx"],
    standalone: ["standalone"],
    map: ["map", "mlo", "ymap"],
    fire: ["fire", "ems", "rescue"],
    dot: ["dot", "tow", "civilian"],
    siren: ["siren"],
    pack: ["pack"]
  };

  for (const [tag, words] of Object.entries(map)) {
    if (words.some(word => value.includes(word))) tags.push(tag);
  }

  return [...new Set(tags)];
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

function detectPlatform(html = "", url = "") {
  const lowerHtml = String(html).toLowerCase();
  const lowerUrl = String(url).toLowerCase();

  if (
    lowerUrl.includes("tebex.io") ||
    lowerHtml.includes("tebex") ||
    lowerHtml.includes("buycraft") ||
    lowerHtml.includes("/checkout/packages/add") ||
    lowerHtml.includes("/package/")
  ) {
    return "tebex";
  }

  if (
    lowerHtml.includes("shopify") ||
    lowerHtml.includes("cdn.shopify.com") ||
    lowerHtml.includes("/products/") ||
    lowerHtml.includes("shopify-section")
  ) {
    return "shopify";
  }

  return "generic";
}

function isBadUrl(url = "") {
  const lower = String(url).toLowerCase();

  const bad = [
    "#",
    "login",
    "logout",
    "cart",
    "checkout",
    "account",
    "privacy",
    "terms",
    "contact",
    "refund",
    "policy",
    "discord.gg",
    "youtube.com",
    "twitter.com",
    "x.com",
    "facebook.com",
    "instagram.com"
  ];

  return bad.some(item => lower.includes(item));
}

function looksLikeProductUrl(url = "") {
  const lower = String(url).toLowerCase();

  if (isBadUrl(lower)) return false;

  return (
    lower.includes("/shop/") ||
    lower.includes("/product/") ||
    lower.includes("/products/") ||
    lower.includes("/store/") ||
    lower.includes("/item/") ||
    lower.includes("/package/") ||
    lower.includes("/packages/")
  );
}

function looksLikeCategoryUrl(url = "") {
  const lower = String(url).toLowerCase();

  if (isBadUrl(lower)) return false;

  return (
    lower.includes("/shop") ||
    lower.includes("/collections/") ||
    lower.includes("/collection/") ||
    lower.includes("/category/") ||
    lower.includes("/categories/") ||
    lower.includes("/store")
  );
}

function extractLinks(html, pageUrl, sourceDomain) {
  const $ = cheerio.load(html);
  const links = new Set();
  const cleanSourceDomain = cleanDomain(sourceDomain);

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = normalizeUrl(href, pageUrl);
    if (!fullUrl) return;

    try {
      const parsed = new URL(fullUrl);
      const linkDomain = cleanDomain(parsed.hostname);

      if (!linkDomain.includes(cleanSourceDomain)) return;
      if (isBadUrl(fullUrl)) return;

      if (looksLikeProductUrl(fullUrl) || looksLikeCategoryUrl(fullUrl)) {
        links.add(stripUrlNoise(fullUrl));
      }
    } catch {}
  });

  return [...links];
}

function parseJsonLdProduct($) {
  const products = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).contents().text();
      if (!raw) return;

      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (item["@type"] === "Product") products.push(item);

        if (Array.isArray(item["@graph"])) {
          for (const graphItem of item["@graph"]) {
            if (graphItem["@type"] === "Product") products.push(graphItem);
          }
        }
      }
    } catch {}
  });

  return products[0] || null;
}

function parseProductPage(html, productUrl, source) {
  const $ = cheerio.load(html);
  const jsonLd = parseJsonLdProduct($);

  let title =
    cleanText(jsonLd?.name) ||
    cleanText($("h1").first().text()) ||
    cleanText($('meta[property="og:title"]').attr("content")) ||
    cleanText($("title").text());

  title = title
    .replace(/\s*[–|-]\s*Redneck Modifications LLC\s*$/i, "")
    .replace(/\s*[–|-]\s*RedneckMods\s*$/i, "")
    .replace(/\s*[–|-]\s*RedSaint Mods\s*$/i, "")
    .replace(/\s*[–|-]\s*RedSaint\s*$/i, "")
    .trim();

  const description =
    cleanText(jsonLd?.description) ||
    cleanText($('meta[name="description"]').attr("content")) ||
    cleanText($('meta[property="og:description"]').attr("content")) ||
    cleanText($(".product__description, .rte, [itemprop='description'], [class*='description']").first().text());

  let imageUrl =
    jsonLd?.image ||
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $(".product img, [class*='product'] img, img").first().attr("src");

  if (Array.isArray(imageUrl)) imageUrl = imageUrl[0];
  imageUrl = imageUrl ? normalizeUrl(imageUrl, productUrl) : null;

  let price = null;

  if (jsonLd?.offers) {
    const offer = Array.isArray(jsonLd.offers) ? jsonLd.offers[0] : jsonLd.offers;
    price = offer?.price || offer?.lowPrice || offer?.highPrice || null;
  }

  if (!price) {
    price =
      extractPrice(cleanText($("[class*='price'], [id*='price']").first().text())) ||
      extractPrice(cleanText($("body").text()));
  }

  const combinedText = `${title} ${description} ${productUrl}`;
  const tags = guessTags(combinedText);

  if (!title || title.length < 2 || !productUrl) return null;

  return {
    source_id: source.id,
    source_name: source.name,
    source_domain: source.domain,
    title,
    url: productUrl,
    description,
    category: tags[0] || "external",
    price: price ? String(price) : null,
    image_url: imageUrl,
    tags
  };
}

async function getShopifyProducts(source, baseUrl, limit = 250) {
  const products = [];

  for (let page = 1; page <= 10; page++) {
    const apiUrl = `${baseUrl}/products.json?limit=250&page=${page}`;

    try {
      const data = await fetchJson(apiUrl);
      const batch = data.products || [];

      if (!batch.length) break;

      for (const p of batch) {
        const title = cleanText(p.title);
        const description = cleanText(p.body_html || "");
        const url = `${baseUrl}/products/${p.handle}`;
        const price = p.variants?.[0]?.price || null;
        const imageUrl = p.images?.[0]?.src || null;
        const tags = guessTags(`${title} ${description} ${url}`);

        products.push({
          source_id: source.id,
          source_name: source.name,
          source_domain: source.domain,
          title,
          url,
          description,
          category: tags[0] || "external",
          price,
          image_url: imageUrl,
          tags
        });

        if (products.length >= Number(limit)) return products;
      }
    } catch {
      break;
    }
  }

  return products;
}

async function crawlGeneric(source, baseUrl, limit = 250) {
  const visited = new Set();
  const queue = [{ url: baseUrl, depth: 0 }];
  const productLinks = new Set();
  const pagesCrawled = [];
  const pageErrors = [];
  const productErrors = [];

  const maxDepth = 2;
  const maxPages = 50;

  while (queue.length && visited.size < maxPages && productLinks.size < limit) {
    const current = queue.shift();

    if (!current?.url || visited.has(current.url)) continue;

    visited.add(current.url);

    try {
      const html = await fetchHtml(current.url);
      pagesCrawled.push(current.url);

      const links = extractLinks(html, current.url, source.domain);

      for (const link of links) {
        if (looksLikeProductUrl(link)) {
          productLinks.add(link);
        }

        if (current.depth < maxDepth && !visited.has(link)) {
          queue.push({
            url: link,
            depth: current.depth + 1
          });
        }
      }
    } catch (err) {
      pageErrors.push({
        url: current.url,
        error: err.message
      });
    }
  }

  const products = [];

  for (const productUrl of [...productLinks].slice(0, limit)) {
    try {
      const html = await fetchHtml(productUrl);
      const product = parseProductPage(html, productUrl, source);
      if (product) products.push(product);
    } catch (err) {
      productErrors.push({
        url: productUrl,
        error: err.message
      });
    }
  }

  return {
    pagesCrawled,
    linksFound: productLinks.size,
    products,
    pageErrors,
    productErrors
  };
}

async function crawlShopify(source, baseUrl, limit = 250) {
  let products = await getShopifyProducts(source, baseUrl, limit);

  if (products.length) {
    return {
      pagesCrawled: [`${baseUrl}/products.json`],
      linksFound: products.length,
      products,
      pageErrors: [],
      productErrors: []
    };
  }

  return crawlGeneric(source, baseUrl, limit);
}

async function crawlTebex(source, baseUrl, limit = 250) {
  return crawlGeneric(source, baseUrl, limit);
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

  return {
    indexed,
    failed,
    productErrors
  };
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
  const platform = detectPlatform(firstHtml, baseUrl);

  let crawlResult;

  if (platform === "shopify") {
    crawlResult = await crawlShopify(source, baseUrl, limit);
  } else if (platform === "tebex") {
    crawlResult = await crawlTebex(source, baseUrl, limit);
  } else {
    crawlResult = await crawlGeneric(source, baseUrl, limit);
  }

  let saveResult = {
    indexed: 0,
    failed: 0,
    productErrors: []
  };

  if (save) {
    saveResult = await saveProducts(pool, crawlResult.products);
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
        found: crawlResult.products.length,
        indexed: saveResult.indexed,
        failed: saveResult.failed,
        pagesCrawled: crawlResult.pagesCrawled.length,
        linksFound: crawlResult.linksFound,
        pageErrors: crawlResult.pageErrors.slice(0, 10),
        productErrors: [
          ...crawlResult.productErrors.slice(0, 10),
          ...saveResult.productErrors.slice(0, 10)
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
    pagesCrawled: crawlResult.pagesCrawled.length,
    linksFound: crawlResult.linksFound,
    found: crawlResult.products.length,
    indexed: saveResult.indexed,
    failed: saveResult.failed,
    products: save ? undefined : crawlResult.products.slice(0, 25),
    pageErrors: crawlResult.pageErrors.slice(0, 10),
    productErrors: [
      ...crawlResult.productErrors.slice(0, 10),
      ...saveResult.productErrors.slice(0, 10)
    ]
  };
}

module.exports = { runIndexer };
