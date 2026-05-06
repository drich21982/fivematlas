const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");
const cheerio = require("cheerio");

const sourceRoutes = require("./routes/sources");
const partnersRoutes = require("./routes/partners");
const indexerRoutes = require("./routes/indexer");
const assetsRoutes = require("./routes/assets");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@test.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test123";
const FOUNDER_EMAIL = (process.env.FOUNDER_EMAIL || "dsjrich3@gmail.com").toLowerCase();
const FOUNDER_PASSWORD = process.env.FOUNDER_PASSWORD || ADMIN_PASSWORD;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const sessions = new Map();

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const session = token ? sessions.get(token) : null;

  if (!session || (session.role !== "admin" && session.role !== "founder")) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized admin request."
    });
  }

  req.admin = session;
  req.adminToken = token;
  next();
}

function requireFounder(req, res, next) {
  if (!req.admin || req.admin.role !== "founder") {
    return res.status(403).json({ success: false, message: "Founder access required." });
  }
  next();
}

function hashPassword(password = "") {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function normalizeEmail(email = "") {
  return String(email || "").trim().toLowerCase();
}

function isFounderEmail(email = "") {
  return normalizeEmail(email) === FOUNDER_EMAIL;
}

async function writeAdminLog(action, details = {}, admin = null) {
  try {
    await pool.query(
      "INSERT INTO admin_logs (admin_email, admin_role, action, details) VALUES ($1,$2,$3,$4)",
      [admin?.email || null, admin?.role || null, action, details]
    );
  } catch (err) {
    console.warn("Admin log failed:", err.message);
  }
}

function requireUserToken(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return res.status(401).json({ success: false, message: "Login required." });
  }

  req.userToken = token;
  req.userTokenHash = crypto.createHash("sha256").update(token).digest("hex");
  next();
}

function normalizeFavoriteSource(source = "") {
  const value = String(source || "").toLowerCase().trim();
  if (value === "internal" || value === "community") return "internal";
  return "indexed";
}

async function ensureFavoritesSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS favorites (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      token_hash TEXT,
      asset_source TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      title TEXT,
      url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS user_id INTEGER;`);
  await pool.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS token_hash TEXT;`);
  await pool.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS asset_source TEXT;`);
  await pool.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS asset_id TEXT;`);
  await pool.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS title TEXT;`);
  await pool.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS url TEXT;`);
  await pool.query(`ALTER TABLE favorites ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS favorites_token_asset_unique
    ON favorites(token_hash, asset_source, asset_id);
  `);
}




