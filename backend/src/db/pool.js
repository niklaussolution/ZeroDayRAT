const { Pool } = require("pg");

/**
 * Render (and most managed Postgres hosts) provide a single DATABASE_URL
 * connection string rather than discrete host/port/user vars. Local dev
 * keeps using the discrete DB_* vars (see .env.example); production sets
 * DATABASE_URL instead. PGSSLMODE=disable lets local/Docker Postgres skip
 * SSL, while cloud connections default to requiring it.
 */
const useConnectionString = Boolean(process.env.DATABASE_URL);

const pool = useConnectionString
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
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
