const express = require("express");
const { runIndexer } = require("../indexers/runIndexer");

const router = express.Router();

module.exports = function (pool, requireAdmin) {
  router.get("/test", (req, res) => {
    res.json({
      success: true,
      message: "Indexer route is loaded."
    });
  });

  router.get("/test/:id", requireAdmin, async (req, res) => {
    try {
      const sourceId = Number(req.params.id);

      const result = await runIndexer(pool, {
        sourceId,
        limit: 50,
        save: false
      });

      res.json(result);
    } catch (err) {
      console.error("Indexer test error:", err);

      res.status(500).json({
        success: false,
        message: "Indexer test failed.",
        error: err.message
      });
    }
  });

  router.post("/source/:id", requireAdmin, async (req, res) => {
    try {
      const sourceId = Number(req.params.id);
      const { start_url, limit = 250 } = req.body || {};

      const result = await runIndexer(pool, {
        sourceId,
        startUrl: start_url,
        limit: Number(limit) || 250,
        save: true
      });

      res.json(result);
    } catch (err) {
      console.error("Indexer error:", err);

      res.status(500).json({
        success: false,
        message: "Indexer failed.",
        error: err.message
      });
    }
  });

  router.get("/assets", requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM indexed_assets ORDER BY indexed_at DESC LIMIT 300"
      );

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

  return router;
};
