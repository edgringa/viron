const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ===============================
// VIRon API
// ===============================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Viron API",
    version: "0.9.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online"
  });
});

app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");

    res.json({
      ok: true,
      database: "connected",
      time: result.rows[0].now
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ===============================
// CRIAR TABELA DE ANÚNCIOS
// ===============================

async function createAdsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS viron_ads (
      id SERIAL PRIMARY KEY,
      campaign_name TEXT NOT NULL,
      advertiser_name TEXT NOT NULL,
      country VARCHAR(10) DEFAULT 'DE',
      language VARCHAR(10) DEFAULT 'de',
      keyword TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      final_url TEXT NOT NULL,
      cpc NUMERIC(10,2) DEFAULT 0.10,
      daily_budget NUMERIC(10,2) DEFAULT 5.00,
      spent NUMERIC(10,2) DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ===============================
// CRIAR CAMPANHA
// ===============================

app.post("/ads/campaigns", async (req, res) => {
  try {
    const {
      campaign_name,
      advertiser_name,
      country,
      language,
      keyword,
      title,
      description,
      final_url,
      cpc,
      daily_budget
    } = req.body;

    if (
      !campaign_name ||
      !advertiser_name ||
      !keyword ||
      !title ||
      !final_url
    ) {
      return res.status(400).json({
        ok: false,
        error: "Campos obrigatórios não preenchidos."
      });
    }

    const result = await pool.query(
      `
      INSERT INTO viron_ads
      (
        campaign_name,
        advertiser_name,
        country,
        language,
        keyword,
        title,
        description,
        final_url,
        cpc,
        daily_budget
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        campaign_name,
        advertiser_name,
        country || "DE",
        language || "de",
        keyword,
        title,
        description || "",
        final_url,
        Number(cpc) || 0.10,
        Number(daily_budget) || 5
      ]
    );

    res.json({
      ok: true,
      campaign: result.rows[0]
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ===============================
// LISTAR CAMPANHAS
// ===============================

app.get("/ads/campaigns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM viron_ads
      ORDER BY id DESC
    `);

    res.json({
      ok: true,
      campaigns: result.rows
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ===============================
// BUSCA
// ===============================

app.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.json({
        ok: true,
        query: "",
        ads: [],
        results: []
      });
    }

    // ===========================
    // ENCONTRAR ANÚNCIOS
    // ===========================

    const adsResult = await pool.query(
      `
      SELECT *
      FROM viron_ads
      WHERE status = 'active'
      AND LOWER(keyword) = LOWER($1)
      ORDER BY cpc DESC, id DESC
      LIMIT 3
      `,
      [q]
    );

    // ===========================
    // REGISTRAR IMPRESSÕES
    // ===========================

    if (adsResult.rows.length > 0) {
      const ids = adsResult.rows.map(ad => ad.id);

      await pool.query(
        `
        UPDATE viron_ads
        SET impressions = impressions + 1
        WHERE id = ANY($1::int[])
        `,
        [ids]
      );
    }

    // ===========================
    // RESULTADOS ORGÂNICOS
    // ===========================

    const searchResult = await pool.query(
      `
      SELECT
        id,
        title,
        url,
        description,
        CASE
          WHEN LOWER(title) = LOWER($1) THEN 100
          WHEN LOWER(title) LIKE LOWER($2) THEN 80
          WHEN LOWER(description) LIKE LOWER($2) THEN 50
          WHEN LOWER(content) LIKE LOWER($2) THEN 20
          ELSE 10
        END AS relevance
      FROM search_pages
      WHERE
        LOWER(title) LIKE LOWER($2)
        OR LOWER(description) LIKE LOWER($2)
        OR LOWER(content) LIKE LOWER($2)
      ORDER BY relevance DESC, id DESC
      LIMIT 10
      `,
      [q, `%${q}%`]
    );

    res.json({
      ok: true,
      query: q,

      ads: adsResult.rows.map(ad => ({
        id: ad.id,
        title: ad.title,
        description: ad.description,
        url: ad.final_url,
        advertiser: ad.advertiser_name
      })),

      results: searchResult.rows
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// ===============================
// CLIQUE NO ANÚNCIO
// ===============================

app.get("/ads/click/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    const result = await pool.query(
      `
      SELECT *
      FROM viron_ads
      WHERE id = $1
      AND status = 'active'
      LIMIT 1
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Anúncio não encontrado.");
    }

    const ad = result.rows[0];

    await pool.query(
      `
      UPDATE viron_ads
      SET clicks = clicks + 1,
          spent = spent + cpc
      WHERE id = $1
      `,
      [id]
    );

    res.redirect(ad.final_url);

  } catch (error) {
    console.error(error);

    res.status(500).send("Erro ao processar clique.");
  }
});

// ===============================
// INICIALIZAÇÃO
// ===============================

const PORT = process.env.PORT || 10000;

createAdsTable()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Viron API online na porta ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Erro ao iniciar banco:", error);
    process.exit(1);
  });