async function ensurePhaseTwoSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS project_templates (
    id SERIAL PRIMARY KEY,
    token_hash TEXT,
    title TEXT NOT NULL,
    category TEXT,
    description TEXT,
    payload JSONB DEFAULT '{}'::jsonb,
    visibility TEXT DEFAULT 'private',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_activity (
    id SERIAL PRIMARY KEY,
    token_hash TEXT,
    event TEXT NOT NULL,
    tool TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_notifications (
    id SERIAL PRIMARY KEY,
    token_hash TEXT,
    title TEXT NOT NULL,
    message TEXT,
    type TEXT DEFAULT 'info',
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS growth_requests (
    id SERIAL PRIMARY KEY,
    token_hash TEXT,
    kind TEXT NOT NULL,
    email TEXT,
    notes TEXT,
    status TEXT DEFAULT 'new',
    created_at TIMESTAMP DEFAULT NOW()
  );`);
}

async function ensureCollectionsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS collections (
      id SERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collection_items (
      id SERIAL PRIMARY KEY,
      collection_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      asset_source TEXT,
      asset_id TEXT,
      title TEXT,
      url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
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
  await pool.query(`ALTER TABLE indexed_assets ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS image_url TEXT;`);



  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      username TEXT,
      password_hash TEXT,
      role TEXT DEFAULT 'user',
      is_banned BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      last_login_at TIMESTAMP
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT UNIQUE;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user';`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_logs (
      id SERIAL PRIMARY KEY,
      admin_email TEXT,
      admin_role TEXT,
      action TEXT NOT NULL,
      details JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value JSONB DEFAULT '{}'::jsonb,
      updated_by TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      scope TEXT DEFAULT 'all',
      enabled BOOLEAN DEFAULT true,
      starts_at TIMESTAMP,
      ends_at TIMESTAMP,
      created_by TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS feature_toggles (
      key TEXT PRIMARY KEY,
      value BOOLEAN DEFAULT true,
      description TEXT,
      updated_by TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tool_analytics (
      id SERIAL PRIMARY KEY,
      tool TEXT NOT NULL,
      event TEXT NOT NULL,
      user_id TEXT,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS developers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      display_name TEXT NOT NULL,
      bio TEXT,
      avatar_url TEXT,
      verified BOOLEAN DEFAULT false,
      suspended BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE developers ADD COLUMN IF NOT EXISTS user_id INTEGER;`);
  await pool.query(`ALTER TABLE developers ADD COLUMN IF NOT EXISTS display_name TEXT;`);
  await pool.query(`ALTER TABLE developers ADD COLUMN IF NOT EXISTS bio TEXT;`);
  await pool.query(`ALTER TABLE developers ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
  await pool.query(`ALTER TABLE developers ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE developers ADD COLUMN IF NOT EXISTS suspended BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE developers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);

  await pool.query(`
    INSERT INTO feature_toggles (key, value, description)
    VALUES
      ('marketplace', true, 'Marketplace pages and asset browsing'),
      ('submissions', true, 'Public asset submissions'),
      ('tools', true, 'FiveM Atlas tools hub'),
      ('workspace', true, 'Tool workspace and local project hub'),
      ('developer_profiles', true, 'Developer profile pages'),
      ('favorites', true, 'User favorites system'),
      ('indexer', true, 'Trusted source indexing'),
      ('beta_tools', true, 'Experimental and advanced tools'),
      ('maintenance_mode', false, 'Founder-only maintenance mode')
    ON CONFLICT (key) DO NOTHING;
  `);

  await pool.query(
    `INSERT INTO users (email, username, password_hash, role)
     VALUES ($1, $2, $3, 'founder')
     ON CONFLICT (email) DO UPDATE SET role = 'founder', password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash);`,
    [FOUNDER_EMAIL, 'DSJ Rich', hashPassword(FOUNDER_PASSWORD)]
  );

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

app.post("/admin/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");

  try {
    let adminUser = null;

    if (email === normalizeEmail(ADMIN_EMAIL) && password === ADMIN_PASSWORD) {
      adminUser = { id: 0, email, role: isFounderEmail(email) ? "founder" : "admin", username: "Environment Admin" };
    }

    if (!adminUser) {
      const result = await pool.query("SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1", [email]);
      const user = result.rows[0];
      const passwordOk = user?.password_hash && user.password_hash === hashPassword(password);
      const founderPasswordOk = isFounderEmail(email) && (password === FOUNDER_PASSWORD || password === ADMIN_PASSWORD);

      if (user && !user.is_banned && (user.role === "admin" || user.role === "founder" || isFounderEmail(user.email)) && (passwordOk || founderPasswordOk)) {
        adminUser = { id: user.id, email: user.email, role: isFounderEmail(user.email) ? "founder" : user.role, username: user.username || user.email };
        await pool.query("UPDATE users SET last_login_at = NOW(), role = CASE WHEN lower(email)=lower($2) THEN 'founder' ELSE role END WHERE id = $1", [user.id, FOUNDER_EMAIL]);
      }
    }

    if (!adminUser) {
      return res.status(401).json({ success: false, message: "Invalid admin login or account is not an admin." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, adminUser);
    await writeAdminLog("admin_login", { email: adminUser.email }, adminUser);

    res.json({ success: true, message: "Login successful", token, user: adminUser, isFounder: adminUser.role === "founder" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Admin login failed.", error: err.message });
  }
});

app.post("/admin/logout", requireAdmin, (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace("Bearer ", "");
  sessions.delete(token);
  res.json({ success: true });
});


app.get("/admin/me", requireAdmin, (req, res) => {
  res.json({ success: true, user: req.admin, isFounder: req.admin.role === "founder" });
});

app.get("/api/public/settings", async (req, res) => {
  try {
    const result = await pool.query("SELECT key, value FROM site_settings WHERE key IN ('favicon','global_pfp','site_title')");
    const settings = {};
    for (const row of result.rows) settings[row.key] = row.value;
    res.json({ success: true, settings });
  } catch (err) {
    res.json({ success: true, settings: {} });
  }
});

app.get("/api/public/announcements", async (req, res) => {
  try {
    const scope = String(req.query.scope || "all").toLowerCase();
    const result = await pool.query(
      `SELECT * FROM announcements
       WHERE enabled = true
         AND (scope = 'all' OR scope = $1)
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (ends_at IS NULL OR ends_at >= NOW())
       ORDER BY created_at DESC
       LIMIT 5`,
      [scope]
    );
    res.json({ success: true, announcements: result.rows });
  } catch (err) {
    res.json({ success: true, announcements: [] });
  }
});

app.get("/api/public/features", async (req, res) => {
  try {
    const result = await pool.query("SELECT key, value FROM feature_toggles");
    res.json({ success: true, features: Object.fromEntries(result.rows.map(r => [r.key, r.value])) });
  } catch (err) {
    res.json({ success: true, features: {} });
  }
});

app.post("/api/tools/track", async (req, res) => {
  try {
    const { tool, event = "open", userId = null, metadata = {} } = req.body || {};
    if (!tool) return res.status(400).json({ success: false, message: "Missing tool." });
    await pool.query("INSERT INTO tool_analytics (tool, event, user_id, metadata) VALUES ($1,$2,$3,$4)", [String(tool), String(event), userId, metadata]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: "Tool tracking failed.", error: err.message });
  }
});

app.use("/api/sources", sourceRoutes(pool, requireAdmin));
app.use("/api", partnersRoutes(pool, requireAdmin));
app.use("/api/indexer", indexerRoutes(pool, requireAdmin));
app.use("/api/assets", assetsRoutes(pool, requireAdmin));

// ===== INIT PARTNERS TABLE (ONE-TIME SETUP ROUTE) =====
app.get("/init-partners-table", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partners (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          logo_url TEXT,
          type TEXT,
          category TEXT,
          short_description TEXT,
          full_description TEXT,
          features JSONB DEFAULT '[]'::jsonb,
          departments JSONB DEFAULT '[]'::jsonb,
          tags JSONB DEFAULT '[]'::jsonb,
          member_count INTEGER DEFAULT 0,
          recruitment_status TEXT,
          discord_url TEXT,
          website_url TEXT,
          owner_name TEXT,
          is_verified BOOLEAN DEFAULT false,
          is_featured BOOLEAN DEFAULT false,
          display_order INTEGER DEFAULT 0,
          status TEXT DEFAULT 'active',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status);
      CREATE INDEX IF NOT EXISTS idx_partners_type ON partners(type);
      CREATE INDEX IF NOT EXISTS idx_partners_category ON partners(category);
      CREATE INDEX IF NOT EXISTS idx_partners_verified ON partners(is_verified);
    `);

    res.json({ success: true, message: "Partners table created" });
  } catch (err) {
    console.error("Partners table error:", err);
    res.status(500).json({ error: err.message });
  }
});

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

app.post("/track-click", async (req, res) => {
  try {
    const source = normalizeFavoriteSource(req.body.source || req.body.sourceType || req.body.assetSource);
    const id = Number(req.body.id || req.body.assetId);
    if (!id) return res.json({ success: true, tracked: false });
    if (source === "internal") await pool.query("UPDATE assets SET clicks = COALESCE(clicks,0)+1 WHERE id=$1", [id]);
    else await pool.query("UPDATE indexed_assets SET clicks = COALESCE(clicks,0)+1 WHERE id=$1", [id]);
    res.json({ success: true, tracked: true });
  } catch (err) {
    res.json({ success: true, tracked: false });
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

app.get("/api/stats", async (req, res) => {
  try {
    const indexedResult = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM indexed_assets;
    `);

    const internalResult = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM assets
      WHERE status = 'approved';
    `);

    const sourcesResult = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM trusted_sources
      WHERE enabled = true;
    `);

    res.json({
      success: true,
      indexedAssets: indexedResult.rows[0].count,
      internalAssets: internalResult.rows[0].count,
      totalAssets: indexedResult.rows[0].count + internalResult.rows[0].count,
      trustedSources: sourcesResult.rows[0].count
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to load stats.",
      error: err.message
    });
  }
});


// ===== ADVANCED ADMIN / FOUNDER ROUTES =====
app.get("/admin/platform-analytics", requireAdmin, async (req, res) => {
  try {
    const q = async (sql) => (await pool.query(sql)).rows[0] || {};
    const [users, assets, indexed, submissions, favorites, searches, sources, blacklisted, announcements, developers] = await Promise.all([
      q("SELECT COUNT(*)::int AS count FROM users"),
      q("SELECT COUNT(*)::int AS count FROM assets"),
      q("SELECT COUNT(*)::int AS count FROM indexed_assets"),
      q("SELECT COUNT(*)::int AS count FROM submissions WHERE status='pending'"),
      q("SELECT COUNT(*)::int AS count FROM favorites"),
      q("SELECT COUNT(*)::int AS count FROM search_logs"),
      q("SELECT COUNT(*)::int AS count FROM trusted_sources WHERE enabled=true"),
      q("SELECT COUNT(*)::int AS count FROM blacklisted_domains"),
      q("SELECT COUNT(*)::int AS count FROM announcements"),
      q("SELECT COUNT(*)::int AS count FROM developers")
    ]);
    const topSearches = await pool.query("SELECT query, COUNT(*)::int AS count FROM search_logs GROUP BY query ORDER BY count DESC LIMIT 10");
    const topTools = await pool.query("SELECT tool, event, COUNT(*)::int AS count FROM tool_analytics GROUP BY tool, event ORDER BY count DESC LIMIT 20");
    res.json({ success: true, counts: { users: users.count || 0, assets: assets.count || 0, indexedAssets: indexed.count || 0, pendingSubmissions: submissions.count || 0, favorites: favorites.count || 0, searches: searches.count || 0, trustedSources: sources.count || 0, blacklistedDomains: blacklisted.count || 0, announcements: announcements.count || 0, developers: developers.count || 0 }, topSearches: topSearches.rows, topTools: topTools.rows, founder: req.admin.role === "founder" });
  } catch (err) { res.status(500).json({ success:false, message:"Analytics failed.", error:err.message }); }
});

app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const q = `%${String(req.query.q || "").trim()}%`;
    const result = await pool.query(`SELECT id,email,username,role,is_banned,created_at,last_login_at FROM users WHERE email ILIKE $1 OR username ILIKE $1 ORDER BY created_at DESC LIMIT 100`, [q]);
    res.json({ success:true, users: result.rows });
  } catch (err) { res.status(500).json({ success:false, message:"User search failed.", error:err.message }); }
});

app.post("/admin/users/promote", requireAdmin, requireFounder, async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email) return res.status(400).json({ success:false, message:"Email is required." });
  try {
    const result = await pool.query(`UPDATE users SET role='admin' WHERE lower(email)=lower($1) AND lower(email) <> lower($2) RETURNING id,email,username,role,is_banned,created_at,last_login_at`, [email, FOUNDER_EMAIL]);
    if (!result.rows.length) return res.status(404).json({ success:false, message:"No normal account exists with that email yet. Have them create a regular account first, then promote them here." });
    await writeAdminLog("promote_user_admin", { email }, req.admin);
    res.json({ success:true, user: result.rows[0] });
  } catch (err) { res.status(500).json({ success:false, message:"Promote failed.", error:err.message }); }
});

app.post("/admin/users/:id/role", requireAdmin, requireFounder, async (req, res) => {
  const role = String(req.body.role || "user");
  if (!["user","developer","admin"].includes(role)) return res.status(400).json({ success:false, message:"Invalid role." });
  try {
    const result = await pool.query(`UPDATE users SET role=$1 WHERE id=$2 AND lower(email) <> lower($3) RETURNING id,email,username,role,is_banned`, [role, req.params.id, FOUNDER_EMAIL]);
    await writeAdminLog("set_user_role", { id:req.params.id, role }, req.admin);
    res.json({ success:true, user: result.rows[0] || null });
  } catch (err) { res.status(500).json({ success:false, message:"Role update failed.", error:err.message }); }
});

app.post("/admin/users/:id/ban", requireAdmin, async (req, res) => {
  try {
    const banned = Boolean(req.body.banned);
    const result = await pool.query(`UPDATE users SET is_banned=$1 WHERE id=$2 AND lower(email) <> lower($3) RETURNING id,email,username,role,is_banned`, [banned, req.params.id, FOUNDER_EMAIL]);
    await writeAdminLog(banned ? "ban_user" : "unban_user", { id:req.params.id }, req.admin);
    res.json({ success:true, user: result.rows[0] || null });
  } catch (err) { res.status(500).json({ success:false, message:"Ban update failed.", error:err.message }); }
});

app.get("/admin/developers", requireAdmin, async (req, res) => {
  try {
    const q = `%${String(req.query.q || "").trim()}%`;
    const result = await pool.query(`SELECT d.*, u.email FROM developers d LEFT JOIN users u ON u.id=d.user_id WHERE d.display_name ILIKE $1 OR COALESCE(u.email,'') ILIKE $1 ORDER BY d.updated_at DESC, d.created_at DESC LIMIT 100`, [q]);
    res.json({ success:true, developers: result.rows });
  } catch (err) { res.status(500).json({ success:false, message:"Developers load failed.", error:err.message }); }
});

app.post("/admin/developers", requireAdmin, async (req,res)=>{
  try {
    const b=req.body||{};
    const result=await pool.query(`INSERT INTO developers (display_name,bio,avatar_url,verified,suspended) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [b.display_name||b.name, b.bio||'', b.avatar_url||'', !!b.verified, !!b.suspended]);
    await writeAdminLog("create_developer", result.rows[0], req.admin);
    res.json({success:true, developer:result.rows[0]});
  } catch(err){res.status(500).json({success:false,message:"Developer create failed.",error:err.message});}
});

app.patch("/admin/developers/:id", requireAdmin, async (req,res)=>{
  try {
    const b=req.body||{};
    const result=await pool.query(`UPDATE developers SET display_name=COALESCE($1,display_name), bio=COALESCE($2,bio), avatar_url=COALESCE($3,avatar_url), verified=COALESCE($4,verified), suspended=COALESCE($5,suspended), updated_at=NOW() WHERE id=$6 RETURNING *`, [b.display_name??null,b.bio??null,b.avatar_url??null,b.verified??null,b.suspended??null,req.params.id]);
    await writeAdminLog("update_developer", {id:req.params.id, changes:b}, req.admin);
    res.json({success:true, developer:result.rows[0]||null});
  } catch(err){res.status(500).json({success:false,message:"Developer update failed.",error:err.message});}
});

app.get("/admin/announcements", requireAdmin, async (req,res)=>{
  try { const result=await pool.query("SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100"); res.json({success:true, announcements:result.rows}); } catch(err){res.status(500).json({success:false,message:"Announcements failed.",error:err.message});}
});
app.post("/admin/announcements", requireAdmin, async (req,res)=>{
  try { const b=req.body||{}; const result=await pool.query(`INSERT INTO announcements (title,message,type,scope,enabled,starts_at,ends_at,created_by) VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::timestamp,NULLIF($7,'')::timestamp,$8) RETURNING *`, [b.title,b.message,b.type||'info',b.scope||'all',b.enabled!==false,b.starts_at||'',b.ends_at||'',req.admin.email]); await writeAdminLog("create_announcement", result.rows[0], req.admin); res.json({success:true, announcement:result.rows[0]}); } catch(err){res.status(500).json({success:false,message:"Announcement create failed.",error:err.message});}
});
app.patch("/admin/announcements/:id", requireAdmin, async (req,res)=>{
  try { const b=req.body||{}; const result=await pool.query(`UPDATE announcements SET title=COALESCE($1,title), message=COALESCE($2,message), type=COALESCE($3,type), scope=COALESCE($4,scope), enabled=COALESCE($5,enabled), starts_at=NULLIF(COALESCE($6, starts_at::text),'')::timestamp, ends_at=NULLIF(COALESCE($7, ends_at::text),'')::timestamp, updated_at=NOW() WHERE id=$8 RETURNING *`, [b.title??null,b.message??null,b.type??null,b.scope??null,b.enabled??null,b.starts_at??null,b.ends_at??null,req.params.id]); await writeAdminLog("update_announcement", {id:req.params.id, changes:b}, req.admin); res.json({success:true, announcement:result.rows[0]||null}); } catch(err){res.status(500).json({success:false,message:"Announcement update failed.",error:err.message});}
});
app.delete("/admin/announcements/:id", requireAdmin, async (req,res)=>{ try { await pool.query("DELETE FROM announcements WHERE id=$1", [req.params.id]); await writeAdminLog("delete_announcement", {id:req.params.id}, req.admin); res.json({success:true}); } catch(err){res.status(500).json({success:false,message:"Announcement delete failed.",error:err.message});} });

app.get("/admin/features", requireAdmin, async (req,res)=>{ try { const result=await pool.query("SELECT * FROM feature_toggles ORDER BY key"); res.json({success:true, features:result.rows}); } catch(err){res.status(500).json({success:false,message:"Features failed.",error:err.message});} });
app.patch("/admin/features/:key", requireAdmin, async (req,res)=>{ try { const founderOnly=["maintenance_mode","indexer"]; if(founderOnly.includes(req.params.key) && req.admin.role!=="founder") return res.status(403).json({success:false,message:"Founder access required for this toggle."}); const result=await pool.query(`INSERT INTO feature_toggles (key,value,description,updated_by) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, description=COALESCE(EXCLUDED.description, feature_toggles.description), updated_by=EXCLUDED.updated_by, updated_at=NOW() RETURNING *`, [req.params.key, !!req.body.value, req.body.description || null, req.admin.email]); await writeAdminLog("update_feature_toggle", {key:req.params.key, value:!!req.body.value}, req.admin); res.json({success:true, feature:result.rows[0]}); } catch(err){res.status(500).json({success:false,message:"Feature update failed.",error:err.message});} });

app.get("/admin/tool-analytics", requireAdmin, async (req,res)=>{ try { const summary=await pool.query("SELECT tool,event,COUNT(*)::int AS count, MAX(created_at) AS last_used FROM tool_analytics GROUP BY tool,event ORDER BY count DESC LIMIT 100"); const recent=await pool.query("SELECT * FROM tool_analytics ORDER BY created_at DESC LIMIT 50"); res.json({success:true, summary:summary.rows, recent:recent.rows}); } catch(err){res.status(500).json({success:false,message:"Tool analytics failed.",error:err.message});} });

app.get("/admin/search-logs", requireAdmin, async (req,res)=>{ try { const result=await pool.query("SELECT * FROM search_logs ORDER BY created_at DESC LIMIT 100"); res.json({success:true, logs:result.rows}); } catch(err){res.status(500).json({success:false,message:"Search logs failed.",error:err.message});} });
app.get("/admin/audit-logs", requireAdmin, async (req,res)=>{ try { const result=await pool.query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100"); const admin=await pool.query("SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 100"); res.json({success:true, logs:result.rows, adminLogs:admin.rows}); } catch(err){res.status(500).json({success:false,message:"Audit logs failed.",error:err.message});} });
app.get("/admin/broken-links", requireAdmin, async (req,res)=>{ try { const result=await pool.query("SELECT * FROM audit_logs WHERE action='broken_link_report' ORDER BY created_at DESC LIMIT 100"); res.json({success:true, reports:result.rows}); } catch(err){res.status(500).json({success:false,message:"Broken links failed.",error:err.message});} });

app.get("/admin/site-settings", requireAdmin, requireFounder, async (req,res)=>{ try { const result=await pool.query("SELECT * FROM site_settings ORDER BY key"); res.json({success:true, settings:result.rows}); } catch(err){res.status(500).json({success:false,message:"Settings failed.",error:err.message});} });
app.put("/admin/site-settings/:key", requireAdmin, requireFounder, async (req,res)=>{ try { const result=await pool.query(`INSERT INTO site_settings (key,value,updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW() RETURNING *`, [req.params.key, req.body.value || {}, req.admin.email]); await writeAdminLog("update_site_setting", {key:req.params.key}, req.admin); res.json({success:true, setting:result.rows[0]}); } catch(err){res.status(500).json({success:false,message:"Setting update failed.",error:err.message});} });

// ===== SIMPLE USER AUTH =====
app.post("/auth/register", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const username = String(req.body.username || "").trim() || email;
  const password = String(req.body.password || "");
  if (!email || !password) return res.status(400).json({ success:false, message:"Email and password are required." });
  try {
    const result = await pool.query(
      `INSERT INTO users (email, username, password_hash, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO NOTHING RETURNING id,email,username,role,is_banned,created_at,last_login_at`,
      [email, username, hashPassword(password), isFounderEmail(email) ? 'founder' : 'user']
    );
    if (!result.rows.length) return res.status(409).json({ success:false, message:"Account already exists." });
    const user = result.rows[0];
    const token = crypto.randomBytes(32).toString("hex");
    res.status(201).json({ success:true, token, user });
  } catch (err) { res.status(500).json({ success:false, message:"Registration failed.", error:err.message }); }
});

app.post("/auth/login", async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || "");
  try {
    const result = await pool.query("SELECT id,email,username,role,is_banned,password_hash,created_at,last_login_at FROM users WHERE lower(email)=lower($1) LIMIT 1", [email]);
    const user = result.rows[0];
    if (!user || user.is_banned || user.password_hash !== hashPassword(password)) return res.status(401).json({ success:false, message:"Invalid login." });
    await pool.query("UPDATE users SET last_login_at=NOW() WHERE id=$1", [user.id]);
    delete user.password_hash;
    const token = crypto.randomBytes(32).toString("hex");
    res.json({ success:true, token, user });
  } catch (err) { res.status(500).json({ success:false, message:"Login failed.", error:err.message }); }
});

app.post("/auth/logout", (req, res) => {
  res.json({ success: true });
});

app.get("/me", requireUserToken, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.userTokenHash,
      name: "Atlas User"
    }
  });
});


