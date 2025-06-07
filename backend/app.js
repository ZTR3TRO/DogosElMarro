// back/app.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const pool = require('./db'); // Importa directamente el pool de conexiones desde db.js

const app = express();
const PORT = 3000;

// Middleware
app.use(cors()); // Habilita CORS para permitir peticiones desde el frontend
app.use(bodyParser.json()); // Para parsear el cuerpo de las peticiones como JSON
// Sirve archivos estáticos del frontend desde la carpeta 'frontend' que está un nivel arriba.
app.use(express.static(path.join(__dirname, '../frontend')));

// --- Rutas de la API ---

// 1. Ruta de Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Usuario y contraseña son requeridos.' });
    }

    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);

        if (rows.length > 0) {
            const user = rows[0];
            res.status(200).json({ message: 'Inicio de sesión exitoso.', user: { username: user.username, role: user.role, id: user.id } }); // También enviamos el ID del usuario
        } else {
            res.status(401).json({ message: 'Credenciales inválidas.' });
        }
    } catch (err) {
        console.error('Error en la base de datos durante el login:', err.message);
        res.status(500).json({ message: 'Error interno del servidor.' });
    }
});

// 2. Ruta para el Resumen del Dashboard
app.get('/api/inventory/summary', async (req, res) => {
    const summary = {
        totalProducts: 0,
        dailySales: 0,
        lowStockProduct: null,
        lastSale: null,
        productsExpiringSoon: []
    };

    try {
        const [totalProductsResult] = await pool.query('SELECT COUNT(*) AS count FROM products');
        summary.totalProducts = totalProductsResult[0].count;

        const today = new Date().toISOString().split('T')[0];
        const [dailySalesResult] = await pool.query(`
            SELECT SUM(cantidad * precio_unitario) AS total FROM sales WHERE DATE(fecha_venta) = ?
        `, [today]);
        summary.dailySales = dailySalesResult[0].total || 0;

        const [lowStockResult] = await pool.query(`
            SELECT id, nombre_producto, cantidad_disponible, stock_minimo
            FROM products WHERE cantidad_disponible <= stock_minimo AND cantidad_disponible > 0 ORDER BY cantidad_disponible ASC LIMIT 1
        `);
        summary.lowStockProduct = lowStockResult.length > 0 ? lowStockResult[0] : null;

        const [lastSaleResult] = await pool.query(`
            SELECT s.cantidad, s.precio_unitario, p.nombre_producto, s.fecha_venta, u.username as cajero
            FROM sales s
            JOIN products p ON s.producto_id = p.id
            JOIN users u ON s.user_id = u.id
            ORDER BY s.fecha_venta DESC LIMIT 1
        `);
        summary.lastSale = lastSaleResult.length > 0 ? lastSaleResult[0] : null;

        const [expiringProducts] = await pool.query(`
            SELECT id, nombre_producto, cantidad_disponible, fecha_caducidad
            FROM products
            WHERE fecha_caducidad IS NOT NULL AND fecha_caducidad <= CURDATE() + INTERVAL 7 DAY AND cantidad_disponible > 0
            ORDER BY fecha_caducidad ASC LIMIT 5
        `);
        summary.productsExpiringSoon = expiringProducts;

        res.json(summary);
    } catch (err) {
        console.error('Error al obtener el resumen del dashboard:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener el resumen.' });
    }
});

// 3. Rutas de Inventario (CRUD para productos)

