const {
  parseProductPage,
  cleanText,
  normalizeUrl,
  stripUrlNoise,
  guessTags
} = require("./genericIndexer");

async function fetchShopifyJson({ source, baseUrl, fetchJson, limit = 250 }) {
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

        if (products.length >= limit) return products;
      }
    } catch {
      break;
    }
  }

  return products;
}

function extractShopifyLinks(html, pageUrl, cheerio) {
  const $ = cheerio.load(html);
  const links = new Set();

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = normalizeUrl(href, pageUrl);
    if (!fullUrl) return;

    if (
      fullUrl.includes("/products/") ||
      (fullUrl.includes("/collections/") && fullUrl.includes("/products/"))
    ) {
      links.add(stripUrlNoise(fullUrl));
    }
  });

  return [...links];
}

async function runShopifyIndexer({ source, baseUrl, fetchHtml, fetchJson, cheerio, limit = 250 }) {
  let products = await fetchShopifyJson({
    source,
    baseUrl,
    fetchJson,
    limit
  });

  let usedJsonApi = products.length > 0;
  const pageErrors = [];
  const productErrors = [];
  const pagesCrawled = [];
  const productLinks = new Set();

  if (!products.length) {
    const crawlPages = [
      `${baseUrl}/collections/all`,
      `${baseUrl}/collections/all?sort_by=best-selling`,
      `${baseUrl}/collections/vehicles`,
      `${baseUrl}/collections/sirens`,
      `${baseUrl}/collections/fire-ems`,
      `${baseUrl}/collections/law-enforcement-packs`,
      `${baseUrl}/collections/dot-civilian-packs`,
      baseUrl
    ];

    for (const pageBase of [...new Set(crawlPages)]) {
      for (let page = 1; page <= 10; page++) {
        const pageUrl = pageBase.includes("?")
          ? `${pageBase}&page=${page}`
          : `${pageBase}?page=${page}`;

        try {
          const html = await fetchHtml(pageUrl);
          pagesCrawled.push(pageUrl);

          const links = extractShopifyLinks(html, pageUrl, cheerio);
          if (!links.length && page > 1) break;

          links.forEach(link => productLinks.add(link));
          if (productLinks.size >= limit) break;
        } catch (err) {
          pageErrors.push({ url: pageUrl, error: err.message });
          if (page === 1) break;
        }
      }

      if (productLinks.size >= limit) break;
    }

    products = [];

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
  }

  return {
    platform: "shopify",
    usedJsonApi,
    pagesCrawled,
    linksFound: productLinks.size || products.length,
    products,
    pageErrors,
    productErrors
  };
}

module.exports = { runShopifyIndexer };
