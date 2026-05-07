async function detectPlatform({ html = "", url = "" }) {
  const lowerHtml = String(html || "").toLowerCase();
  const lowerUrl = String(url || "").toLowerCase();

  // Arctic Development is a custom JS-rendered store. Do NOT send it to generic.
  if (
    lowerUrl.includes("arcticdevlabs.com") ||
    lowerUrl.includes("catalog.arcticdevlabs.com")
  ) {
    return "arctic-json";
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

module.exports = { detectPlatform };