// ===== COLLECTIONS ROUTES =====
app.get("/collections", requireUserToken, async (req, res) => {
  try {
    await ensureCollectionsSchema();
    const collections = await pool.query(
      "SELECT id, name, description, created_at FROM collections WHERE token_hash = $1 ORDER BY created_at DESC",
      [req.userTokenHash]
    );
    const items = await pool.query(
      "SELECT id, collection_id, asset_source, asset_id, title, url, created_at FROM collection_items WHERE token_hash = $1 ORDER BY created_at DESC",
      [req.userTokenHash]
    );
    res.json({ success: true, collections: collections.rows, items: items.rows });
  } catch (err) {
    console.error("Collections load error:", err);
    res.status(500).json({ success: false, message: "Failed to load collections.", error: err.message });
  }
});

app.post("/collections", requireUserToken, async (req, res) => {
  try {
    await ensureCollectionsSchema();
    const name = String(req.body.name || "").trim();
    const description = String(req.body.description || "").trim();
    if (!name) return res.status(400).json({ success: false, message: "Collection name is required." });
    const result = await pool.query(
      "INSERT INTO collections (token_hash, name, description) VALUES ($1, $2, $3) RETURNING id, name, description, created_at",
      [req.userTokenHash, name, description || null]
    );
    res.json({ success: true, collection: result.rows[0] });
  } catch (err) {
    console.error("Collection create error:", err);
    res.status(500).json({ success: false, message: "Failed to create collection.", error: err.message });
  }
});



