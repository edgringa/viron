const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Viron API",
    version: "0.4.0"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok"
  });
});

app.get("/db-test", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW() AS now");

    res.json({
      ok: true,
      database: "connected",
      time: result.rows[0].now
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      database: "error"
    });
  }
});

app.get("/search", async (req, res) => {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      ok: false,
      error: "Query is required"
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        id,
        title,
        url,
        description
      FROM search_pages
      WHERE
        title ILIKE $1
        OR description ILIKE $1
        OR content ILIKE $1
      ORDER BY id DESC
      LIMIT 10
      `,
      [`%${query}%`]
    );

    res.json({
      ok: true,
      query: query,
      results: result.rows.map(row => ({
        title: row.title,
        url: row.url,
        description: row.description
      }))
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Search database error"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Viron API running on port ${PORT}`);
});
