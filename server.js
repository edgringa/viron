const express = require("express");
const { Pool } = require("pg");
const axios = require("axios");
const cheerio = require("cheerio");

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
    version: "0.6.0"
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
      SELECT id, title, url, description
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
      query,
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
        url
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

/*
  Processa uma URL pendente.
*/
async function processNextUrl() {
  let client;

  try {
    client = await pool.connect();

    await client.query("BEGIN");

    const queueResult = await client.query(
      `
      SELECT id, url
      FROM crawl_queue
      WHERE status = 'pending'
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `
    );

    if (queueResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return;
    }

    const item = queueResult.rows[0];

    await client.query(
      `
      UPDATE crawl_queue
      SET status = 'processing'
      WHERE id = $1
      `,
      [item.id]
    );

    await client.query("COMMIT");

    console.log(`Crawling: ${item.url}`);

    const response = await axios.get(item.url, {
      timeout: 15000,
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        "User-Agent": "VironBot/0.1 (+https://viron.search)"
      }
    });

    const $ = cheerio.load(response.data);

    $("script, style, noscript").remove();

    const title =
      $("title").first().text().trim() ||
      item.url;

    const description =
      $('meta[name="description"]').attr("content")?.trim() ||
      "";

    const content =
      $("body").text()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 50000);

    const language =
      $("html").attr("lang")?.trim() || null;

    await pool.query(
      `
      INSERT INTO search_pages
      (title, url, description, content, language, country)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        title,
        item.url,
        description,
        content,
        language,
        null
      ]
    );

    await pool.query(
      `
      UPDATE crawl_queue
      SET status = 'completed'
      WHERE id = $1
      `,
      [item.id]
    );

    console.log(`Indexed successfully: ${item.url}`);

  } catch (error) {

    console.error("Crawler error:", error.message);

    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {}
    }

    try {
      await pool.query(
        `
        UPDATE crawl_queue
        SET status = 'error'
        WHERE status = 'processing'
        AND id = (
          SELECT id
          FROM crawl_queue
          WHERE status = 'processing'
          ORDER BY id ASC
          LIMIT 1
        )
        `
      );
    } catch (updateError) {
      console.error("Queue update error:", updateError.message);
    }
  } finally {
    if (client) {
      client.release();
    }
  }
}

/*
  Executa o crawler periodicamente.
*/
setInterval(processNextUrl, 10000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Viron API running on port ${PORT}`);
});
