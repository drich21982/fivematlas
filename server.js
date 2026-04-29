const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");
const cheerio = require("cheerio");

const sourceRoutes = require("./routes/sources");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@test.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test123";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const sessions = new Set();

const USER_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
function nowPlusUserTtl() { return new Date(Date.now() + USER_SESSION_TTL_MS); }
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored = "") {
  const [salt, originalHash] = String(stored).split(":");
  if (!salt || !originalHash) return false;
  const testHash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(originalHash, "hex"), Buffer.from(testHash, "hex"));
}
function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, email: row.email, avatarUrl: row.avatar_url || "", bio: row.bio || "", website: row.website || "", discord: row.discord || "", role: row.role || "user", createdAt: row.created_at };
}
async function requireUser(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ success: false, message: "Unauthorized user request." });
  try {
    const result = await pool.query(`SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > NOW();`, [token]);
    if (!result.rows.length) return res.status(401).json({ success: false, message: "User session expired or invalid." });
    req.user = result.rows[0];
    req.userToken = token;
    next();
  } catch (err) { res.status(500).json({ success: false, message: "User auth failed.", error: err.message }); }
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");

  if (!token || !sessions.has(token)) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized admin request."
    });
  }

  next();
}

function cleanDomain(input = "") {
  return String(input)
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase()
    .trim();
}

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

function extractPrice(text = "") {
  const match = String(text).match(/\$\s?\d+(?:\.\d{2})?/);
  return match ? match[0].replace(/\s+/g, "") : null;
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "FiveMAtlasIndexer/1.0 (+https://fivematlas.com)",
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) throw new Error(`Fetch failed with status ${response.status}`);
  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "FiveMAtlasIndexer/1.0 (+https://fivematlas.com)",
      Accept: "application/json,text/plain,*/*"
    }
  });

  if (!response.ok) throw new Error(`JSON fetch failed with status ${response.status}`);
  return response.json();
}

function extractProductLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const links = new Set();

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const fullUrl = normalizeUrl(href, pageUrl);
    if (!fullUrl) return;
    if (!fullUrl.includes("/products/")) return;

    links.add(stripUrlNoise(fullUrl));
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
    .trim();

  const description =
    cleanText(jsonLd?.description) ||
    cleanText($('meta[name="description"]').attr("content")) ||
    cleanText($('meta[property="og:description"]').attr("content")) ||
    cleanText($(".product__description, .rte, [itemprop='description']").first().text());

  let imageUrl =
    jsonLd?.image ||
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $(".product img, img").first().attr("src");

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
    } catch (err) {
      console.warn("Shopify fallback failed:", err.message);
      break;
    }
  }

  return products;
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assets (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      developer TEXT NOT NULL,
      url TEXT NOT NULL,
      discord TEXT,
      description TEXT,
      tags TEXT[],
      price_type TEXT,
      framework TEXT,
      els_type TEXT,
      credits TEXT,
      verified BOOLEAN DEFAULT false,
      original_work BOOLEAN DEFAULT false,
      status TEXT DEFAULT 'approved',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      developer TEXT NOT NULL,
      url TEXT NOT NULL,
      discord TEXT,
      description TEXT,
      tags TEXT[],
      price_type TEXT,
      framework TEXT,
      els_type TEXT,
      credits TEXT,
      status TEXT DEFAULT 'pending',
      submitted_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trusted_sources (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      domain TEXT NOT NULL UNIQUE,
      base_url TEXT NOT NULL,
      enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS blacklisted_domains (
      id SERIAL PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE,
      reason TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS search_logs (
      id SERIAL PRIMARY KEY,
      query TEXT NOT NULL,
      source_count INTEGER DEFAULT 0,
      results_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS indexed_assets (
      id SERIAL PRIMARY KEY,
      source_id INTEGER REFERENCES trusted_sources(id) ON DELETE CASCADE,
      source_name TEXT,
      source_domain TEXT,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      description TEXT,
      category TEXT,
      price TEXT,
      image_url TEXT,
      tags TEXT[],
      indexed_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE indexed_assets ADD COLUMN IF NOT EXISTS image_url TEXT;`);

  await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS image_url TEXT;`);
  await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE indexed_assets ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, avatar_url TEXT, bio TEXT, website TEXT, discord TEXT, role TEXT DEFAULT 'user', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_sessions (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS favorites (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, asset_source TEXT NOT NULL, asset_id INTEGER NOT NULL, title TEXT, url TEXT, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_id, asset_source, asset_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS collections (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, description TEXT, visibility TEXT DEFAULT 'private', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS collection_items (id SERIAL PRIMARY KEY, collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, asset_source TEXT NOT NULL, asset_id INTEGER NOT NULL, title TEXT, url TEXT, created_at TIMESTAMP DEFAULT NOW(), UNIQUE(collection_id, asset_source, asset_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS click_logs (id SERIAL PRIMARY KEY, asset_source TEXT NOT NULL, asset_id INTEGER NOT NULL, title TEXT, url TEXT, query TEXT, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW());`);


  console.log("Database tables ready.");
}

app.get("/", (req, res) => {
  res.send("FiveM Atlas Backend is running");
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (err) {
    res.status(500).json({
      ok: false,
      database: "error",
      error: err.message
    });
  }
});

app.post("/admin/login", (req, res) => {
  const { email, password } = req.body;

  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Invalid admin login."
    });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.add(token);

  res.json({
    success: true,
    message: "Login successful",
    token
  });
});

app.post("/admin/logout", requireAdmin, (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");
  sessions.delete(token);
  res.json({ success: true });
});

app.use("/api/sources", sourceRoutes(pool, requireAdmin));

app.get("/api/indexer/test", (req, res) => {
  res.json({
    success: true,
    message: "Indexer route is loaded."
  });
});

app.get("/api/indexer/assets", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM indexed_assets
      ORDER BY indexed_at DESC
      LIMIT 300;
    `);

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

app.post("/api/indexer/source/:id", requireAdmin, async (req, res) => {
  const sourceId = Number(req.params.id);
  const { start_url, limit = 250 } = req.body || {};

  try {
    const sourceResult = await pool.query(
      "SELECT * FROM trusted_sources WHERE id = $1 AND enabled = true",
      [sourceId]
    );

    if (!sourceResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Trusted source not found or disabled."
      });
    }

    const source = sourceResult.rows[0];
    const baseUrl = String(source.base_url || start_url || "").replace(/\/$/, "");

    if (!baseUrl) {
      return res.status(400).json({
        success: false,
        message: "Trusted source is missing base_url."
      });
    }

    const crawlPages = [
      start_url || `${baseUrl}/collections/all`,
      `${baseUrl}/collections/all`,
      `${baseUrl}/collections/all?sort_by=best-selling`,
      `${baseUrl}/collections/vehicles`,
      `${baseUrl}/collections/sirens`,
      `${baseUrl}/collections/fire-ems`,
      `${baseUrl}/collections/law-enforcement-packs`,
      `${baseUrl}/collections/dot-civilian-packs`,
      baseUrl
    ];

    const productLinks = new Set();
    const pageErrors = [];

    for (const pageBase of [...new Set(crawlPages)]) {
      for (let page = 1; page <= 10; page++) {
        const pageUrl = pageBase.includes("?")
          ? `${pageBase}&page=${page}`
          : `${pageBase}?page=${page}`;

        try {
          const html = await fetchHtml(pageUrl);
          const links = extractProductLinks(html, pageUrl);

          console.log(`Indexer page checked: ${pageUrl} | product links found: ${links.length}`);

          if (!links.length && page > 1) break;

          links.forEach(link => productLinks.add(link));

          if (productLinks.size >= Number(limit)) break;
        } catch (err) {
          pageErrors.push({ url: pageUrl, error: err.message });
          if (page === 1) break;
        }
      }

      if (productLinks.size >= Number(limit)) break;
    }

    let products = [];
    const linksToIndex = [...productLinks].slice(0, Number(limit) || 250);

    for (const productUrl of linksToIndex) {
      try {
        const html = await fetchHtml(productUrl);
        const product = parseProductPage(html, productUrl, source);
        if (product) products.push(product);
      } catch {}
    }

    let usedFallback = false;

    if (!products.length) {
      usedFallback = true;
      products = await getShopifyProducts(source, baseUrl, Number(limit) || 250);
    }

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

    await pool.query(
      "INSERT INTO audit_logs (action, details) VALUES ($1, $2)",
      [
        "index_source",
        {
          sourceId: source.id,
          sourceDomain: source.domain,
          baseUrl,
          found: products.length,
          indexed,
          failed,
          usedFallback,
          pageErrors: pageErrors.slice(0, 10),
          productErrors: productErrors.slice(0, 10)
        }
      ]
    );

    res.json({
      success: true,
      message: "Source indexed.",
      source: source.domain,
      found: products.length,
      indexed,
      failed,
      usedFallback,
      pageErrors: pageErrors.slice(0, 10),
      productErrors: productErrors.slice(0, 10)
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

app.get("/search", async (req, res) => {
  const query = (req.query.q || "").trim();

  if (!query) {
    return res.json({
      query,
      count: 0,
      results: [],
      trustedSourcesUsed: 0,
      targetedSearchLinks: []
    });
  }

  try {
    const trustedSourcesResult = await pool.query(`
      SELECT *
      FROM trusted_sources
      WHERE enabled = true
      ORDER BY created_at DESC;
    `);

    const blacklistResult = await pool.query(`
      SELECT domain
      FROM blacklisted_domains;
    `);

    const blacklistedDomains = blacklistResult.rows.map(row => row.domain);

    const internalResult = await pool.query(
      `
      SELECT *
      FROM assets
      WHERE
        status = 'approved'
        AND (
          title ILIKE $1
          OR type ILIKE $1
          OR developer ILIKE $1
          OR description ILIKE $1
          OR url ILIKE $1
          OR EXISTS (
            SELECT 1 FROM unnest(tags) tag WHERE tag ILIKE $1
          )
        )
      ORDER BY created_at DESC
      LIMIT 50;
      `,
      [`%${query}%`]
    );

    const filteredInternal = internalResult.rows.filter(asset => {
      if (!asset.url) return true;
      const assetDomain = cleanDomain(asset.url);

      return !blacklistedDomains.some(domain => {
        const cleanBlacklisted = cleanDomain(domain);
        return (
          assetDomain.includes(cleanBlacklisted) ||
          String(asset.url).toLowerCase().includes(cleanBlacklisted)
        );
      });
    });

    const indexedResult = await pool.query(
      `
      SELECT *
      FROM indexed_assets
      WHERE
        title ILIKE $1
        OR description ILIKE $1
        OR source_name ILIKE $1
        OR source_domain ILIKE $1
        OR category ILIKE $1
        OR EXISTS (
          SELECT 1 FROM unnest(tags) tag WHERE tag ILIKE $1
        )
      ORDER BY indexed_at DESC
      LIMIT 50;
      `,
      [`%${query}%`]
    );

    const filteredIndexed = indexedResult.rows.filter(asset => {
      if (!asset.url) return true;
      const assetDomain = cleanDomain(asset.url);

      return !blacklistedDomains.some(domain => {
        const cleanBlacklisted = cleanDomain(domain);
        return (
          assetDomain.includes(cleanBlacklisted) ||
          String(asset.url).toLowerCase().includes(cleanBlacklisted)
        );
      });
    });

    const targetedSearchLinks = trustedSourcesResult.rows.map(source => ({
      sourceName: source.name,
      domain: source.domain,
      searchUrl: `https://www.google.com/search?q=site:${source.domain}+${encodeURIComponent(
        query + " FiveM"
      )}`
    }));

    const internalResults = filteredInternal.map(row => ({
      id: row.id,
      sourceType: "internal",
      title: row.title,
      type: row.type,
      developer: row.developer,
      url: row.url,
      discord: row.discord,
      description: row.description,
      imageUrl: row.image_url || null,
      tags: row.tags || [],
      priceType: row.price_type,
      framework: row.framework,
      elsType: row.els_type,
      verified: row.verified,
      originalWork: row.original_work,
      status: row.status
    }));

    const externalResults = filteredIndexed.map(row => ({
      id: row.id,
      sourceType: "indexed",
      title: row.title,
      type: row.category || "external",
      developer: row.source_name,
      url: row.url,
      discord: null,
      description: row.description,
      imageUrl: row.image_url || null,
      tags: row.tags || [],
      priceType: row.price || "unknown",
      framework: "unknown",
      elsType: "unknown",
      verified: false,
      originalWork: false,
      status: "indexed",
      sourceDomain: row.source_domain
    }));

    const combinedResults = [...internalResults, ...externalResults];

    await pool.query(
      `
      INSERT INTO search_logs (query, source_count, results_count)
      VALUES ($1, $2, $3);
      `,
      [query, trustedSourcesResult.rows.length, combinedResults.length]
    );

    res.json({
      query,
      count: combinedResults.length,
      trustedSourcesUsed: trustedSourcesResult.rows.length,
      targetedSearchLinks,
      results: combinedResults
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Search failed.",
      error: err.message
    });
  }
});

app.post("/submit-asset", async (req, res) => {
  const {
    title,
    type,
    developer,
    url,
    discord,
    description,
    tags,
    priceType,
    framework,
    elsType,
    credits
  } = req.body;

  if (!title || !type || !developer || !url) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields."
    });
  }

  const tagArray = Array.isArray(tags)
    ? tags
    : String(tags || "")
        .split(",")
        .map(t => t.trim())
        .filter(Boolean);

  try {
    const result = await pool.query(
      `
      INSERT INTO submissions
      (title, type, developer, url, discord, description, tags, price_type, framework, els_type, credits)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *;
      `,
      [
        title,
        type,
        developer,
        url,
        discord || "",
        description || "",
        tagArray,
        priceType || "unknown",
        framework || "unknown",
        elsType || "unknown",
        credits || ""
      ]
    );

    res.status(201).json({
      success: true,
      message: "Asset submitted for review.",
      submission: result.rows[0]
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Submission failed.",
      error: err.message
    });
  }
});

app.get("/admin/submissions", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM submissions WHERE status = 'pending' ORDER BY submitted_at DESC;"
    );

    res.json({
      count: result.rows.length,
      submissions: result.rows.map(row => ({
        id: row.id,
        title: row.title,
        type: row.type,
        developer: row.developer,
        url: row.url,
        discord: row.discord,
        description: row.description,
        tags: row.tags || [],
        priceType: row.price_type,
        framework: row.framework,
        elsType: row.els_type,
        credits: row.credits,
        status: row.status,
        submittedAt: row.submitted_at
      }))
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Could not load submissions.",
      error: err.message
    });
  }
});

app.post("/admin/approve/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  try {
    const submissionResult = await pool.query(
      "SELECT * FROM submissions WHERE id = $1;",
      [id]
    );

    if (!submissionResult.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Submission not found."
      });
    }

    const s = submissionResult.rows[0];

    const assetResult = await pool.query(
      `
      INSERT INTO assets
      (title, type, developer, url, discord, description, tags, price_type, framework, els_type, credits, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'approved')
      RETURNING *;
      `,
      [
        s.title,
        s.type,
        s.developer,
        s.url,
        s.discord,
        s.description,
        s.tags,
        s.price_type,
        s.framework,
        s.els_type,
        s.credits
      ]
    );

    await pool.query(
      "UPDATE submissions SET status = 'approved' WHERE id = $1;",
      [id]
    );

    await pool.query(
      "INSERT INTO audit_logs (action, details) VALUES ($1, $2);",
      ["approve_submission", { submissionId: id, assetId: assetResult.rows[0].id }]
    );

    res.json({
      success: true,
      message: "Submission approved.",
      asset: assetResult.rows[0]
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Approval failed.",
      error: err.message
    });
  }
});

app.post("/admin/reject/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  try {
    const result = await pool.query(
      "UPDATE submissions SET status = 'rejected' WHERE id = $1 RETURNING *;",
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        success: false,
        message: "Submission not found."
      });
    }

    await pool.query(
      "INSERT INTO audit_logs (action, details) VALUES ($1, $2);",
      ["reject_submission", { submissionId: id }]
    );

    res.json({
      success: true,
      message: "Submission rejected."
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Rejection failed.",
      error: err.message
    });
  }
});


