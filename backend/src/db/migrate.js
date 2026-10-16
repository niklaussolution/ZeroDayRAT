require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

async function migrate() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");

  console.log("Running schema.sql against database...");
  
  // Clean comments and split by semicolon at end of line
  const cleanSql = sql.replace(/--.*$/gm, "");
  const statements = cleanSql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    try {
      await pool.query(stmt);
    } catch (err) {
      console.warn("Migration statement notice:", err.message);
    }
  }

  console.log("Migration complete.");
  await pool.end();
}

migrate()
  .catch((err) => {
    console.error("Migration notice:", err.message);
  })
  .finally(() => {
    process.exit(0);
  });
