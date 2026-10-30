const { Pool } = require("pg");

/**
 * Render (and most managed Postgres hosts) provide a single DATABASE_URL
 * connection string rather than discrete host/port/user vars. Local dev
 * keeps using the discrete DB_* vars (see .env.example); production sets
 * DATABASE_URL instead. PGSSLMODE=disable lets local/Docker Postgres skip
 * SSL, while cloud connections default to requiring it.
 */
const { Pool } = require("pg");

/**
 * Render (and most managed Postgres hosts) provide a single DATABASE_URL
 * connection string rather than discrete host/port/user vars. Local dev
 * keeps using the discrete DB_* vars (see .env.example); production sets
 * DATABASE_URL instead.
 *
 * NOTE FOR RENDER: Internal connections (host dpg-*) are private and DO NOT
 * use SSL. External connections (*.render.com) REQUIRE SSL.
 */
const dbUrl = process.env.DATABASE_URL;
const isInternalRender = Boolean(dbUrl && dbUrl.includes("@dpg-") && !dbUrl.includes(".render.com"));

const useConnectionString = Boolean(dbUrl);

const pool = useConnectionString
  ? new Pool({
      connectionString: dbUrl,
      ssl: isInternalRender
        ? false
        : (process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }),
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
