// back/db.js
const mysql = require('mysql2/promise'); 

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',      
    password: 'Jd171204:', 
    database: 'elmarro_db', 
    waitForConnections: true,
    connectionLimit: 10, 
    queueLimit: 0
});

pool.getConnection()
    .then(connection => {
        console.log('✅ Conectado a MySQL');
        connection.release(); 
    })
    .catch(err => {
        console.error('❌ Error al conectar a MySQL:', err.message);
        console.error('Asegúrate de que el servidor MySQL esté corriendo y las credenciales sean correctas.');
        console.error(`También verifica que la base de datos 'elmarro_db' haya sido creada y el script SQL ejecutado.`);
        process.exit(1); 
    });

module.exports = pool; 