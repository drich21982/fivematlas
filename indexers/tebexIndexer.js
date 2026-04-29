const cheerio = require("cheerio");
const {
  parseProductPage,
  normalizeUrl,
  stripUrlNoise
} = require("./genericIndexer");

function isBadTebexUrl(url = "") {
  const lower = url.toLowerCase();

  return (
    lower.includes("checkout") ||
    lower.includes("basket") ||
    lower.includes("cart") ||
    lower.includes("login") ||
    lower.includes("terms") ||
    lower.includes("privacy")
  );
}

function extractTebexLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const links = new Set();

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = normalizeUrl(href, pageUrl);
    if (!fullUrl) return;
    if (isBadTebexUrl(fullUrl)) return;

    if (
      fullUrl.includes("/package/") ||
      fullUrl.includes("/packages/") ||
      fullUrl.includes("/category/") ||
      fullUrl.includes("/categories/")
    ) {
      links.add(stripUrlNoise(fullUrl));
    }
  });

  return [...links];
}

function looksLikeTebexProduct(url = "") {
  const lower = url.toLowerCase();

  return (
    lower.includes("/package/") ||
    lower.includes("/packages/")
  );
}

async function runTebexIndexer({ source, baseUrl, fetchHtml, limit = 250, maxPages = 50 }) {
  const visited = new Set();
  const queue = [{ url: baseUrl, depth: 0 }];
  const productLinks = new Set();
  const pagesCrawled = [];
  const pageErrors = [];

  while (queue.length && visited.size < maxPages && productLinks.size < limit) {
    const current = queue.shift();

    if (!current?.url || visited.has(current.url)) continue;
    visited.add(current.url);

    try {
      const html = await fetchHtml(current.url);
      pagesCrawled.push(current.url);

      const links = extractTebexLinks(html, current.url);

      for (const link of links) {
        if (looksLikeTebexProduct(link)) {
          productLinks.add(link);
        } else if (current.depth < 2) {
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
    platform: "tebex",
    pagesCrawled,
    linksFound: productLinks.size,
    products,
    pageErrors,
    productErrors
  };
}

module.exports = { runTebexIndexer };
