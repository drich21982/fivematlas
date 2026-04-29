const express = require("express");

module.exports = function (pool, requireAdmin) {
  const router = express.Router();

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
