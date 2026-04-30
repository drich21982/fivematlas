const express = require("express");

module.exports = function (pool, requireAdmin) {
  const router = express.Router();

  router.get("/", async (req, res) => {
  try {
    const indexed = await pool.query(`
      SELECT
        id,
        'indexed' AS source_type,
        title,
        url,
        description,
        category AS type,
        price,
        image_url,
        tags,
        source_name,
        source_domain,
        indexed_at AS created_at
      FROM indexed_assets
      ORDER BY indexed_at DESC
      LIMIT 300;
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
        NULL AS image_url,
        tags,
        developer AS source_name,
        NULL AS source_domain,
        created_at
      FROM assets
      WHERE status = 'approved'
      ORDER BY created_at DESC
      LIMIT 300;
    `);

    res.json({
      success: true,
      count: indexed.rows.length + internal.rows.length,
      assets: [...indexed.rows, ...internal.rows]
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to load marketplace assets.",
      error: err.message
    });
  }
});

  // Get single asset (indexed OR internal)
  router.get("/:source/:id", async (req, res) => {
    const { source, id } = req.params;

    try {
      let result;

      if (source === "indexed") {
        result = await pool.query(
          "SELECT * FROM indexed_assets WHERE id = $1",
          [id]
        );
      } else {
        result = await pool.query(
          "SELECT * FROM assets WHERE id = $1",
          [id]
        );
      }

      if (!result.rows.length) {
        return res.status(404).json({
          success: false,
          message: "Asset not found."
        });
      }

      res.json({
        success: true,
        source,
        asset: result.rows[0]
      });
    } catch (err) {
      console.error("Asset fetch error:", err);

      res.status(500).json({
        success: false,
        message: "Failed to load asset.",
        error: err.message
      });
    }
  });

  return router;
};