// Obtener todos los productos CON FILTROS Y CATEGORÍA
app.get('/api/inventory', async (req, res) => {
    const searchTerm = req.query.search || '';
    const categoryName = req.query.category || ''; // Nombre de la categoría
    const status = req.query.status || ''; // Para filtros de stock

    let sql = `
        SELECT p.*, c.nombre_categoria as category_name
        FROM products p
        JOIN categories c ON p.categoria_id = c.id
    `;
    let params = [];
    const conditions = [];

    if (searchTerm) {
        conditions.push('p.nombre_producto LIKE ?');
        params.push(`%${searchTerm}%`);
    }
    if (categoryName) {
        conditions.push('c.nombre_categoria = ?');
        params.push(categoryName);
    }

    if (status === 'low_stock') {
        conditions.push('p.cantidad_disponible <= p.stock_minimo AND p.cantidad_disponible > 0');
    } else if (status === 'expiring_soon') {
        conditions.push('p.fecha_caducidad IS NOT NULL AND p.fecha_caducidad <= CURDATE() + INTERVAL 7 DAY AND p.cantidad_disponible > 0');
    } else if (status === 'out_of_stock') {
        conditions.push('p.cantidad_disponible <= 0');
    }

    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY p.nombre_producto ASC';

    try {
        const [rows] = await pool.query(sql, params);

        let totalProducts = rows.length;
        let inStock = 0;
        let lowStock = 0;
        let outOfStock = 0;
        let expiringSoonCount = 0;
        let totalValue = 0;

        rows.forEach(product => {
            // Solo sumar al valor total si es un insumo o bebida con stock directo
            if (product.category_name !== 'Platillos') {
                totalValue += parseFloat(product.cantidad_disponible || 0) * parseFloat(product.precio_venta || 0);
            }

            // Lógica de conteo de stock (ajustada para platillos)
            if (product.category_name === 'Platillos') {
                // El stock de platillos se calcula dinámicamente en el frontend o al vender
                // No contamos directamente como inStock/lowStock/outOfStock aquí para fines de inventario físico
            } else { // Insumos y bebidas
                if (product.cantidad_disponible <= 0) {
                    outOfStock++;
                } else if (product.cantidad_disponible <= product.stock_minimo && product.cantidad_disponible > 0) {
                    lowStock++;
                } else {
                    inStock++;
                }
            }

            // Conteo de productos a caducar (aplica a insumos principalmente)
            if (product.fecha_caducidad && product.cantidad_disponible > 0) {
                const expirationDate = new Date(product.fecha_caducidad);
                const today = new Date();
                const sevenDaysFromNow = new Date();
                sevenDaysFromNow.setDate(today.getDate() + 7);

                expirationDate.setHours(0, 0, 0, 0);
                today.setHours(0, 0, 0, 0);
                sevenDaysFromNow.setHours(0, 0, 0, 0);

                if (expirationDate >= today && expirationDate <= sevenDaysFromNow) {
                    expiringSoonCount++;
                }
            }
        });


        res.json({
            products: rows,
            stats: { totalProducts, inStock, lowStock, outOfStock, expiringSoon: expiringSoonCount, totalValue: totalValue.toFixed(2) }
        });
    } catch (err) {
        console.error('Error al obtener productos de inventario:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener productos.' });
    }
});

