const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
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

// =====================================
// VIRon API 1.1.0
// =====================================

const API_VERSION = "1.1.0";

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Viron API",
    version: API_VERSION
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    version: API_VERSION
  });
});

// =====================================
// DATABASE TEST
// =====================================

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

// =====================================
// DATABASE SETUP
// =====================================

async function setupDatabase() {

  // -----------------------------------
  // USERS
  // -----------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS viron_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // -----------------------------------
  // SESSIONS
  // -----------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS viron_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES viron_users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // -----------------------------------
  // WALLETS
  // -----------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS viron_wallets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER UNIQUE NOT NULL REFERENCES viron_users(id) ON DELETE CASCADE,
      balance NUMERIC(12,2) DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'EUR',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // -----------------------------------
  // ADS
  // -----------------------------------

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
      spent NUMERIC(12,2) DEFAULT 0,
      spent_today NUMERIC(12,2) DEFAULT 0,
      budget_date DATE DEFAULT CURRENT_DATE,
      clicks INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      status VARCHAR(20) DEFAULT 'active',
      owner_id INTEGER REFERENCES viron_users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // -----------------------------------
  // MIGRATION FOR OLD DATABASE
  // -----------------------------------

  await pool.query(`
    ALTER TABLE viron_ads
    ADD COLUMN IF NOT EXISTS owner_id INTEGER REFERENCES viron_users(id)
  `);

  await pool.query(`
    ALTER TABLE viron_ads
    ADD COLUMN IF NOT EXISTS spent_today NUMERIC(12,2) DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE viron_ads
    ADD COLUMN IF NOT EXISTS budget_date DATE DEFAULT CURRENT_DATE
  `);

  // -----------------------------------
  // CLICKS
  // -----------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS viron_clicks (
      id SERIAL PRIMARY KEY,
      ad_id INTEGER NOT NULL REFERENCES viron_ads(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES viron_users(id),
      click_id TEXT UNIQUE NOT NULL,
      cpc NUMERIC(10,2) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // -----------------------------------
  // CONVERSIONS
  // -----------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS viron_conversions (
      id SERIAL PRIMARY KEY,
      click_id TEXT NOT NULL,
      ad_id INTEGER REFERENCES viron_ads(id) ON DELETE SET NULL,
      value NUMERIC(12,2) DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'EUR',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// =====================================
// PASSWORD FUNCTIONS
// =====================================

function hashPassword(password) {

  const salt = crypto.randomBytes(16).toString("hex");

  const hash = crypto.scryptSync(
    password,
    salt,
    64
  ).toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {

  const parts = stored.split(":");

  if (parts.length !== 2) {
    return false;
  }

  const salt = parts[0];
  const originalHash = parts[1];

  const hash = crypto.scryptSync(
    password,
    salt,
    64
  ).toString("hex");

  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(originalHash, "hex")
  );
}

// =====================================
// AUTH MIDDLEWARE
// =====================================

async function auth(req, res, next) {

  try {

    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        ok: false,
        error: "Autenticação necessária."
      });
    }

    const token = header.replace("Bearer ", "").trim();

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Token inválido."
      });
    }

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.email
      FROM viron_sessions s
      JOIN viron_users u
        ON u.id = s.user_id
      WHERE s.token = $1
      LIMIT 1
      `,
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        ok: false,
        error: "Sessão inválida."
      });
    }

    req.user = result.rows[0];

    next();

  } catch (error) {

    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Erro de autenticação."
    });
  }
}

// =====================================
// CREATE ACCOUNT
// =====================================

app.post("/auth/register", async (req, res) => {

  try {

    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        ok: false,
        error: "Email e senha são obrigatórios."
      });
    }

    if (!email.includes("@")) {
      return res.status(400).json({
        ok: false,
        error: "Email inválido."
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        ok: false,
        error: "A senha deve ter pelo menos 8 caracteres."
      });
    }

    const passwordHash = hashPassword(password);

    const result = await pool.query(
      `
      INSERT INTO viron_users
      (email, password_hash)
      VALUES ($1,$2)
      RETURNING id,email,created_at
      `,
      [email, passwordHash]
    );

    const user = result.rows[0];

    await pool.query(
      `
      INSERT INTO viron_wallets
      (user_id,balance,currency)
      VALUES ($1,0,'EUR')
      `,
      [user.id]
    );

    res.json({
      ok: true,
      user
    });

  } catch (error) {

    if (error.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "Este email já está cadastrado."
      });
    }

    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Erro ao criar conta."
    });
  }
});

// =====================================
// LOGIN
// =====================================

app.post("/auth/login", async (req, res) => {

  try {

    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    const result = await pool.query(
      `
      SELECT *
      FROM viron_users
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        ok: false,
        error: "Email ou senha inválidos."
      });
    }

    const user = result.rows[0];

    const valid = verifyPassword(
      password,
      user.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        ok: false,
        error: "Email ou senha inválidos."
      });
    }

    const token = crypto
      .randomBytes(32)
      .toString("hex");

    await pool.query(
      `
      INSERT INTO viron_sessions
      (user_id,token)
      VALUES ($1,$2)
      `,
      [user.id, token]
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email
      }
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Erro ao fazer login."
    });
  }
});

