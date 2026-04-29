const express = require("express");
const router = express.Router();

module.exports = (pool, requireAdmin) => {
  async function ensurePartnersTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        logo_url TEXT,
        type TEXT,
        category TEXT,
        tier TEXT DEFAULT 'Verified Partner',
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
        is_official BOOLEAN DEFAULT false,
        display_order INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_partners_status ON partners(status);
      CREATE INDEX IF NOT EXISTS idx_partners_type ON partners(type);
      CREATE INDEX IF NOT EXISTS idx_partners_category ON partners(category);
      CREATE INDEX IF NOT EXISTS idx_partners_verified ON partners(is_verified);
      CREATE INDEX IF NOT EXISTS idx_partners_featured ON partners(is_featured);
      CREATE INDEX IF NOT EXISTS idx_partners_official ON partners(is_official);
      CREATE INDEX IF NOT EXISTS idx_partners_tier ON partners(tier);
    `);

    await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'Verified Partner'`);
    await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS is_official BOOLEAN DEFAULT false`);
  }

  function normalizeArray(value) {
    if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
    if (typeof value === "string") {
      return value
        .split(/[\n,]/g)
        .map(v => v.trim())
        .filter(Boolean);
    }
    return [];
  }

  function cleanText(value, fallback = "") {
    if (value === undefined || value === null) return fallback;
    return String(value).trim();
  }

  function cleanBool(value) {
    return value === true || value === "true" || value === 1 || value === "1";
  }

  function cleanInt(value, fallback = 0) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function readPartnerPayload(body = {}, partial = false) {
    const payload = {
      name: cleanText(body.name),
      logo_url: cleanText(body.logo_url),
      type: cleanText(body.type, "OTHER").toUpperCase(),
      category: cleanText(body.category, "CUSTOM").toUpperCase(),
      tier: cleanText(body.tier, cleanBool(body.is_official) ? "Official Partner" : cleanBool(body.is_featured) ? "Featured Partner" : "Verified Partner"),
      short_description: cleanText(body.short_description),
      full_description: cleanText(body.full_description),
      features: normalizeArray(body.features),
      departments: normalizeArray(body.departments),
      tags: normalizeArray(body.tags),
      member_count: cleanInt(body.member_count, 0),
      recruitment_status: cleanText(body.recruitment_status),
      discord_url: cleanText(body.discord_url),
      website_url: cleanText(body.website_url),
      owner_name: cleanText(body.owner_name),
      is_verified: cleanBool(body.is_verified),
      is_featured: cleanBool(body.is_featured),
      is_official: cleanBool(body.is_official),
      display_order: cleanInt(body.display_order, 0),
      status: cleanText(body.status, "active").toLowerCase()
    };

    if (!partial && !payload.name) {
      const err = new Error("Partner name is required.");
      err.status = 400;
      throw err;
    }

    if (!["active", "inactive", "deleted"].includes(payload.status)) payload.status = "active";
    return payload;
  }

  function publicSelect() {
    return `
      SELECT id, name, logo_url, type, category, tier, short_description, full_description,
             features, departments, tags, member_count, recruitment_status, discord_url,
             website_url, owner_name, is_verified, is_featured, is_official, display_order,
             status, created_at, updated_at
      FROM partners
    `;
  }

  router.get("/partners", async (req, res) => {
    try {
      await ensurePartnersTable();
      const { search, type, category, verified, featured, tier } = req.query;
      const where = ["status = 'active'"];
      const values = [];

      if (search) {
        values.push(`%${String(search).trim()}%`);
        where.push(`(name ILIKE $${values.length} OR short_description ILIKE $${values.length} OR full_description ILIKE $${values.length} OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) tag WHERE tag ILIKE $${values.length}))`);
      }
      if (type) {
        values.push(String(type).trim().toUpperCase());
        where.push(`UPPER(type) = $${values.length}`);
      }
      if (category) {
        values.push(String(category).trim().toUpperCase());
        where.push(`UPPER(category) = $${values.length}`);
      }
      if (verified === "true") where.push("is_verified = true");
      if (featured === "true") where.push("is_featured = true");
      if (tier) {
        values.push(String(tier).trim());
        where.push(`tier = $${values.length}`);
      }

      const result = await pool.query(
        `${publicSelect()} WHERE ${where.join(" AND ")}
         ORDER BY is_official DESC, is_featured DESC, display_order ASC, is_verified DESC, name ASC`,
        values
      );

      res.json({ success: true, partners: result.rows });
    } catch (err) {
      console.error("GET /api/partners failed:", err);
      res.status(err.status || 500).json({ success: false, message: err.message || "Failed to load partners." });
    }
  });

  router.get("/partners/:id", async (req, res) => {
    try {
      await ensurePartnersTable();
      const result = await pool.query(`${publicSelect()} WHERE id = $1 AND status = 'active'`, [req.params.id]);
      if (!result.rows[0]) return res.status(404).json({ success: false, message: "Partner not found." });
      res.json({ success: true, partner: result.rows[0] });
    } catch (err) {
      console.error("GET /api/partners/:id failed:", err);
      res.status(500).json({ success: false, message: "Failed to load partner." });
    }
  });

  router.get("/admin/partners", requireAdmin, async (req, res) => {
    try {
      await ensurePartnersTable();
      const result = await pool.query(`${publicSelect()} ORDER BY status ASC, is_official DESC, is_featured DESC, display_order ASC, id DESC`);
      res.json({ success: true, partners: result.rows });
    } catch (err) {
      console.error("GET /api/admin/partners failed:", err);
      res.status(500).json({ success: false, message: "Failed to load admin partners." });
    }
  });

  router.post("/admin/partners", requireAdmin, async (req, res) => {
    try {
      await ensurePartnersTable();
      const p = readPartnerPayload(req.body);
      const result = await pool.query(
        `INSERT INTO partners
         (name, logo_url, type, category, tier, short_description, full_description, features, departments, tags,
          member_count, recruitment_status, discord_url, website_url, owner_name, is_verified, is_featured,
          is_official, display_order, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [p.name, p.logo_url, p.type, p.category, p.tier, p.short_description, p.full_description,
         JSON.stringify(p.features), JSON.stringify(p.departments), JSON.stringify(p.tags), p.member_count,
         p.recruitment_status, p.discord_url, p.website_url, p.owner_name, p.is_verified, p.is_featured,
         p.is_official, p.display_order, p.status]
      );
      res.json({ success: true, partner: result.rows[0] });
    } catch (err) {
      console.error("POST /api/admin/partners failed:", err);
      res.status(err.status || 500).json({ success: false, message: err.message || "Failed to create partner." });
    }
  });

  router.put("/admin/partners/:id", requireAdmin, async (req, res) => {
    try {
      await ensurePartnersTable();
      const p = readPartnerPayload(req.body, true);
      if (!p.name) return res.status(400).json({ success: false, message: "Partner name is required." });
      const result = await pool.query(
        `UPDATE partners SET
          name=$1, logo_url=$2, type=$3, category=$4, tier=$5, short_description=$6,
          full_description=$7, features=$8::jsonb, departments=$9::jsonb, tags=$10::jsonb,
          member_count=$11, recruitment_status=$12, discord_url=$13, website_url=$14,
          owner_name=$15, is_verified=$16, is_featured=$17, is_official=$18,
          display_order=$19, status=$20, updated_at=NOW()
         WHERE id=$21
         RETURNING *`,
        [p.name, p.logo_url, p.type, p.category, p.tier, p.short_description, p.full_description,
         JSON.stringify(p.features), JSON.stringify(p.departments), JSON.stringify(p.tags), p.member_count,
         p.recruitment_status, p.discord_url, p.website_url, p.owner_name, p.is_verified, p.is_featured,
         p.is_official, p.display_order, p.status, req.params.id]
      );
      if (!result.rows[0]) return res.status(404).json({ success: false, message: "Partner not found." });
      res.json({ success: true, partner: result.rows[0] });
    } catch (err) {
      console.error("PUT /api/admin/partners/:id failed:", err);
      res.status(err.status || 500).json({ success: false, message: err.message || "Failed to update partner." });
    }
  });

  router.delete("/admin/partners/:id", requireAdmin, async (req, res) => {
    try {
      await ensurePartnersTable();
      const result = await pool.query(
        "UPDATE partners SET status = 'deleted', updated_at = NOW() WHERE id = $1 RETURNING id, name, status",
        [req.params.id]
      );
      if (!result.rows[0]) return res.status(404).json({ success: false, message: "Partner not found." });
      res.json({ success: true, partner: result.rows[0], message: "Partner deleted." });
    } catch (err) {
      console.error("DELETE /api/admin/partners/:id failed:", err);
      res.status(500).json({ success: false, message: "Failed to delete partner." });
    }
  });

  return router;
};
