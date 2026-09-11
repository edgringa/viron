const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    version: "0.5.0"
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

/*
  Adiciona uma URL à fila do Viron Crawler
*/
app.post("/crawl", async (req, res) => {
  const url = String(req.body.url || "").trim();

  if (!url) {
    return res.status(400).json({
      ok: false,
      error: "URL is required"
    });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({
      ok: false,
      error: "Invalid URL"
    });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO crawl_queue (url, status)
      VALUES ($1, 'pending')
      ON CONFLICT (url)
      DO NOTHING
      RETURNING id, url, status
      `,
      [url]
    );

    if (result.rows.length === 0) {
      return res.json({
        ok: true,
        message: "URL already in crawl queue",
        url: url
      });
    }

    res.json({
      ok: true,
      message: "URL added to crawl queue",
      item: result.rows[0]
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Crawl queue database error"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Viron API running on port ${PORT}`);
});
