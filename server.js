const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Viron API",
    version: "0.1.0"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Viron API running on port ${PORT}`);
});