// AÑADIR UN PRODUCTO (CORREGIDO PARA MANEJAR PLATILLOS Y PARÁMETROS)
app.post('/api/inventory', async (req, res) => {
    const { nombre_producto, descripcion, categoria_id, unidad_medida, precio_compra, precio_venta, cantidad_disponible, stock_minimo, fecha_caducidad } = req.body;

    // Validación básica de campos requeridos (ajustada para permitir precio_compra/cantidad_disponible nulos para platillos)
    if (!nombre_producto || !categoria_id || !unidad_medida || precio_venta === undefined) {
        return res.status(400).json({ message: 'Nombre, categoría, unidad de medida y precio de venta son obligatorios.' });
    }

    try {
        // Obtener el nombre de la categoría para aplicar lógica condicional
        const [categoryRows] = await pool.query('SELECT nombre_categoria FROM categories WHERE id = ?', [categoria_id]);
        const category = categoryRows.length > 0 ? categoryRows[0].nombre_categoria : null;

        if (!category) {
            return res.status(400).json({ message: 'Categoría no encontrada.' });
        }

        // Determinar los valores finales a insertar basados en la categoría
        const isPlatillo = category === 'Platillos';

        const finalPrecioCompra = isPlatillo ? null : parseFloat(precio_compra) || 0;
        const finalCantidadDisponible = isPlatillo ? 0 : parseFloat(cantidad_disponible) || 0;
        const finalStockMinimo = isPlatillo ? 0 : parseFloat(stock_minimo) || 0;
        const finalFechaCaducidad = isPlatillo ? null : (fecha_caducidad || null);
        const finalUnidadMedida = isPlatillo ? 'unidad' : unidad_medida; // Platillos siempre son "unidad"

        // Asegúrate de que los valores numéricos sean válidos si no son null
        if (precio_venta === null || isNaN(precio_venta)) {
             return res.status(400).json({ message: 'El precio de venta debe ser un número válido.' });
        }


        const [result] = await pool.query(`
            INSERT INTO products (nombre_producto, descripcion, categoria_id, unidad_medida, precio_compra, precio_venta, cantidad_disponible, stock_minimo, fecha_caducidad)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
        `, [
            nombre_producto,
            descripcion || null,
            categoria_id,
            finalUnidadMedida,
            finalPrecioCompra,
            parseFloat(precio_venta), // Siempre convertir a número
            finalCantidadDisponible,
            finalStockMinimo,
            finalFechaCaducidad
        ]);

        res.status(201).json({ message: 'Producto añadido exitosamente.', id: result.insertId });
    } catch (err) {
        console.error('Error al añadir producto en el servidor:', err); // Log del error completo
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Ya existe un producto con este nombre.' });
        }
        res.status(500).json({ message: 'Error interno del servidor al añadir producto.', error: err.message });
    }
});


// Actualizar un producto existente (ajustado para manejar platillos y parámetros)
app.put('/api/inventory/:id', async (req, res) => {
    const productId = req.params.id;
    const { nombre_producto, descripcion, categoria_id, unidad_medida, precio_compra, precio_venta, cantidad_disponible, stock_minimo, fecha_caducidad } = req.body;

    // Validación básica de campos requeridos
    if (!nombre_producto || !categoria_id || !unidad_medida || precio_venta === undefined) {
        return res.status(400).json({ message: 'Nombre, categoría, unidad de medida y precio de venta son obligatorios.' });
    }

    try {
        // Obtener el nombre de la categoría para aplicar lógica condicional
        const [categoryRows] = await pool.query('SELECT nombre_categoria FROM categories WHERE id = ?', [categoria_id]);
        const category = categoryRows.length > 0 ? categoryRows[0].nombre_categoria : null;

        if (!category) {
            return res.status(400).json({ message: 'Categoría no encontrada.' });
        }

        // Determinar los valores finales a actualizar basados en la categoría
        const isPlatillo = category === 'Platillos';

        const finalPrecioCompra = isPlatillo ? null : parseFloat(precio_compra) || 0;
        const finalCantidadDisponible = isPlatillo ? 0 : parseFloat(cantidad_disponible) || 0;
        const finalStockMinimo = isPlatillo ? 0 : parseFloat(stock_minimo) || 0;
        const finalFechaCaducidad = isPlatillo ? null : (fecha_caducidad || null);
        const finalUnidadMedida = isPlatillo ? 'unidad' : unidad_medida; // Platillos siempre son "unidad"

        if (precio_venta === null || isNaN(precio_venta)) {
            return res.status(400).json({ message: 'El precio de venta debe ser un número válido.' });
        }

        const [result] = await pool.query(`
            UPDATE products SET
                nombre_producto = ?,
                descripcion = ?,
                categoria_id = ?,
                unidad_medida = ?,
                precio_compra = ?,
                precio_venta = ?,
                cantidad_disponible = ?,
                stock_minimo = ?,
                fecha_caducidad = ?
                -- ultima_actualizacion se actualiza automáticamente si tiene un DEFAULT en la BD
            WHERE id = ?;
        `, [
            nombre_producto,
            descripcion || null,
            categoria_id,
            finalUnidadMedida,
            finalPrecioCompra,
            parseFloat(precio_venta),
            finalCantidadDisponible,
            finalStockMinimo,
            finalFechaCaducidad,
            productId
        ]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Producto no encontrado.' });
        }
        res.status(200).json({ message: 'Producto actualizado exitosamente.' });
    } catch (err) {
        console.error('Error al actualizar producto:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Ya existe un producto con este nombre.' });
        }
        res.status(500).json({ message: 'Error interno del servidor al actualizar producto.', error: err.message });
    }
});

