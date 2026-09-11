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
    version: "0.8.0"
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


/*
  VIRÓN SEARCH
*/
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
        description,

        (
          CASE
            WHEN title ILIKE $1 THEN 100
            WHEN title ILIKE $2 THEN 80
            ELSE 0
          END
          +
          CASE
            WHEN description ILIKE $1 THEN 50
            WHEN description ILIKE $2 THEN 30
            ELSE 0
          END
          +
          CASE
            WHEN content ILIKE $1 THEN 20
            WHEN content ILIKE $2 THEN 10
            ELSE 0
          END
        ) AS relevance

      FROM search_pages

      WHERE
        title ILIKE $2
        OR description ILIKE $2
        OR content ILIKE $2

      ORDER BY relevance DESC, id DESC

      LIMIT 10
      `,
      [
        query,
        `%${query}%`
      ]
    );

    res.json({
      ok: true,
      query,
      results: result.rows.map(row => ({
        title: row.title,
        url: row.url,
        description: row.description,
        relevance: Number(row.relevance)
      }))
    });

  } catch (error) {
    console.error("Search error:", error);

    res.status(500).json({
      ok: false,
      error: "Search database error"
    });
  }
});


/*
  ADICIONA UMA URL À FILA
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
    const parsedUrl = new URL(url);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        ok: false,
        error: "Only HTTP and HTTPS URLs are allowed"
      });
    }

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
  DESCOBRE SITEMAPS E IMPORTA URLs
*/
app.post("/discover", async (req, res) => {
  const inputUrl = String(req.body.url || "").trim();

  if (!inputUrl) {
    return res.status(400).json({
      ok: false,
      error: "URL is required"
    });
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(inputUrl);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return res.status(400).json({
        ok: false,
        error: "Only HTTP and HTTPS URLs are allowed"
      });
    }

  } catch {
    return res.status(400).json({
      ok: false,
      error: "Invalid URL"
    });
  }

  const origin = parsedUrl.origin;

  try {
    /*
      Primeiro tenta descobrir o sitemap pelo robots.txt.
    */
    const robotsUrl = `${origin}/robots.txt`;

    let robotsText = "";

    try {
      const robotsResponse = await axios.get(robotsUrl, {
        timeout: 10000,
        maxContentLength: 1024 * 1024,
        headers: {
          "User-Agent": "VironBot/0.1 (+https://viron.search)"
        }
      });

      robotsText = String(robotsResponse.data || "");
    } catch {
      robotsText = "";
    }

    /*
      Procura linhas Sitemap: no robots.txt
    */
    const sitemapUrls = [];

    for (const line of robotsText.split(/\r?\n/)) {
      if (line.toLowerCase().startsWith("sitemap:")) {
        const sitemap = line.substring(8).trim();

        try {
          const sitemapUrl = new URL(sitemap, origin);

          if (
            ["http:", "https:"].includes(
              sitemapUrl.protocol
            )
          ) {
            sitemapUrls.push(sitemapUrl.href);
          }

        } catch {}
      }
    }

    /*
      Se não encontrou no robots.txt,
      tenta os caminhos comuns.
    */
    if (sitemapUrls.length === 0) {
      sitemapUrls.push(
        `${origin}/sitemap.xml`,
        `${origin}/sitemap_index.xml`
      );
    }

    /*
      Remove duplicadas.
    */
    const uniqueSitemaps = [
      ...new Set(sitemapUrls)
    ];

    const discoveredUrls = new Set();

    /*
      Lê sitemap ou sitemap index.
    */
    async function readSitemap(sitemapUrl, depth = 0) {
      if (depth > 2) {
        return;
      }

      try {
        const response = await axios.get(
          sitemapUrl,
          {
            timeout: 15000,
            maxContentLength: 5 * 1024 * 1024,
            headers: {
              "User-Agent":
                "VironBot/0.1 (+https://viron.search)"
            }
          }
        );

        const xml = String(response.data || "");

        const $ = cheerio.load(
          xml,
          {
            xmlMode: true
          }
        );

        /*
          Sitemap index
        */
        $("sitemap loc").each((_i, element) => {
          const childSitemap =
            $(element).text().trim();

          if (childSitemap) {
            readSitemap(
              childSitemap,
              depth + 1
            );
          }
        });

        /*
          URLs normais
        */
        $("url loc").each((_i, element) => {
          const pageUrl =
            $(element).text().trim();

          if (!pageUrl) {
            return;
          }

          try {
            const parsed = new URL(
              pageUrl,
              origin
            );

            if (
              ["http:", "https:"].includes(
                parsed.protocol
              )
            ) {
              discoveredUrls.add(
                parsed.href
              );
            }

          } catch {}
        });

      } catch (error) {
        console.error(
          `Sitemap error: ${sitemapUrl}`,
          error.message
        );
      }
    }

    /*
      Processa os sitemaps encontrados.
    */
    for (const sitemapUrl of uniqueSitemaps) {
      await readSitemap(sitemapUrl);
    }

    /*
      Limite inicial para manter o projeto
      dentro dos recursos gratuitos.
    */
    const urlsToQueue = [
      ...discoveredUrls
    ].slice(0, 500);

    let added = 0;
    let existing = 0;

    /*
      Coloca as URLs na fila.
    */
    for (const url of urlsToQueue) {
      const result = await pool.query(
        `
        INSERT INTO crawl_queue
        (url, status)
        VALUES ($1, 'pending')
        ON CONFLICT (url)
        DO NOTHING
        RETURNING id
        `,
        [url]
      );

      if (result.rows.length > 0) {
        added++;
      } else {
        existing++;
      }
    }

    res.json({
      ok: true,
      domain: origin,
      sitemaps_found: uniqueSitemaps,
      urls_discovered: discoveredUrls.size,
      urls_added: added,
      urls_already_in_queue: existing,
      limit: 500
    });

  } catch (error) {
    console.error(
      "Discovery error:",
      error
    );

    res.status(500).json({
      ok: false,
      error: "Discovery error"
    });
  }
});


/*
  PROCESSA UMA URL PENDENTE
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

    console.log(
      `Crawling: ${item.url}`
    );

    const response = await axios.get(
      item.url,
      {
        timeout: 15000,
        maxContentLength: 5 * 1024 * 1024,
        headers: {
          "User-Agent":
            "VironBot/0.1 (+https://viron.search)"
        }
      }
    );

    const $ = cheerio.load(
      response.data
    );

    $("script, style, noscript").remove();

    const title =
      $("title")
        .first()
        .text()
        .trim() ||
      item.url;

    const description =
      $('meta[name="description"]')
        .attr("content")
        ?.trim() ||
      "";

    const content =
      $("body")
        .text()
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 50000);

    const language =
      $("html")
        .attr("lang")
        ?.trim() ||
      null;

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

    console.log(
      `Indexed successfully: ${item.url}`
    );

  } catch (error) {

    console.error(
      "Crawler error:",
      error.message
    );

    if (client) {
      try {
        await client.query(
          "ROLLBACK"
        );
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
      console.error(
        "Queue update error:",
        updateError.message
      );
    }

  } finally {

    if (client) {
      client.release();
    }

  }
}


/*
  EXECUTA O CRAWLER PERIODICAMENTE
*/
setInterval(
  processNextUrl,
  10000
);


/*
  INICIA A API
*/
app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Viron API running on port ${PORT}`
    );
  }
);
