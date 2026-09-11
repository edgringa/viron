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

// ==========================================
// VIRon API 1.0
// ==========================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Viron API",
    version: "1.0.0"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    version: "1.0.0"
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

// ==========================================
// TABELA DE ANÚNCIOS
// ==========================================

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

// ==========================================
// CRIAR CAMPANHA
// ==========================================

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

    const parsedCpc = Number(cpc);
    const parsedBudget = Number(daily_budget);

    if (
      !Number.isFinite(parsedCpc) ||
      parsedCpc <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "CPC inválido."
      });
    }

    if (
      !Number.isFinite(parsedBudget) ||
      parsedBudget <= 0
    ) {
      return res.status(400).json({
        ok: false,
        error: "Orçamento diário inválido."
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
        campaign_name.trim(),
        advertiser_name.trim(),
        country || "DE",
        language || "de",
        keyword.trim(),
        title.trim(),
        description || "",
        final_url.trim(),
        parsedCpc,
        parsedBudget
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

// ==========================================
// LISTAR CAMPANHAS
// ==========================================

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

// ==========================================
// BUSCA + LEILÃO
// ==========================================

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

    /*
    ==========================================
    RESET DO CICLO DIÁRIO
    ==========================================

    Para o MVP usamos o gasto acumulado.
    O controle diário completo será refinado
    em uma próxima versão com tabela de ciclos.
    ==========================================
    */

    const adsResult = await pool.query(
      `
      SELECT *
      FROM viron_ads
      WHERE status = 'active'
      AND LOWER(keyword) = LOWER($1)
      AND spent + cpc <= daily_budget
      ORDER BY cpc DESC, id DESC
      LIMIT 3
      `,
      [q]
    );

    /*
    ==========================================
    IMPRESSÕES
    ==========================================
    */

    if (adsResult.rows.length > 0) {

      const ids = adsResult.rows.map(
        ad => ad.id
      );

      await pool.query(
        `
        UPDATE viron_ads
        SET impressions = impressions + 1
        WHERE id = ANY($1::int[])
        `,
        [ids]
      );
    }

    /*
    ==========================================
    RESULTADOS ORGÂNICOS
    ==========================================
    */

    const searchResult = await pool.query(
      `
      SELECT
        id,
        title,
        url,
        description,

        CASE

          WHEN LOWER(title) = LOWER($1)
          THEN 100

          WHEN LOWER(title)
          LIKE LOWER($2)
          THEN 80

          WHEN LOWER(description)
          LIKE LOWER($2)
          THEN 50

          WHEN LOWER(content)
          LIKE LOWER($2)
          THEN 20

          ELSE 10

        END AS relevance

      FROM search_pages

      WHERE
        LOWER(title)
        LIKE LOWER($2)

        OR LOWER(description)
        LIKE LOWER($2)

        OR LOWER(content)
        LIKE LOWER($2)

      ORDER BY
        relevance DESC,
        id DESC

      LIMIT 10
      `,
      [
        q,
        `%${q}%`
      ]
    );

    res.json({
      ok: true,
      query: q,

      ads: adsResult.rows.map(ad => ({
        id: ad.id,
        title: ad.title,
        description: ad.description,
        final_url: ad.final_url,
        advertiser: ad.advertiser_name,
        cpc: Number(ad.cpc)
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

// ==========================================
// CLICK ID
// ==========================================

function generateClickId(adId) {

  const timestamp =
    Date.now().toString(36);

  const random =
    Math.random()
      .toString(36)
      .substring(2, 10);

  return `v_${adId}_${timestamp}_${random}`;
}

// ==========================================
// CLIQUE NO ANÚNCIO
// ==========================================

app.get("/ads/click/:id", async (req, res) => {

  try {

    const id =
      Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).send(
        "ID de anúncio inválido."
      );
    }

    /*
    ==========================================
    BUSCAR ANÚNCIO
    ==========================================
    */

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

      return res.status(404).send(
        "Anúncio não encontrado."
      );
    }

    const ad =
      result.rows[0];

    /*
    ==========================================
    PROTEÇÃO DE ORÇAMENTO
    ==========================================
    */

    const spent =
      Number(ad.spent || 0);

    const cpc =
      Number(ad.cpc || 0);

    const budget =
      Number(ad.daily_budget || 0);

    if (
      spent + cpc > budget
    ) {

      return res.status(403).send(
        "Orçamento da campanha atingido."
      );
    }

    /*
    ==========================================
    GERAR CLICK ID
    ==========================================
    */

    const clickId =
      generateClickId(id);

    /*
    ==========================================
    REGISTRAR CLIQUE E CUSTO
    ==========================================
    */

    await pool.query(
      `
      UPDATE viron_ads
      SET
        clicks = clicks + 1,
        spent = spent + cpc
      WHERE
        id = $1
        AND status = 'active'
        AND spent + cpc <= daily_budget
      `,
      [id]
    );

    /*
    ==========================================
    DESTINO
    ==========================================
    */

    const separator =
      ad.final_url.includes("?")
      ? "&"
      : "?";

    const destination =
      `${ad.final_url}${separator}viron_click_id=${encodeURIComponent(clickId)}`;

    res.redirect(destination);

  } catch (error) {

    console.error(error);

    res.status(500).send(
      "Erro ao processar clique."
    );
  }

});

// ==========================================
// CONVERSÃO
// ==========================================

app.get("/ads/conversion", async (req, res) => {

  try {

    const clickId =
      String(
        req.query.viron_click_id || ""
      ).trim();

    if (!clickId) {

      return res.status(400).json({
        ok: false,
        error: "Click ID não informado."
      });
    }

    /*
    ==========================================
    MVP

    Nesta versão registramos a conversão
    recebida, mas ainda não atribuímos
    receita ao anunciante.
    ==========================================
    */

    console.log(
      "Conversão Viron recebida:",
      clickId
    );

    res.json({
      ok: true,
      conversion: true,
      click_id: clickId
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }

});

// ==========================================
// INICIALIZAÇÃO
// ==========================================

const PORT =
  process.env.PORT || 10000;

createAdsTable()

  .then(() => {

    app.listen(
      PORT,
      () => {

        console.log(
          `Viron API 1.0 online na porta ${PORT}`
        );

      }
    );

  })

  .catch(error => {

    console.error(
      "Erro ao iniciar banco:",
      error
    );

    process.exit(1);

  });
