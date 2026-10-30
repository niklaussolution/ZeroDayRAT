const { Pool } = require("pg");

/**
 * Render (and most managed Postgres hosts) provide a single DATABASE_URL
 * connection string rather than discrete host/port/user vars. Local dev
 * keeps using the discrete DB_* vars (see .env.example); production sets
 * DATABASE_URL instead. PGSSLMODE=disable lets local/Docker Postgres skip
 * SSL, while cloud connections default to requiring it.
 */
let dbUrl = process.env.DATABASE_URL;

// Auto-fix Render internal short hostnames (e.g. dpg-daueqb17lnhs73b3e9og-a -> dpg-daueqb17lnhs73b3e9og-a.oregon-postgres.render.com)
if (dbUrl && dbUrl.includes("@dpg-") && !dbUrl.includes(".render.com")) {
  dbUrl = dbUrl.replace(/@(dpg-[a-z0-9]+)([\/:\?])/i, "@$1.oregon-postgres.render.com$2");
}

const useConnectionString = Boolean(dbUrl);

const pool = useConnectionString
  ? new Pool({
      connectionString: dbUrl,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 15,
    })
  : new Pool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 15,
    });

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error", err);
});

module.exports = pool;
