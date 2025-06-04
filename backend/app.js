// backend/app.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors'); // Para permitir peticiones desde el frontend

const { pool, connectDB } = require('./db'); // Importa la conexión a la BD

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors()); // Habilita CORS para permitir que tu frontend acceda a este backend
app.use(bodyParser.json()); // Para parsear el cuerpo de las solicitudes en formato JSON

// ** 1. Rutas de Autenticación **
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Usuario y contraseña son requeridos.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        // Buscar el usuario por su nombre de usuario
        // Usamos password_hash para la contraseña en texto plano (en este proyecto simplificado)
        const [rows] = await connection.execute(
            'SELECT id_usuario, nombre_usuario, password_hash AS stored_password, id_rol FROM Usuarios WHERE nombre_usuario = ?',
            [username]
        );

        if (rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        const user = rows[0];

        // ** COMPARACIÓN DE CONTRASEÑA EN TEXTO PLANO **
        // ¡ADVERTENCIA: NO USAR EN PRODUCCIÓN REAL!
        if (password !== user.stored_password) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        // Autenticación exitosa
        res.status(200).json({
            message: 'Inicio de sesión exitoso.',
            user: {
                id: user.id_usuario,
                username: user.nombre_usuario,
                role_id: user.id_rol
            }
        });

    } catch (error) {
        console.error('Error en el login:', error);
        res.status(500).json({ message: 'Error interno del servidor.' });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// ** 2. Rutas de Inventario y Resumen para Dashboard **
app.get('/api/inventory/summary', async (req, res) => {
    console.log('=== Iniciando consulta de summary ===');
    let connection;
    try {
        connection = await pool.getConnection();
        console.log('✓ Conexión obtenida');

        // Consulta 1: Total productos
        console.log('Consultando total de productos...');
        const [totalProductsRows] = await connection.execute(
            'SELECT COUNT(*) AS total_productos FROM Productos'
        );
        const totalProducts = totalProductsRows[0].total_productos;
        console.log('✓ Total productos:', totalProducts);

        // Consulta 2: Ventas del día
        console.log('Consultando ventas del día...');
        const today = new Date().toISOString().slice(0, 10);
        console.log('Fecha de hoy:', today);
        const [dailySalesRows] = await connection.execute(
            'SELECT SUM(total_venta) AS ventas_del_dia FROM Ventas WHERE DATE(fecha_venta) = ?',
            [today]
        );
        const dailySales = dailySalesRows[0].ventas_del_dia || 0;
        console.log('✓ Ventas del día:', dailySales);

        // Consulta 3: Stock bajo
        console.log('Consultando stock bajo...');
        const [lowStockProductRows] = await connection.execute(
            `SELECT p.nombre_producto, i.cantidad AS cantidad_disponible
             FROM Inventario i
             JOIN Productos p ON i.id_producto = p.id_producto
             ORDER BY i.cantidad ASC
             LIMIT 1`
        );
        const lowStockProduct = lowStockProductRows.length > 0 ? lowStockProductRows[0] : null;
        console.log('✓ Producto stock bajo:', lowStockProduct);

        // Consulta 4: Última venta
        console.log('Consultando última venta...');
        const [lastSaleRows] = await connection.execute(
            `SELECT p.nombre_producto, dv.precio_unitario, dv.cantidad, v.total_venta
             FROM Ventas v
             JOIN DetalleVenta dv ON v.id_venta = dv.id_venta
             JOIN Productos p ON dv.id_producto = p.id_producto
             ORDER BY v.fecha_venta DESC, v.id_venta DESC
             LIMIT 1`
        );
        const lastSale = lastSaleRows.length > 0 ? lastSaleRows[0] : null;
        console.log('✓ Última venta:', lastSale);

        console.log('=== Enviando respuesta ===');
        res.status(200).json({
            totalProducts: totalProducts,
            dailySales: dailySales,
            lowStockProduct: lowStockProduct,
            lastSale: lastSale
        });

    } catch (error) {
        console.error('❌ Error en summary:', error);
        res.status(500).json({ message: 'Error interno del servidor al obtener datos.' });
    } finally {
        if (connection) {
            connection.release();
            console.log('✓ Conexión liberada');
        }
    }
});

// Iniciar el servidor
// Iniciar el servidor
async function startServer() {
    try {
        await connectDB(); // Intentar conectar a la base de datos
        app.listen(PORT, '127.0.0.1', () => { // ¡CAMBIADO AQUÍ! Añadimos '0.0.0.0'
            console.log(`Servidor de Hotdogs el Marro escuchando en http://localhost:${PORT} (accesible desde 127.0.0.1)`);
        });
    } catch (error) {
        console.error('No se pudo iniciar el servidor debido a un error de conexión a la BD:', error);
        process.exit(1);
    }
}

startServer();