// backend/bd.js
require('dotenv').config();

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

async function connectDB() {
    try {
        const connection = await pool.getConnection();
        console.log('Conexión a la base de datos exitosa.');
        connection.release();
    } catch (error) {
        console.error('Error al conectar a la base de datos:', error);
        throw error;
    }
}

module.exports = {
    pool,
    connectDB
};