app.post("/track-click", async (req, res) => {
  const { assetSource, assetId, title, url, query } = req.body || {};
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "").trim();
  let userId = null;
  if (!assetSource || !assetId || !url) return res.status(400).json({ success: false, message: "assetSource, assetId, and url are required." });
  try {
    if (token) {
      const userResult = await pool.query("SELECT user_id FROM user_sessions WHERE token = $1 AND expires_at > NOW()", [token]);
      userId = userResult.rows[0]?.user_id || null;
    }
    await pool.query(`INSERT INTO click_logs (asset_source, asset_id, title, url, query, user_id) VALUES ($1,$2,$3,$4,$5,$6);`, [assetSource, Number(assetId), title || "", url, query || "", userId]);
    if (assetSource === "internal") await pool.query("UPDATE assets SET clicks = COALESCE(clicks, 0) + 1 WHERE id = $1", [Number(assetId)]);
    else await pool.query("UPDATE indexed_assets SET clicks = COALESCE(clicks, 0) + 1 WHERE id = $1", [Number(assetId)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: "Click tracking failed.", error: err.message }); }
});

app.post("/auth/register", async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ success: false, message: "Username, email, and password are required." });
  if (String(password).length < 8) return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
  try {
    const result = await pool.query(`INSERT INTO users (username, email, password_hash) VALUES ($1, LOWER($2), $3) RETURNING *;`, [String(username).trim(), String(email).trim(), hashPassword(password)]);
    const token = crypto.randomBytes(40).toString("hex");
    await pool.query("INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1,$2,$3)", [result.rows[0].id, token, nowPlusUserTtl()]);
    res.status(201).json({ success: true, token, user: publicUser(result.rows[0]) });
  } catch (err) { if (err.code === "23505") return res.status(409).json({ success: false, message: "That username or email is already registered." }); res.status(500).json({ success: false, message: "Registration failed.", error: err.message }); }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = LOWER($1) OR username = $1 LIMIT 1", [String(email || "").trim()]);
    const user = result.rows[0];
    if (!user || !verifyPassword(password || "", user.password_hash)) return res.status(401).json({ success: false, message: "Invalid login." });
    const token = crypto.randomBytes(40).toString("hex");
    await pool.query("INSERT INTO user_sessions (user_id, token, expires_at) VALUES ($1,$2,$3)", [user.id, token, nowPlusUserTtl()]);
    res.json({ success: true, token, user: publicUser(user) });
  } catch (err) { res.status(500).json({ success: false, message: "Login failed.", error: err.message }); }
});

