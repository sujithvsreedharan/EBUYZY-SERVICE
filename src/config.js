
const sql = require('mssql');

const config = {
    server: process.env.DB_SERVER,
    port: Number(process.env.DB_PORT || 1433),

    database: process.env.DB_NAME,

    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,

    options: {
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate:
            process.env.DB_TRUST_CERT === 'true'
    },

    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

let pool;

async function connection() {
    if (pool && pool.connected) {
        return pool;
    }

    pool = await sql.connect(config);

    console.log('Connected to db');

    return pool;
}

function getPool() {
    if (!pool || !pool.connected) {
        throw new Error('Database is not connected');
    }

    return pool;
}

const poolPromise = new sql.ConnectionPool(config)
    .connect()
    .then(pool => {
        console.log("Database connected successfully");
        return pool;
    })
    .catch(error => {
        console.error("Database connection failed:", error.message);
        throw error;
    });

module.exports = {
    sql,
    connection,
    getPool,
    poolPromise
};