// ===== PHASE 2 PLATFORM / RETENTION ROUTES =====
app.get("/api/dashboard", requireUserToken, async (req, res) => {
  try {
    await ensurePhaseTwoSchema();
    const [templates, activity, notifications, favorites] = await Promise.all([
      pool.query("SELECT id,title,category,description,visibility,created_at,updated_at FROM project_templates WHERE token_hash=$1 OR visibility='public' ORDER BY updated_at DESC LIMIT 20", [req.userTokenHash]),
      pool.query("SELECT event,tool,metadata,created_at FROM user_activity WHERE token_hash=$1 ORDER BY created_at DESC LIMIT 50", [req.userTokenHash]),
      pool.query("SELECT id,title,message,type,is_read,created_at FROM user_notifications WHERE token_hash=$1 OR token_hash IS NULL ORDER BY created_at DESC LIMIT 20", [req.userTokenHash]),
      pool.query("SELECT COUNT(*)::int AS count FROM favorites WHERE token_hash=$1", [req.userTokenHash])
    ]);
    res.json({ success:true, templates:templates.rows, activity:activity.rows, notifications:notifications.rows, favoritesCount:favorites.rows[0]?.count || 0 });
  } catch (err) { res.status(500).json({ success:false, message:"Dashboard failed.", error:err.message }); }
});

