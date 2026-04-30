const express = require("express");

module.exports = function (pool, requireAdmin) {
  const router = express.Router();

  async function ensureAssetsRouteSchema() {
    await pool.query(`ALTER TABLE trusted_sources ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;`);
    await pool.query(`ALTER TABLE indexed_assets ADD COLUMN IF NOT EXISTS department TEXT DEFAULT 'na';`);
    await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS image_url TEXT;`);
    await pool.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS department TEXT DEFAULT 'na';`);
  }

  function normalizeSource(source = "") {
    const value = String(source || "").toLowerCase().trim();
    if (value === "indexed") return "indexed";
    if (value === "internal" || value === "community") return "internal";
    return "indexed";
  }

  router.get("/", async (req, res) => {
    try {
      await ensureAssetsRouteSchema();

      const indexed = await pool.query(`
        SELECT
          ia.id,
          'indexed' AS source_type,
          ia.title,
          ia.url,
          ia.description,
          ia.category AS type,
          ia.price,
          ia.image_url,
          ia.tags,
          ia.source_name,
          ia.source_domain,
          ia.department,
          COALESCE(ts.is_verified, false) AS is_verified,
          ia.indexed_at AS created_at
        FROM indexed_assets ia
        LEFT JOIN trusted_sources ts ON ts.id = ia.source_id
        ORDER BY ia.indexed_at DESC
        LIMIT 500;
      `);

      const internal = await pool.query(`
        SELECT
          id,
          'internal' AS source_type,
          title,
          url,
          description,
          type,
          price_type AS price,
          image_url,
          tags,
          developer AS source_name,
          NULL AS source_domain,
          department,
          COALESCE(verified, false) AS is_verified,
          created_at
        FROM assets
        WHERE status = 'approved'
        ORDER BY created_at DESC
        LIMIT 500;
      `);

      const assets = [...indexed.rows, ...internal.rows];
      res.json({ success: true, count: assets.length, assets });
    } catch (err) {
      console.error("Marketplace assets error:", err);
      res.status(500).json({ success: false, message: "Failed to load marketplace assets.", error: err.message });
    }
  });

  router.get("/:source/:id", async (req, res) => {
    const source = normalizeSource(req.params.source);
    const id = Number(req.params.id);

    if (!id) return res.status(400).json({ success: false, message: "Invalid asset id." });

    try {
      await ensureAssetsRouteSchema();
      let result;

      if (source === "indexed") {
        result = await pool.query(
          `SELECT ia.*, COALESCE(ts.is_verified, false) AS is_verified
           FROM indexed_assets ia
           LEFT JOIN trusted_sources ts ON ts.id = ia.source_id
           WHERE ia.id = $1;`,
          [id]
        );
      } else {
        result = await pool.query(`SELECT * FROM assets WHERE id = $1;`, [id]);
      }

      if (!result.rows.length) return res.status(404).json({ success: false, message: "Asset not found." });
      res.json({ success: true, source, asset: result.rows[0] });
    } catch (err) {
      console.error("Asset fetch error:", err);
      res.status(500).json({ success: false, message: "Failed to load asset.", error: err.message });
    }
  });

  return router;
};