// =====================================
// CURRENT USER
// =====================================

app.get("/auth/me", auth, async (req, res) => {

  res.json({
    ok: true,
    user: req.user
  });
});

// =====================================
// WALLET
// =====================================

app.get("/wallet", auth, async (req, res) => {

  try {

    const result = await pool.query(
      `
      SELECT
        balance,
        currency,
        updated_at
      FROM viron_wallets
      WHERE user_id = $1
      LIMIT 1
      `,
      [req.user.id]
    );

    if (result.rows.length === 0) {

      await pool.query(
        `
        INSERT INTO viron_wallets
        (user_id,balance,currency)
        VALUES ($1,0,'EUR')
        `,
        [req.user.id]
      );

      return res.json({
        ok: true,
        balance: 0,
        currency: "EUR"
      });
    }

    res.json({
      ok: true,
      wallet: result.rows[0]
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Erro ao consultar carteira."
    });
  }
});

// =====================================
// CREATE CAMPAIGN
// =====================================

app.post("/ads/campaigns", auth, async (req, res) => {

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

    const cpcValue = Number(cpc);
    const budgetValue = Number(daily_budget);

    if (!Number.isFinite(cpcValue) || cpcValue <= 0) {
      return res.status(400).json({
        ok: false,
        error: "CPC inválido."
      });
    }

    if (!Number.isFinite(budgetValue) || budgetValue <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Orçamento diário inválido."
      });
    }

    if (cpcValue > budgetValue) {
      return res.status(400).json({
        ok: false,
        error: "O CPC não pode ser maior que o orçamento diário."
      });
    }

    if (
      !final_url.startsWith("https://") &&
      !final_url.startsWith("http://")
    ) {
      return res.status(400).json({
        ok: false,
        error: "A URL final deve começar com http:// ou https://."
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
        daily_budget,
        owner_id
      )
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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
        cpcValue,
        budgetValue,
        req.user.id
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

// =====================================
// LIST MY CAMPAIGNS
// =====================================

app.get("/ads/campaigns", auth, async (req, res) => {

  try {

    const result = await pool.query(
      `
      SELECT *
      FROM viron_ads
      WHERE owner_id = $1
      ORDER BY id DESC
      `,
      [req.user.id]
    );

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

// =====================================
// SEARCH
// =====================================

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

    const adsResult = await pool.query(
      `
      SELECT
        id,
        title,
        description,
        final_url,
        advertiser_name
      FROM viron_ads
      WHERE status = 'active'
      AND owner_id IS NOT NULL
      AND LOWER(keyword) = LOWER($1)
      ORDER BY cpc DESC, id DESC
      LIMIT 3
      `,
      [q]
    );

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

    let searchResult = {
      rows: []
    };

    try {

      searchResult = await pool.query(
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

    } catch (searchError) {

      console.log(
        "Busca orgânica indisponível:",
        searchError.message
      );

    }

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

// =====================================
// AD CLICK
// =====================================

app.get("/ads/click/:id", async (req, res) => {

  const client = await pool.connect();

  try {

    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).send(
        "ID de anúncio inválido."
      );
    }

    await client.query("BEGIN");

    const adResult = await client.query(
      `
      SELECT *
      FROM viron_ads
      WHERE id = $1
      AND status = 'active'
      LIMIT 1
      `,
      [id]
    );

    if (adResult.rows.length === 0) {

      await client.query("ROLLBACK");

      return res.status(404).send(
        "Anúncio não encontrado."
      );
    }

    const ad = adResult.rows[0];

    if (!ad.owner_id) {

      await client.query("ROLLBACK");

      return res.status(403).send(
        "Anúncio não configurado para cobrança."
      );
    }

    // -----------------------------------
    // RESET DAILY BUDGET
    // -----------------------------------

    await client.query(
      `
      UPDATE viron_ads
      SET
        spent_today =
          CASE
            WHEN budget_date <> CURRENT_DATE
            THEN 0
            ELSE spent_today
          END,
        budget_date = CURRENT_DATE
      WHERE id = $1
      `,
      [id]
    );

    // -----------------------------------
    // ATOMIC BUDGET CHECK
    // -----------------------------------

    const budgetResult = await client.query(
      `
      UPDATE viron_ads
      SET
        clicks = clicks + 1,
        spent = spent + cpc,
        spent_today = spent_today + cpc
      WHERE id = $1
      AND status = 'active'
      AND spent_today + cpc <= daily_budget
      RETURNING *
      `,
      [id]
    );

    if (budgetResult.rows.length === 0) {

      await client.query("ROLLBACK");

      return res.status(429).send(
        "Orçamento diário do anúncio atingido."
      );
    }

    // -----------------------------------
    // WALLET CHARGE
    // -----------------------------------

    const walletResult = await client.query(
      `
      UPDATE viron_wallets
      SET
        balance = balance - $1,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2
      AND balance >= $1
      RETURNING balance
      `,
      [
        Number(ad.cpc),
        ad.owner_id
      ]
    );

    if (walletResult.rows.length === 0) {

      await client.query("ROLLBACK");

      return res.status(402).send(
        "Saldo insuficiente."
      );
    }

    // -----------------------------------
    // CLICK ID
    // -----------------------------------

    const clickId =
      "vc_" +
      crypto.randomBytes(16).toString("hex");

    await client.query(
      `
      INSERT INTO viron_clicks
      (
        ad_id,
        user_id,
        click_id,
        cpc
      )
      VALUES
      ($1,$2,$3,$4)
      `,
      [
        ad.id,
        ad.owner_id,
        clickId,
        ad.cpc
      ]
    );

    await client.query("COMMIT");

    // -----------------------------------
    // REDIRECT
    // -----------------------------------

    const separator =
      ad.final_url.includes("?")
        ? "&"
        : "?";

    const destination =
      `${ad.final_url}${separator}viron_click_id=${encodeURIComponent(clickId)}`;

    res.redirect(destination);

  } catch (error) {

    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error(error);

    res.status(500).send(
      "Erro ao processar clique."
    );

  } finally {

    client.release();
  }
});

// =====================================
// CONVERSION
// =====================================

app.post("/ads/conversion", async (req, res) => {

  try {

    const {
      click_id,
      value,
      currency
    } = req.body;

    if (!click_id) {

      return res.status(400).json({
        ok: false,
        error: "click_id obrigatório."
      });
    }

    const clickResult = await pool.query(
      `
      SELECT
        ad_id
      FROM viron_clicks
      WHERE click_id = $1
      LIMIT 1
      `,
      [click_id]
    );

    if (clickResult.rows.length === 0) {

      return res.status(404).json({
        ok: false,
        error: "Click ID não encontrado."
      });
    }

    const adId =
      clickResult.rows[0].ad_id;

    const result = await pool.query(
      `
      INSERT INTO viron_conversions
      (
        click_id,
        ad_id,
        value,
        currency
      )
      VALUES
      ($1,$2,$3,$4)
      RETURNING *
      `,
      [
        click_id,
        adId,
        Number(value) || 0,
        currency || "EUR"
      ]
    );

    res.json({
      ok: true,
      conversion: result.rows[0]
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// =====================================
// START
// =====================================

const PORT = process.env.PORT || 10000;

setupDatabase()
  .then(() => {

    app.listen(PORT, () => {

      console.log(
        `Viron API ${API_VERSION} online na porta ${PORT}`
      );

    });

  })
  .catch(error => {

    console.error(
      "Erro ao iniciar banco:",
      error
    );

    process.exit(1);
  });