app.post("/auth/logout", requireUser, async (req, res) => { await pool.query("DELETE FROM user_sessions WHERE token = $1", [req.userToken]); res.json({ success: true }); });
app.get("/me", requireUser, async (req, res) => { res.json({ success: true, user: publicUser(req.user) }); });

app.patch("/me", requireUser, async (req, res) => {
  const { username, avatarUrl, bio, website, discord } = req.body || {};
  try {
    const result = await pool.query(`UPDATE users SET username = COALESCE(NULLIF($1, ''), username), avatar_url = $2, bio = $3, website = $4, discord = $5, updated_at = NOW() WHERE id = $6 RETURNING *;`, [username || req.user.username, avatarUrl || "", bio || "", website || "", discord || "", req.user.id]);
    res.json({ success: true, user: publicUser(result.rows[0]) });
  } catch (err) { if (err.code === "23505") return res.status(409).json({ success: false, message: "That username is already taken." }); res.status(500).json({ success: false, message: "Profile update failed.", error: err.message }); }
});

app.get("/favorites", requireUser, async (req, res) => { const result = await pool.query("SELECT * FROM favorites WHERE user_id = $1 ORDER BY created_at DESC", [req.user.id]); res.json({ success: true, favorites: result.rows }); });

app.post("/favorites", requireUser, async (req, res) => {
  const { assetSource, assetId, title, url } = req.body || {};
  if (!assetSource || !assetId) return res.status(400).json({ success: false, message: "assetSource and assetId are required." });
  const result = await pool.query(`INSERT INTO favorites (user_id, asset_source, asset_id, title, url) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, asset_source, asset_id) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url RETURNING *;`, [req.user.id, assetSource, Number(assetId), title || "", url || ""]);
  res.json({ success: true, favorite: result.rows[0] });
});