app.post("/api/user/activity", requireUserToken, async (req,res)=>{
  try { await ensurePhaseTwoSchema(); const b=req.body||{}; await pool.query("INSERT INTO user_activity (token_hash,event,tool,metadata) VALUES ($1,$2,$3,$4)", [req.userTokenHash, b.event||'activity', b.tool||null, b.metadata||{}]); res.json({success:true}); } catch(err){res.status(500).json({success:false,message:"Activity save failed.",error:err.message});}
});

app.get("/api/notifications", requireUserToken, async (req,res)=>{
  try { await ensurePhaseTwoSchema(); const r=await pool.query("SELECT id,title,message,type,is_read,created_at FROM user_notifications WHERE token_hash=$1 OR token_hash IS NULL ORDER BY created_at DESC LIMIT 50", [req.userTokenHash]); res.json({success:true, notifications:r.rows}); } catch(err){res.status(500).json({success:false,message:"Notifications failed.",error:err.message});}
});
app.post("/api/notifications", requireUserToken, async (req,res)=>{
  try { await ensurePhaseTwoSchema(); const b=req.body||{}; const r=await pool.query("INSERT INTO user_notifications (token_hash,title,message,type) VALUES ($1,$2,$3,$4) RETURNING *", [req.userTokenHash,b.title||'Atlas Notification',b.message||'',b.type||'info']); res.json({success:true, notification:r.rows[0]}); } catch(err){res.status(500).json({success:false,message:"Notification create failed.",error:err.message});}
});
app.patch("/api/notifications/:id/read", requireUserToken, async (req,res)=>{
  try { await ensurePhaseTwoSchema(); await pool.query("UPDATE user_notifications SET is_read=TRUE WHERE id=$1 AND (token_hash=$2 OR token_hash IS NULL)", [req.params.id, req.userTokenHash]); res.json({success:true}); } catch(err){res.status(500).json({success:false,message:"Notification update failed.",error:err.message});}
});