// Eliminar un producto (con verificación de recetas y ventas)
app.delete('/api/inventory/:id', async (req, res) => {
    const productId = req.params.id;

    try {
        const connection = await pool.getConnection(); // Obtener una conexión del pool
        await connection.beginTransaction(); // Iniciar la transacción

        try {
            // 1. Verificar si el producto es parte de alguna receta (como platillo o como insumo)
            const [recipeUsage] = await connection.query(
                'SELECT COUNT(*) AS count FROM recipes WHERE platillo_id = ? OR insumo_id = ?',
                [productId, productId]
            );

            if (recipeUsage[0].count > 0) {
                await connection.rollback(); // Deshacer la transacción
                return res.status(409).json({ message: 'No se puede eliminar este producto porque está siendo usado en una o más recetas. Elimínelo de todas las recetas primero.' });
            }

            // 2. Verificar si el producto ha sido vendido
            const [saleUsage] = await connection.query(
                'SELECT COUNT(*) AS count FROM sales WHERE producto_id = ?',
                [productId]
            );
            if (saleUsage[0].count > 0) {
                await connection.rollback(); // Deshacer la transacción
                return res.status(409).json({ message: 'No se puede eliminar este producto porque tiene registros de ventas asociados. Considere desactivarlo o marcarlo como "obsoleto" en lugar de eliminarlo.' });
            }

            // 3. Si no hay referencias, proceder con la eliminación
            const [result] = await connection.query('DELETE FROM products WHERE id = ?', [productId]);
            if (result.affectedRows === 0) {
                await connection.rollback(); // Deshacer la transacción
                return res.status(404).json({ message: 'Producto no encontrado.' });
            }

            await connection.commit(); // Confirmar la transacción
            res.status(200).json({ message: 'Producto eliminado exitosamente.' });

        } catch (innerErr) {
            await connection.rollback(); // Deshacer la transacción en caso de cualquier error interno
            throw innerErr; // Re-lanzar el error para que sea capturado por el catch externo
        } finally {
            connection.release(); // Liberar la conexión de vuelta al pool
        }

    } catch (err) {
        console.error('Error al eliminar producto (catch externo):', err); // Log del error completo
        if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451) {
            // Este es un fallback si una restricción de clave foránea no fue capturada por las verificaciones explícitas
            return res.status(409).json({ message: 'No se puede eliminar el producto debido a dependencias existentes en la base de datos (clave foránea).' });
        }
        res.status(500).json({ message: 'Error interno del servidor al eliminar producto.', error: err.message });
    }
});

// --- Nuevas Rutas de Categorías y Recetas ---

// 4. Ruta para obtener todas las categorías
app.get('/api/categories', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM categories ORDER BY nombre_categoria');
        res.json(rows);
    } catch (err) {
        console.error('Error al obtener categorías:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener categorías.' });
    }
});

