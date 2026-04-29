const cheerio = require("cheerio");

function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
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

function extractPrice(text = "") {
  const match = String(text).match(/\$\s?\d+(?:\.\d{2})?/);
  return match ? match[0].replace(/\s+/g, "") : null;
}

function guessTags(text = "") {
  const value = text.toLowerCase();
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

function isBadUrl(url = "") {
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

  return bad.some(item => url.toLowerCase().includes(item));
}

function looksLikeProductUrl(url = "") {
  const lower = url.toLowerCase();

  if (isBadUrl(lower)) return false;

  return (
    lower.includes("/shop/") ||
    lower.includes("/product/") ||
    lower.includes("/products/") ||
    lower.includes("/store/") ||
    lower.includes("/item/") ||
    lower.includes("/package/")
  );
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

function extractLinks(html, pageUrl, sourceDomain) {
  const $ = cheerio.load(html);
  const links = new Set();

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = normalizeUrl(href, pageUrl);
    if (!fullUrl) return;

    try {
      const parsed = new URL(fullUrl);
      const cleanDomain = parsed.hostname.replace(/^www\./, "");

      if (!cleanDomain.includes(String(sourceDomain).replace(/^www\./, ""))) return;
      if (isBadUrl(fullUrl)) return;

      if (
        looksLikeProductUrl(fullUrl) ||
        fullUrl.includes("/collections/") ||
        fullUrl.includes("/category/")
      ) {
        links.add(stripUrlNoise(fullUrl));
      }
    } catch {}
  });

  return [...links];
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

async function runGenericIndexer({ source, baseUrl, fetchHtml, limit = 250, maxDepth = 2, maxPages = 50 }) {
  const visited = new Set();
  const queue = [{ url: baseUrl, depth: 0 }];
  const productLinks = new Set();
  const pageErrors = [];
  const pagesCrawled = [];

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
          queue.push({ url: link, depth: current.depth + 1 });
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
  const productErrors = [];

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
    platform: "generic",
    pagesCrawled,
    linksFound: productLinks.size,
    products,
    pageErrors,
    productErrors
  };
}

module.exports = {
  runGenericIndexer,
  parseProductPage,
  guessTags,
  cleanText,
  normalizeUrl,
  stripUrlNoise
};