app.get("/api/templates", requireUserToken, async (req,res)=>{
  try { await ensurePhaseTwoSchema(); const r=await pool.query("SELECT * FROM project_templates WHERE token_hash=$1 OR visibility='public' ORDER BY updated_at DESC LIMIT 100", [req.userTokenHash]); res.json({success:true, templates:r.rows}); } catch(err){res.status(500).json({success:false,message:"Templates failed.",error:err.message});}
});
app.post("/api/templates", requireUserToken, async (req,res)=>{
  try { await ensurePhaseTwoSchema(); const b=req.body||{}; const r=await pool.query("INSERT INTO project_templates (token_hash,title,category,description,payload,visibility) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [req.userTokenHash,b.title||'Untitled Template',b.category||'General',b.description||'',b.payload||{},b.visibility||'private']); res.json({success:true, template:r.rows[0]}); } catch(err){res.status(500).json({success:false,message:"Template create failed.",error:err.message});}
});

app.get("/api/subscriptions/plans", (req,res)=>{
  res.json({success:true, plans:[
    {key:'verified_developer', name:'Verified Developer', benefits:['Verified badge','Boosted trust','Portfolio analytics']},
    {key:'premium_tools', name:'Premium Tool Pack', benefits:['Advanced generators','More exports','Priority templates']},
    {key:'marketplace_boost', name:'Marketplace Promotion', benefits:['Featured placement','Higher visibility','Campaign analytics']}
  ]});
});
app.post("/api/growth-requests", requireUserToken, async (req,res)=>{
  try { await ensurePhaseTwoSchema(); const b=req.body||{}; const r=await pool.query("INSERT INTO growth_requests (token_hash,kind,email,notes) VALUES ($1,$2,$3,$4) RETURNING *", [req.userTokenHash,b.kind||'general',normalizeEmail(b.email||''),b.notes||'']); res.json({success:true, request:r.rows[0]}); } catch(err){res.status(500).json({success:false,message:"Growth request failed.",error:err.message});}
});
app.post("/api/subscriptions/interest", requireUserToken, async (req,res)=>{ try { await ensurePhaseTwoSchema(); const b=req.body||{}; const r=await pool.query("INSERT INTO growth_requests (token_hash,kind,email,notes) VALUES ($1,$2,$3,$4) RETURNING *", [req.userTokenHash,b.kind||'subscription_interest',normalizeEmail(b.email||''),b.notes||'']); res.json({success:true, request:r.rows[0]}); } catch(err){res.status(500).json({success:false,message:"Subscription interest failed.",error:err.message});} });

// ===== FAVORITES ROUTES =====
app.get("/favorites", requireUserToken, async (req, res) => {
  try {
    await ensureFavoritesSchema();

    const result = await pool.query(
      `
      SELECT id, asset_source, asset_source AS source_type, asset_id, title, url, created_at
      FROM favorites
      WHERE token_hash = $1
      ORDER BY created_at DESC;
      `,
      [req.userTokenHash]
    );

    res.json({ success: true, count: result.rows.length, favorites: result.rows });
  } catch (err) {
    console.error("Favorites load error:", err);
    res.status(500).json({ success: false, message: "Failed to load favorites.", error: err.message });
  }
});

app.post("/favorites", requireUserToken, async (req, res) => {
  const assetSource = normalizeFavoriteSource(req.body.assetSource || req.body.asset_source || req.body.source || req.body.sourceType);
  const assetId = String(req.body.assetId || req.body.asset_id || req.body.id || "").trim();
  const title = req.body.title || null;
  const url = req.body.url || null;

  if (!assetId) {
    return res.status(400).json({ success: false, message: "Missing assetId." });
  }

  try {
    await ensureFavoritesSchema();

    const result = await pool.query(
      `
      INSERT INTO favorites (token_hash, asset_source, asset_id, title, url)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (token_hash, asset_source, asset_id)
      DO UPDATE SET
        title = COALESCE(EXCLUDED.title, favorites.title),
        url = COALESCE(EXCLUDED.url, favorites.url)
      RETURNING id, asset_source, asset_source AS source_type, asset_id, title, url, created_at;
      `,
      [req.userTokenHash, assetSource, assetId, title, url]
    );

    res.json({ success: true, message: "Favorite saved.", favorite: result.rows[0] });
  } catch (err) {
    console.error("Favorite save error:", err);
    res.status(500).json({ success: false, message: "Failed to save favorite.", error: err.message });
  }
});

app.delete("/favorites/:source/:id", requireUserToken, async (req, res) => {
  const assetSource = normalizeFavoriteSource(req.params.source);
  const assetId = String(req.params.id || "").trim();

  if (!assetId) {
    return res.status(400).json({ success: false, message: "Missing asset id." });
  }

  try {
    await ensureFavoritesSchema();

    const result = await pool.query(
      `
      DELETE FROM favorites
      WHERE token_hash = $1
        AND asset_source = $2
        AND asset_id = $3
      RETURNING id;
      `,
      [req.userTokenHash, assetSource, assetId]
    );

    res.json({ success: true, removed: result.rowCount > 0 });
  } catch (err) {
    console.error("Favorite remove error:", err);
    res.status(500).json({ success: false, message: "Failed to remove favorite.", error: err.message });
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