// 5. Ruta para obtener los insumos de una receta de un platillo específico
app.get('/api/recipes/:platillo_id', async (req, res) => {
    const platilloId = req.params.platillo_id;
    try {
        const [rows] = await pool.query(
            `SELECT r.id, r.platillo_id, r.insumo_id, r.cantidad_requerida, r.unidad_medida_receta,
                    p.nombre_producto as insumo_nombre, p.unidad_medida as insumo_unidad_medida_base
             FROM recipes r
             JOIN products p ON r.insumo_id = p.id
             WHERE r.platillo_id = ?`,
            [platilloId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Error al obtener receta:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener la receta.' });
    }
});

// 6. Ruta para añadir un insumo a una receta (o actualizar si ya existe)
app.post('/api/recipes/:platillo_id', async (req, res) => { // Ruta cambiada para incluir platillo_id en la URL, más RESTful
    const platillo_id = req.params.platillo_id; // Obtener platillo_id de la URL
    const { insumo_id, cantidad_requerida, unidad_medida_receta } = req.body;

    if (!platillo_id || !insumo_id || !cantidad_requerida || !unidad_medida_receta) {
        return res.status(400).json({ message: 'Todos los campos de la receta son obligatorios.' });
    }

    try {
        // Verificar que el platillo_id sea realmente un platillo
        const [platilloCheck] = await pool.query(
            `SELECT p.id FROM products p JOIN categories c ON p.categoria_id = c.id
             WHERE p.id = ? AND c.nombre_categoria = 'Platillos'`,
            [platillo_id]
        );
        if (platilloCheck.length === 0) {
            return res.status(400).json({ message: 'El ID proporcionado no corresponde a un Platillo.' });
        }

        // Verificar que el insumo_id sea realmente un insumo (o bebida si permites bebidas como insumos)
        const [insumoCheck] = await pool.query(
            `SELECT p.id FROM products p JOIN categories c ON p.categoria_id = c.id
             WHERE p.id = ? AND (c.nombre_categoria = 'Insumos' OR c.nombre_categoria = 'Bebidas')`, // Permitir bebidas como insumos
            [insumo_id]
        );
        if (insumoCheck.length === 0) {
            return res.status(400).json({ message: 'El ID proporcionado no corresponde a un Insumo o Bebida.' });
        }

        // Verificar si ya existe este insumo en la receta de este platillo
        const [existing] = await pool.query(
            'SELECT id FROM recipes WHERE platillo_id = ? AND insumo_id = ?',
            [platillo_id, insumo_id]
        );

        if (existing.length > 0) {
            // Si ya existe, actualizamos la cantidad en lugar de añadir uno nuevo
            const [updateResult] = await pool.query(
                'UPDATE recipes SET cantidad_requerida = ?, unidad_medida_receta = ? WHERE id = ?',
                [cantidad_requerida, unidad_medida_receta, existing[0].id]
            );
            return res.status(200).json({ message: 'Insumo de receta actualizado exitosamente.', id: existing[0].id });
        }

        const [result] = await pool.query(
            'INSERT INTO recipes (platillo_id, insumo_id, cantidad_requerida, unidad_medida_receta) VALUES (?, ?, ?, ?)',
            [platillo_id, insumo_id, cantidad_requerida, unidad_medida_receta]
        );
        res.status(201).json({ id: result.insertId, message: 'Insumo añadido a la receta exitosamente.' });
    } catch (err) {
        console.error('Error al añadir/actualizar insumo a receta:', err); // Log del error completo
        if (err.code === 'ER_DUP_ENTRY') {
             return res.status(409).json({ message: 'Este insumo ya existe en la receta de este platillo.' });
        }
        res.status(500).json({ message: 'Error interno del servidor al añadir/actualizar insumo a la receta.' });
    }
});

// 7. Ruta para eliminar un insumo de una receta (CORREGIDO: usa platillo_id y insumo_id)
app.delete('/api/recipes/:platillo_id/insumos/:insumo_id', async (req, res) => {
    const platilloId = req.params.platillo_id;
    const insumoId = req.params.insumo_id;
    try {
        const [result] = await pool.query('DELETE FROM recipes WHERE platillo_id = ? AND insumo_id = ?', [platilloId, insumoId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Insumo de receta no encontrado para este platillo.' });
        }
        res.json({ message: 'Insumo eliminado de la receta exitosamente.' });
    } catch (err) {
        console.error('Error al eliminar insumo de receta:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al eliminar insumo de la receta.' });
    }
});


// 8. Ruta para obtener productos para el menú (solo platillos y bebidas, con stock calculado para platillos)
app.get('/api/sales/menu', async (req, res) => {
    try {
        // Obtener platillos y bebidas con sus categorías
        const [menuItems] = await pool.query(`
            SELECT p.id, p.nombre_producto, p.precio_venta, p.cantidad_disponible, p.unidad_medida, c.nombre_categoria
            FROM products p
            JOIN categories c ON p.categoria_id = c.id
            WHERE c.nombre_categoria IN ('Platillos', 'Bebidas')
            ORDER BY c.nombre_categoria, p.nombre_producto;
        `);

        // Obtener todas las recetas para calcular el stock de platillos
        const [recipes] = await pool.query(`
            SELECT r.platillo_id, r.insumo_id, r.cantidad_requerida, r.unidad_medida_receta,
                   p.cantidad_disponible as insumo_stock_disponible, p.unidad_medida as insumo_unidad_base,
                   c.nombre_categoria as insumo_categoria -- Necesario para posibles conversiones
            FROM recipes r
            JOIN products p ON r.insumo_id = p.id
            JOIN categories c ON p.categoria_id = c.id;
        `);

        const platilloRecipesMap = new Map();
        recipes.forEach(recipe => {
            if (!platilloRecipesMap.has(recipe.platillo_id)) {
                platilloRecipesMap.set(recipe.platillo_id, []);
            }
            platilloRecipesMap.get(recipe.platillo_id).push(recipe);
        });

        const menuWithCalculatedStock = menuItems.map(item => {
            if (item.nombre_categoria === 'Platillos') {
                let maxPossible = Infinity;
                const itemRecipes = platilloRecipesMap.get(item.id) || [];

                if (itemRecipes.length === 0) {
                    maxPossible = 0; // Si un platillo no tiene receta, stock es 0
                } else {
                    for (const recipeInsumo of itemRecipes) {
                        if (recipeInsumo.cantidad_requerida > 0) {
                            // TODO: Considerar conversiones de unidades si unidad_medida_receta
                            // y insumo_unidad_base no son siempre iguales.
                            // Por ahora, se asume que son directamente comparables o que la cantidad_requerida ya está en la unidad base.
                            const possibleFromThisInsumo = Math.floor(recipeInsumo.insumo_stock_disponible / recipeInsumo.cantidad_requerida);
                            maxPossible = Math.min(maxPossible, possibleFromThisInsumo);
                        } else {
                            // Si cantidad_requerida es 0, este insumo no limita la producción
                            // Esto puede indicar un error en la receta o un insumo "simbólico"
                            // No debería afectar maxPossible negativamente.
                        }
                    }
                }
                item.cantidad_disponible = maxPossible; // Esto es el stock calculable del platillo
            }
            // Para bebidas, la cantidad_disponible ya es el stock directo
            return item;
        });

        res.json(menuWithCalculatedStock);

    } catch (err) {
        console.error('Error al obtener productos para el menú:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener el menú.' });
    }
});


// 9. Ruta para registrar una venta (ACTUALIZADA PARA RECETAS Y TRANSACCIONES)
app.post('/api/sales', async (req, res) => {
    const { cartItems, userId, paymentType } = req.body; // Recibe un array de items del carrito

    if (!cartItems || cartItems.length === 0 || !userId || !paymentType) {
        return res.status(400).json({ message: 'Datos incompletos para registrar la venta.' });
    }

    const connection = await pool.getConnection(); // Obtener una conexión del pool
    try {
        await connection.beginTransaction(); // Iniciar la transacción

        for (const item of cartItems) {
            const { productId, quantity, unitPrice, categoryName, productName } = item; // Añadir productName para mensajes de error

            // Registrar la venta individualmente para cada item
            await connection.query(`
                INSERT INTO sales (producto_id, cantidad, precio_unitario, fecha_venta, user_id, tipo_pago)
                VALUES (?, ?, ?, NOW(), ?, ?);
            `, [productId, quantity, unitPrice, userId, paymentType]);

            // Descontar stock o insumos según la categoría
            if (categoryName === 'Platillos') {
                // Obtener los insumos para este platillo
                const [recipeInsumos] = await connection.query(
                    `SELECT r.insumo_id, r.cantidad_requerida, p.nombre_producto as insumo_nombre,
                            p.cantidad_disponible as insumo_stock_actual, p.unidad_medida as insumo_unidad_base
                     FROM recipes r
                     JOIN products p ON r.insumo_id = p.id
                     WHERE r.platillo_id = ?`,
                    [productId]
                );

                if (recipeInsumos.length === 0) {
                    await connection.rollback();
                    return res.status(400).json({ message: `Platillo "${productName}" no tiene receta definida. No se puede vender.` });
                }

                // Verificar y descontar cada insumo
                for (const insumo of recipeInsumos) {
                    const requiredTotal = insumo.cantidad_requerida * quantity;
                    if (insumo.insumo_stock_actual < requiredTotal) {
                        await connection.rollback(); // Rollback si no hay suficiente stock
                        return res.status(400).json({ message: `Stock insuficiente de "${insumo.insumo_nombre}" para vender "${productName}". Necesitas ${requiredTotal} ${insumo.insumo_unidad_base}, tienes ${insumo.insumo_stock_actual}.` });
                    }
                    await connection.query(
                        'UPDATE products SET cantidad_disponible = cantidad_disponible - ? WHERE id = ?',
                        [requiredTotal, insumo.insumo_id]
                    );
                }

            } else { // Es una Bebida o Insumo (si permites vender insumos directamente)
                // Verificar stock directo
                const [productStock] = await connection.query(
                    'SELECT cantidad_disponible FROM products WHERE id = ?',
                    [productId]
                );
                if (productStock.length === 0 || productStock[0].cantidad_disponible < quantity) {
                    await connection.rollback(); // Rollback si no hay suficiente stock
                    return res.status(400).json({ message: `Stock insuficiente de "${productName}". Cantidad disponible: ${productStock[0] ? productStock[0].cantidad_disponible : 0}.` });
                }
                // Descontar stock directo
                await connection.query(
                    'UPDATE products SET cantidad_disponible = cantidad_disponible - ? WHERE id = ?',
                    [quantity, productId]
                );
            }
        }

        await connection.commit(); // Confirmar la transacción
        res.status(201).json({ message: 'Venta registrada y stock actualizado exitosamente.' });

    } catch (err) {
        await connection.rollback(); // Deshacer la transacción en caso de cualquier error
        console.error('Error al registrar venta o actualizar stock:', err); // Log del error completo
        res.status(500).json({ message: 'Error interno del servidor al procesar la venta.', error: err.message });
    } finally {
        connection.release(); // Liberar la conexión de vuelta al pool
    }
});


// 10. Ruta para registrar un movimiento de stock (ej. entrada de inventario, merma)
app.post('/api/stock_movements', async (req, res) => {
    const { productId, movementType, quantity, userId, observations } = req.body;
    if (!productId || !movementType || quantity === undefined || !userId) {
        return res.status(400).json({ message: 'Faltan datos para registrar el movimiento de stock (producto, tipo, cantidad, usuario).' });
    }

    // Iniciar una transacción
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        await connection.query(`
            INSERT INTO stock_movements (product_id, tipo_movimiento, cantidad, fecha_movimiento, user_id, observaciones)
            VALUES (?, ?, ?, NOW(), ?, ?);
        `, [productId, movementType, quantity, userId, observations || null]);

        // Actualizar la cantidad disponible del producto según el tipo de movimiento
        let updateSql = '';
        if (movementType === 'entrada_compra' || movementType === 'ajuste_positivo') {
            updateSql = 'UPDATE products SET cantidad_disponible = cantidad_disponible + ? WHERE id = ?;';
        } else if (movementType === 'salida_ajuste' || movementType === 'merma_caducidad' || movementType === 'merma_daño' || movementType === 'salida_venta') {
            // Asegurarse de que no se descuente más de lo disponible para salidas
            const [currentStock] = await connection.query('SELECT cantidad_disponible FROM products WHERE id = ?', [productId]);
            if (currentStock.length === 0 || currentStock[0].cantidad_disponible < quantity) {
                await connection.rollback();
                return res.status(400).json({ message: `No hay suficiente stock para este movimiento de salida. Cantidad disponible: ${currentStock[0] ? currentStock[0].cantidad_disponible : 0}.` });
            }
            updateSql = 'UPDATE products SET cantidad_disponible = cantidad_disponible - ? WHERE id = ?;';
        }

        if (updateSql) {
            await connection.query(updateSql, [quantity, productId]);
        }

        await connection.commit();
        res.status(201).json({ message: 'Movimiento de stock registrado exitosamente.' });
    } catch (err) {
        await connection.rollback();
        console.error('Error al registrar movimiento de stock:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al registrar movimiento de stock.', error: err.message });
    } finally {
        connection.release();
    }
});