app.delete("/favorites/:source/:id", requireUser, async (req, res) => { await pool.query("DELETE FROM favorites WHERE user_id = $1 AND asset_source = $2 AND asset_id = $3", [req.user.id, req.params.source, Number(req.params.id)]); res.json({ success: true }); });

app.get("/collections", requireUser, async (req, res) => { const collections = await pool.query("SELECT * FROM collections WHERE user_id = $1 ORDER BY updated_at DESC", [req.user.id]); const items = await pool.query("SELECT * FROM collection_items WHERE user_id = $1 ORDER BY created_at DESC", [req.user.id]); res.json({ success: true, collections: collections.rows, items: items.rows }); });

app.post("/collections", requireUser, async (req, res) => { const { name, description, visibility } = req.body || {}; if (!name) return res.status(400).json({ success: false, message: "Collection name is required." }); const result = await pool.query(`INSERT INTO collections (user_id, name, description, visibility) VALUES ($1,$2,$3,$4) RETURNING *;`, [req.user.id, String(name).trim(), description || "", visibility || "private"]); res.status(201).json({ success: true, collection: result.rows[0] }); });

app.post("/collections/:id/items", requireUser, async (req, res) => {
  const { assetSource, assetId, title, url } = req.body || {};
  const collectionId = Number(req.params.id);
  const check = await pool.query("SELECT id FROM collections WHERE id = $1 AND user_id = $2", [collectionId, req.user.id]);
  if (!check.rows.length) return res.status(404).json({ success: false, message: "Collection not found." });
  const result = await pool.query(`INSERT INTO collection_items (collection_id, user_id, asset_source, asset_id, title, url) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (collection_id, asset_source, asset_id) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url RETURNING *;`, [collectionId, req.user.id, assetSource, Number(assetId), title || "", url || ""]);
  await pool.query("UPDATE collections SET updated_at = NOW() WHERE id = $1", [collectionId]);
  res.json({ success: true, item: result.rows[0] });
});

app.post("/report-broken-link", async (req, res) => {
  try {
    await pool.query(
      "INSERT INTO audit_logs (action, details) VALUES ($1, $2);",
      ["broken_link_report", req.body || {}]
    );

    res.json({
      success: true,
      message: "Broken link report received."
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Broken link report failed.",
      error: err.message
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: "Route not found",
    path: req.path
  });
});

initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`FiveM Atlas Backend running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("Database init failed:", err);
    process.exit(1);
  });
