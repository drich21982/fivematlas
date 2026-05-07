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
    lowerUrl.includes("arcticdevlabs.com") ||
    lowerUrl.includes("catalog.arcticdevlabs.com") ||
    lowerHtml.includes("catalog.arcticdevlabs.com") ||
    lowerHtml.includes("arctic development")
  ) {
    return "arctic_custom";
  }

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


function htmlDecode(value = "") {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function isJunkArcticTitle(title = "") {
  const value = cleanText(title).toLowerCase();
  if (!value || value.length < 4) return true;
  const badExact = new Set([
    "our store",
    "vehicle catalog",
    "arctic development",
    "established 2024",
    "quick links",
    "contact us",
    "legal stuff",
    "vehicles",
    "vehicle",
    "scripts",
    "graphics",
    "leo",
    "fire",
    "civilian",
    "lore friendly",
    "generic lore",
    "all brands",
    "all gta base models",
    "30-80k polys"
  ]);
  if (badExact.has(value)) return true;
  if (/^(home|store|team|discord|youtube|tiktok|documentation)$/i.test(value)) return true;
  return false;
}

function looksLikeArcticAssetTitle(title = "") {
  const t = cleanText(title);
  if (isJunkArcticTitle(t)) return false;
  const lower = t.toLowerCase();

  if (/\b(19|20)\d{2}\b/.test(t)) return true;
  if (/\b(leo|fire|ems|police|sheriff|generic|lore|fivem|ready|addon|pack|vehicle|truck|charger|tahoe|explorer|crown vic|cvpi|corvette|durango|ram|ford|chevy|dodge|gmc|bmw|audi|toyota|nissan|cadillac|mustang|camaro)\b/i.test(t)) return true;
  if (lower.includes(" | ") && t.length > 8) return true;

  return false;
}

function extractFromJsObjectWindow(windowText = "") {
  const obj = {};

  const get = (keys) => {
    const quoteClass = "[\"'`]";
    const valueClass = "([^\"'`]{2,180})";

    for (const key of keys) {
      const patterns = [
        new RegExp(key + "\\s*:\\s*" + quoteClass + valueClass + quoteClass, "i"),
        new RegExp("[\"']" + key + "[\"']\\s*:\\s*" + quoteClass + valueClass + quoteClass, "i")
      ];
      for (const pattern of patterns) {
        const match = windowText.match(pattern);
        if (match?.[1]) return htmlDecode(cleanText(match[1]));
      }
    }
    return null;
  };

  obj.title = get(["title", "name", "label", "displayName", "vehicleName"]);
  obj.description = get(["description", "desc", "summary", "shortDescription"]);
  obj.brand = get(["brand", "make", "manufacturer"]);
  obj.model = get(["model"]);
  obj.type = get(["type", "category", "vehicleType"]);
  obj.price = get(["price", "cost"]);
  obj.url = get(["url", "href", "link", "storeUrl", "productUrl"]);
  obj.image_url = get(["image", "imageUrl", "img", "src", "thumbnail", "thumbnailUrl", "photo"]);

  return obj;
}

function collectArcticProductsFromText(text = "", source, catalogBase, productsByKey) {
  const input = String(text || "");

  // Parse JS/JSON-ish object windows that contain title/name style fields.
  const keyRegex = /(?:[\"']?(?:title|name|displayName|vehicleName)[\"']?\s*:\s*[\"'`][^\"'`]{3,180}[\"'`])/gi;
  let match;
  while ((match = keyRegex.exec(input))) {
    const start = Math.max(0, match.index - 600);
    const end = Math.min(input.length, match.index + 1800);
    const windowText = input.slice(start, end);
    const obj = extractFromJsObjectWindow(windowText);

    let title = obj.title;
    if (!title && obj.brand && obj.model) title = `${obj.brand} ${obj.model}`;
    if (!looksLikeArcticAssetTitle(title)) continue;

    const url = obj.url && /^https?:\/\//i.test(obj.url)
      ? obj.url
      : `${catalogBase}/?search=${encodeURIComponent(title)}`;

    const imageUrl = obj.image_url
      ? normalizeUrl(obj.image_url, catalogBase)
      : null;

    const descriptionParts = [obj.description, obj.brand, obj.model, obj.type].filter(Boolean);
    const description = cleanText(descriptionParts.join(" · ")) || "Arctic Development vehicle catalog asset.";
    const tags = guessTags(`${title} ${description} ${url}`);

    productsByKey.set(title.toLowerCase(), {
      source_id: source.id,
      source_name: source.name,
      source_domain: source.domain,
      title,
      url,
      description,
      category: tags[0] || "vehicle",
      price: obj.price || null,
      image_url: imageUrl,
      tags: [...new Set(["vehicle", ...tags])]
    });
  }

  // Fallback: pull quoted strings that look like actual vehicle/product names.
  const stringRegex = /[\"'`]([^\"'`]{4,140})[\"'`]/g;
  while ((match = stringRegex.exec(input))) {
    const title = htmlDecode(cleanText(match[1]));
    if (!looksLikeArcticAssetTitle(title)) continue;
    const key = title.toLowerCase();
    if (productsByKey.has(key)) continue;
    const tags = guessTags(title);
    productsByKey.set(key, {
      source_id: source.id,
      source_name: source.name,
      source_domain: source.domain,
      title,
      url: `${catalogBase}/?search=${encodeURIComponent(title)}`,
      description: "Arctic Development vehicle catalog asset.",
      category: tags[0] || "vehicle",
      price: null,
      image_url: null,
      tags: [...new Set(["vehicle", ...tags])]
    });
  }
}

function extractScriptUrls(html, pageUrl) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src");
    const full = normalizeUrl(src, pageUrl);
    if (full) urls.add(full);
  });
  $("link[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !/\.js(?:\?|$)/i.test(href)) return;
    const full = normalizeUrl(href, pageUrl);
    if (full) urls.add(full);
  });
  return [...urls];
}

