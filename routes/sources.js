const express = require("express");
const router = express.Router();

module.exports = (pool, requireAdmin) => {
  // ===============================
  // TRUSTED SOURCES
  // ===============================

  // GET all trusted sources (public)
  router.get("/trusted", async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM trusted_sources ORDER BY created_at DESC"
      );

      res.json({
        success: true,
        sources: result.rows,
      });
    } catch (err) {
      console.error("Error fetching trusted sources:", err);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  });

  // ADD trusted source (admin)
  router.post("/trusted", requireAdmin, async (req, res) => {
    try {
      const { name, domain, base_url } = req.body;

      if (!name || !domain || !base_url) {
        return res.status(400).json({
          success: false,
          message: "Missing required fields",
        });
      }

      // Clean domain input
      const cleanDomain = domain
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0]
        .toLowerCase();

      const result = await pool.query(
        `
        INSERT INTO trusted_sources (name, domain, base_url)
        VALUES ($1, $2, $3)
        RETURNING *
        `,
        [name, cleanDomain, base_url]
      );

      res.json({
        success: true,
        source: result.rows[0],
      });
    } catch (err) {
      console.error("Error adding trusted source:", err);

      if (err.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "Source already exists",
        });
      }

      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  });

  // TOGGLE source (enable/disable)
  router.patch("/trusted/:id/toggle", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;

      const result = await pool.query(
        `
        UPDATE trusted_sources
        SET enabled = NOT enabled
        WHERE id = $1
        RETURNING *
        `,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Source not found",
        });
      }

      res.json({
        success: true,
        source: result.rows[0],
      });
    } catch (err) {
      console.error("Error toggling source:", err);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  });

  // DELETE source
  router.delete("/trusted/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;

      await pool.query("DELETE FROM trusted_sources WHERE id = $1", [id]);

      res.json({
        success: true,
        message: "Source deleted",
      });
    } catch (err) {
      console.error("Error deleting source:", err);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  });

  // ===============================
  // BLACKLISTED DOMAINS
  // ===============================

  // GET blacklist (admin only)
  router.get("/blacklist", requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT * FROM blacklisted_domains ORDER BY created_at DESC"
      );

      res.json({
        success: true,
        domains: result.rows,
      });
    } catch (err) {
      console.error("Error fetching blacklist:", err);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  });

  // ADD blacklist domain
  router.post("/blacklist", requireAdmin, async (req, res) => {
    try {
      const { domain, reason } = req.body;

      if (!domain) {
        return res.status(400).json({
          success: false,
          message: "Domain is required",
        });
      }

      const cleanDomain = domain
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0]
        .toLowerCase();

      const result = await pool.query(
        `
        INSERT INTO blacklisted_domains (domain, reason)
        VALUES ($1, $2)
        RETURNING *
        `,
        [cleanDomain, reason || null]
      );

      res.json({
        success: true,
        domain: result.rows[0],
      });
    } catch (err) {
      console.error("Error adding blacklist:", err);

      if (err.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "Domain already blacklisted",
        });
      }

      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  });

  // DELETE blacklist domain
  router.delete("/blacklist/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;

      await pool.query(
        "DELETE FROM blacklisted_domains WHERE id = $1",
        [id]
      );

      res.json({
        success: true,
        message: "Blacklist removed",
      });
    } catch (err) {
      console.error("Error deleting blacklist:", err);
      res.status(500).json({
        success: false,
        message: "Server error",
      });
    }
  });

  return router;
};