// 11. Ruta para obtener todos los usuarios (para gestión de usuarios)
app.get('/api/users', async (req, res) => {
    try {
        const [users] = await pool.query('SELECT id, username, role, nombre_completo, email, activo FROM users');
        res.json(users);
    } catch (err) {
        console.error('Error al obtener usuarios:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener usuarios.' });
    }
});

// 12. Ruta para añadir un nuevo usuario
app.post('/api/users', async (req, res) => {
    const { username, password, role, nombre_completo, email } = req.body;
    if (!username || !password || !role) {
        return res.status(400).json({ message: 'Usuario, contraseña y rol son requeridos.' });
    }
    try {
        const [result] = await pool.query(
            'INSERT INTO users (username, password, role, nombre_completo, email) VALUES (?, ?, ?, ?, ?)',
            [username, password, role, nombre_completo || null, email || null]
        );
        res.status(201).json({ message: 'Usuario creado exitosamente.', id: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'El nombre de usuario o email ya existe.' });
        }
        console.error('Error al crear usuario:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al crear usuario.' });
    }
});

// 13. Ruta para actualizar un usuario
app.put('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    const { username, password, role, nombre_completo, email, activo } = req.body;
    if (!username || !role || activo === undefined) {
        return res.status(400).json({ message: 'Usuario, rol y estado activo son requeridos.' });
    }

    let sql = 'UPDATE users SET username = ?, role = ?, nombre_completo = ?, email = ?, activo = ?';
    let params = [username, role, nombre_completo || null, email || null, activo];

    if (password) {
        sql += ', password = ?';
        params.push(password);
    }
    sql += ' WHERE id = ?';
    params.push(id);

    try {
        const [result] = await pool.query(sql, params);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        res.status(200).json({ message: 'Usuario actualizado exitosamente.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'El nombre de usuario o email ya existe.' });
        }
        console.error('Error al actualizar usuario:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al actualizar usuario.' });
    }
});

// 14. Ruta para eliminar un usuario
app.delete('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const [result] = await pool.query('DELETE FROM users WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        res.status(200).json({ message: 'Usuario eliminado exitosamente.' });
    } catch (err) {
        console.error('Error al eliminar usuario:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al eliminar usuario.' });
    }
});


// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor backend corriendo en http://localhost:${PORT}`);
    console.log(`Frontend disponible en http://localhost:${PORT}/index.html`);
});