async function fetchTextLoose(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "FiveMAtlasIndexer/1.0 (+https://fivematlas.com)",
      Accept: "text/html,application/javascript,text/javascript,application/json,text/plain,*/*"
    }
  });
  if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);
  return response.text();
}

async function crawlArcticCustom(source, baseUrl, limit = 250) {
  const catalogBase = "https://catalog.arcticdevlabs.com";
  const pagesCrawled = [];
  const pageErrors = [];
  const productErrors = [];
  const productsByKey = new Map();
  const crawledTexts = new Set();

  const seedUrls = [
    baseUrl,
    catalogBase,
    `${catalogBase}/`,
    `${catalogBase}/index.html`,
    `${catalogBase}/manifest.json`,
    `${catalogBase}/asset-manifest.json`,
    `${catalogBase}/data.json`,
    `${catalogBase}/vehicles.json`,
    `${catalogBase}/catalog.json`,
    `${catalogBase}/api/vehicles`,
    `${catalogBase}/api/catalog`,
    `${catalogBase}/api/products`
  ];

  const scriptUrls = new Set();

  for (const url of seedUrls) {
    if (crawledTexts.has(url)) continue;
    crawledTexts.add(url);
    try {
      const text = await fetchTextLoose(url);
      pagesCrawled.push(url);
      collectArcticProductsFromText(text, source, catalogBase, productsByKey);
      for (const scriptUrl of extractScriptUrls(text, url)) scriptUrls.add(scriptUrl);

      // Some static apps expose bundled JS filenames inside manifests.
      const bundleMatches = text.match(/(?:static\/js\/|assets\/)[A-Za-z0-9._/-]+\.js/g) || [];
      for (const bundle of bundleMatches) scriptUrls.add(normalizeUrl(bundle, catalogBase));
    } catch (err) {
      pageErrors.push({ url, error: err.message });
    }
  }

  for (const scriptUrl of [...scriptUrls].filter(Boolean).slice(0, 40)) {
    if (crawledTexts.has(scriptUrl)) continue;
    crawledTexts.add(scriptUrl);
    try {
      const text = await fetchTextLoose(scriptUrl);
      pagesCrawled.push(scriptUrl);
      collectArcticProductsFromText(text, source, catalogBase, productsByKey);
    } catch (err) {
      pageErrors.push({ url: scriptUrl, error: err.message });
    }
  }

  const products = [...productsByKey.values()]
    .filter(product => looksLikeArcticAssetTitle(product.title))
    .slice(0, Number(limit));

  return {
    pagesCrawled,
    linksFound: products.length,
    products,
    pageErrors,
    productErrors
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

  if (platform === "arctic_custom") {
    crawlResult = await crawlArcticCustom(source, baseUrl, limit);
  } else if (platform === "shopify") {
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
