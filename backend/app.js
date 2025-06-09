// backend/app.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const pool = require('./db'); // Importa directamente el pool de conexiones desde db.js
const bcrypt = require('bcrypt'); // Asegúrate de que bcrypt esté instalado: npm install bcrypt

const app = express();
const PORT = 3000;

// Middleware
app.use(cors()); // Habilita CORS para permitir peticiones desde el frontend
app.use(bodyParser.json()); // Para parsear el cuerpo de las peticiones como JSON

// Sirve archivos estáticos del frontend desde la carpeta 'frontend' que está un nivel arriba.
app.use(express.static(path.join(__dirname, '../frontend')));

// --- Rutas de la API ---

// 1. Ruta de Login (Autenticación de Usuarios)
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: 'Usuario y contraseña son requeridos.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        const [rows] = await connection.execute(
            'SELECT id, username, password, role, activo, nombre_completo FROM users WHERE username = ?',
            [username]
        );

        if (rows.length === 0) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        const user = rows[0];

        if (!user.activo) {
            return res.status(403).json({ message: 'Tu cuenta está inactiva. Contacta al administrador.' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);

        if (!isPasswordValid) {
            return res.status(401).json({ message: 'Credenciales inválidas.' });
        }

        res.status(200).json({
            message: 'Inicio de sesión exitoso.',
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                nombre_completo: user.nombre_completo
            }
        });

    } catch (err) {
        console.error('Error durante el inicio de sesión:', err);
        res.status(500).json({ message: 'Error interno del servidor.', error: err.message });
    } finally {
        if (connection) connection.release();
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

    let connection;
    try {
        connection = await pool.getConnection();

        const [totalProductsResult] = await connection.query('SELECT COUNT(*) AS count FROM products WHERE activo = 1');
        summary.totalProducts = totalProductsResult[0].count;

        const today = new Date().toISOString().split('T')[0];
        const [dailySalesResult] = await connection.query(`
            SELECT SUM(total) AS total FROM ventas WHERE DATE(fecha_venta) = ?
        `, [today]);
        summary.dailySales = parseFloat(dailySalesResult[0].total) || 0;

        const [lowStockResult] = await connection.query(`
            SELECT p.id, p.nombre_producto, p.cantidad_disponible, p.stock_minimo, p.unidad_medida, c.nombre_categoria
            FROM products p
            JOIN categories c ON p.categoria_id = c.id
            WHERE p.cantidad_disponible <= p.stock_minimo
            AND p.cantidad_disponible > 0
            AND c.nombre_categoria IN ('Insumos', 'Bebidas')
            AND p.activo = 1
            ORDER BY p.cantidad_disponible ASC LIMIT 1
        `);
        summary.lowStockProduct = lowStockResult.length > 0 ? lowStockResult[0] : null;

        const [lastSaleResult] = await connection.query(`
            SELECT v.id AS venta_id, v.fecha_venta, v.total, u.username as cajero
            FROM ventas v
            JOIN users u ON v.usuario_id = u.id
            ORDER BY v.fecha_venta DESC LIMIT 1
        `);
        summary.lastSale = lastSaleResult.length > 0 ? lastSaleResult[0] : null;

        const [expiringProducts] = await connection.query(`
            SELECT id, nombre_producto, cantidad_disponible, fecha_caducidad
            FROM products
            WHERE fecha_caducidad IS NOT NULL AND fecha_caducidad <= CURDATE() + INTERVAL 7 DAY
            AND cantidad_disponible > 0
            AND categoria_id IN (SELECT id FROM categories WHERE nombre_categoria IN ('Insumos', 'Bebidas'))
            AND activo = 1
            ORDER BY fecha_caducidad ASC LIMIT 5
        `);
        summary.productsExpiringSoon = expiringProducts;

        res.json(summary);
    } catch (err) {
        console.error('Error al obtener el resumen del dashboard:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener el resumen.' });
    } finally {
        if (connection) connection.release();
    }
});

// 3. Rutas de Inventario (CRUD para productos)

// Obtener todos los productos CON FILTROS Y CATEGORÍA
app.get('/api/inventory', async (req, res) => {
    const searchTerm = req.query.search || '';
    const categoryName = req.query.category || '';
    const status = req.query.status || '';
    const active = req.query.active;

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
        conditions.push('p.cantidad_disponible <= p.stock_minimo AND p.cantidad_disponible > 0 AND c.nombre_categoria IN ("Insumos", "Bebidas")');
    } else if (status === 'expiring_soon') {
        conditions.push('p.fecha_caducidad IS NOT NULL AND p.fecha_caducidad <= CURDATE() + INTERVAL 7 DAY AND p.cantidad_disponible > 0 AND c.nombre_categoria IN ("Insumos", "Bebidas")');
    } else if (status === 'out_of_stock') {
        conditions.push('p.cantidad_disponible <= 0 AND c.nombre_categoria IN ("Insumos", "Bebidas")');
    }

    if (active !== undefined) {
        conditions.push('p.activo = ?');
        params.push(active === 'true' ? 1 : 0);
    } else {
        conditions.push('p.activo = 1');
    }

    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY p.nombre_producto ASC';

    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.query(sql, params);

        let totalProducts = rows.length;
        let inStock = 0;
        let lowStock = 0;
        let outOfStock = 0;
        let expiringSoonCount = 0;
        let totalValue = 0;

        rows.forEach(product => {
            if (product.category_name === 'Insumos' || product.category_name === 'Bebidas') {
                totalValue += parseFloat(product.cantidad_disponible || 0) * parseFloat(product.precio_venta || 0);

                if (product.cantidad_disponible <= 0) {
                    outOfStock++;
                } else if (product.cantidad_disponible <= product.stock_minimo && product.cantidad_disponible > 0) {
                    lowStock++;
                } else {
                    inStock++;
                }

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
            }
        });

        res.json({
            products: rows,
            stats: { totalProducts, inStock, lowStock, outOfStock, expiringSoon: expiringSoonCount, totalValue: totalValue.toFixed(2) }
        });
    } catch (err) {
        console.error('Error al obtener productos de inventario:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener productos.' });
    } finally {
        if (connection) connection.release();
    }
});

// AÑADIR UN PRODUCTO
app.post('/api/inventory', async (req, res) => {
    const { nombre_producto, descripcion, categoria_id, unidad_medida, precio_compra, precio_venta, cantidad_disponible, stock_minimo, fecha_caducidad } = req.body;

    if (!nombre_producto || !categoria_id || precio_venta === undefined) {
        return res.status(400).json({ message: 'Nombre, categoría y precio de venta son obligatorios.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        const [categoryRows] = await connection.query('SELECT nombre_categoria FROM categories WHERE id = ?', [categoria_id]);
        const category = categoryRows.length > 0 ? categoryRows[0].nombre_categoria : null;

        if (!category) {
            return res.status(400).json({ message: 'Categoría no encontrada.' });
        }

        const isPlatillo = category === 'Platillos';

        const finalPrecioCompra = isPlatillo ? null : (parseFloat(precio_compra) || 0);
        const finalCantidadDisponible = isPlatillo ? 0 : (parseFloat(cantidad_disponible) || 0);
        const finalStockMinimo = isPlatillo ? 0 : (parseFloat(stock_minimo) || 0);
        const finalFechaCaducidad = isPlatillo ? null : (fecha_caducidad || null);
        const finalUnidadMedida = isPlatillo ? 'unidad' : (unidad_medida || 'unidad');

        if (isNaN(parseFloat(precio_venta))) {
             return res.status(400).json({ message: 'El precio de venta debe ser un número válido.' });
        }

        const [result] = await connection.query(`
            INSERT INTO products (nombre_producto, descripcion, categoria_id, unidad_medida, precio_compra, precio_venta, cantidad_disponible, stock_minimo, fecha_caducidad, activo, ultima_actualizacion)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW());
        `, [
            nombre_producto,
            descripcion || null,
            categoria_id,
            finalUnidadMedida,
            finalPrecioCompra,
            parseFloat(precio_venta),
            finalCantidadDisponible,
            finalStockMinimo,
            finalFechaCaducidad
        ]);

        res.status(201).json({ message: 'Producto añadido exitosamente.', id: result.insertId });
    } catch (err) {
        console.error('Error al añadir producto en el servidor:', err);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Ya existe un producto con este nombre.' });
        }
        res.status(500).json({ message: 'Error interno del servidor al añadir producto.', error: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// Actualizar un producto existente
app.put('/api/inventory/:id', async (req, res) => {
    const productId = req.params.id;
    const { nombre_producto, descripcion, categoria_id, unidad_medida, precio_compra, precio_venta, cantidad_disponible, stock_minimo, fecha_caducidad, activo } = req.body;

    if (!nombre_producto || !categoria_id || precio_venta === undefined || activo === undefined) {
        return res.status(400).json({ message: 'Nombre, categoría, precio de venta y estado activo son obligatorios.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        const [categoryRows] = await connection.query('SELECT nombre_categoria FROM categories WHERE id = ?', [categoria_id]);
        const category = categoryRows.length > 0 ? categoryRows[0].nombre_categoria : null;

        if (!category) {
            return res.status(400).json({ message: 'Categoría no encontrada.' });
        }

        const isPlatillo = category === 'Platillos';

        const finalPrecioCompra = isPlatillo ? null : (parseFloat(precio_compra) || 0);
        const finalCantidadDisponible = isPlatillo ? 0 : (parseFloat(cantidad_disponible) || 0);
        const finalStockMinimo = isPlatillo ? 0 : (parseFloat(stock_minimo) || 0);
        const finalFechaCaducidad = isPlatillo ? null : (fecha_caducidad || null);
        const finalUnidadMedida = isPlatillo ? 'unidad' : (unidad_medida || 'unidad');

        if (isNaN(parseFloat(precio_venta))) {
            return res.status(400).json({ message: 'El precio de venta debe ser un número válido.' });
        }

        const [result] = await connection.query(`
            UPDATE products SET
                nombre_producto = ?,
                descripcion = ?,
                categoria_id = ?,
                unidad_medida = ?,
                precio_compra = ?,
                precio_venta = ?,
                cantidad_disponible = ?,
                stock_minimo = ?,
                fecha_caducidad = ?,
                activo = ?,
                ultima_actualizacion = NOW() -- AÑADIDO: Actualiza la fecha de última actualización
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
            activo ? 1 : 0,
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
    } finally {
        if (connection) connection.release();
    }
});

// Eliminar un producto (desactivar)
app.delete('/api/inventory/:id', async (req, res) => {
    const productId = req.params.id;

    let connection;
    try {
        connection = await pool.getConnection();
        const [result] = await connection.query('UPDATE products SET activo = 0 WHERE id = ?', [productId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Producto no encontrado o ya estaba inactivo.' });
        }
        res.status(200).json({ message: 'Producto desactivado exitosamente (marcado como inactivo).' });

    } catch (err) {
        console.error('Error al desactivar producto:', err);
        res.status(500).json({ message: 'Error interno del servidor al desactivar producto.', error: err.message });
    } finally {
        if (connection) connection.release();
    }
});


// --- Nuevas Rutas de Categorías y Recetas ---

// 4. Ruta para obtener todas las categorías
app.get('/api/categories', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.query('SELECT * FROM categories ORDER BY nombre_categoria');
        res.json(rows);
    } catch (err) {
        console.error('Error al obtener categorías:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener categorías.' });
    } finally {
        if (connection) connection.release();
    }
});

// 5. Ruta para obtener los insumos de una receta de un platillo específico
app.get('/api/recipes/:platillo_id', async (req, res) => {
    const platilloId = req.params.platillo_id;
    let connection;
    try {
        connection = await pool.getConnection();
        const [rows] = await connection.query(
            `SELECT r.id as recipe_item_id, r.platillo_id, r.insumo_id, r.cantidad_requerida, r.unidad_medida_receta,
                    p.nombre_producto as insumo_nombre, p.unidad_medida as insumo_unidad_base
             FROM recipes r
             JOIN products p ON r.insumo_id = p.id
             WHERE r.platillo_id = ?`,
            [platilloId]
        );
        res.json(rows);
    } catch (err) {
        console.error('Error al obtener receta:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener la receta.' });
    } finally {
        if (connection) connection.release();
    }
});

// 6. Ruta para añadir un insumo a una receta (o actualizar si ya existe)
app.post('/api/recipes/:platillo_id', async (req, res) => {
    const platillo_id = req.params.platillo_id;
    const { insumo_id, cantidad_requerida, unidad_medida_receta } = req.body;

    if (!platillo_id || !insumo_id || cantidad_requerida === undefined || !unidad_medida_receta) {
        return res.status(400).json({ message: 'Todos los campos de la receta son obligatorios.' });
    }
    if (isNaN(parseFloat(cantidad_requerida)) || parseFloat(cantidad_requerida) <= 0) {
        return res.status(400).json({ message: 'La cantidad requerida debe ser un número positivo.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        const [platilloCheck] = await connection.query(
            `SELECT p.id FROM products p JOIN categories c ON p.categoria_id = c.id
             WHERE p.id = ? AND c.nombre_categoria = 'Platillos'`,
            [platillo_id]
        );
        if (platilloCheck.length === 0) {
            return res.status(400).json({ message: 'El ID proporcionado no corresponde a un Platillo.' });
        }

        const [insumoCheck] = await connection.query(
            `SELECT p.id FROM products p JOIN categories c ON p.categoria_id = c.id
             WHERE p.id = ? AND (c.nombre_categoria = 'Insumos' OR c.nombre_categoria = 'Bebidas')`,
            [insumo_id]
        );
        if (insumoCheck.length === 0) {
            return res.status(400).json({ message: 'El ID proporcionado no corresponde a un Insumo o Bebida.' });
        }

        const [existing] = await connection.query(
            'SELECT id FROM recipes WHERE platillo_id = ? AND insumo_id = ?',
            [platillo_id, insumo_id]
        );

        if (existing.length > 0) {
            const [updateResult] = await connection.query(
                'UPDATE recipes SET cantidad_requerida = ?, unidad_medida_receta = ? WHERE id = ?',
                [parseFloat(cantidad_requerida), unidad_medida_receta, existing[0].id]
            );
            return res.status(200).json({ message: 'Insumo de receta actualizado exitosamente.', id: existing[0].id });
        }

        const [result] = await connection.query(
            'INSERT INTO recipes (platillo_id, insumo_id, cantidad_requerida, unidad_medida_receta) VALUES (?, ?, ?, ?)',
            [platillo_id, insumo_id, parseFloat(cantidad_requerida), unidad_medida_receta]
        );
        res.status(201).json({ id: result.insertId, message: 'Insumo añadido a la receta exitosamente.' });
    } catch (err) {
        console.error('Error al añadir/actualizar insumo a receta:', err);
        if (err.code === 'ER_DUP_ENTRY') {
             return res.status(409).json({ message: 'Este insumo ya existe en la receta de este platillo.' });
        }
        res.status(500).json({ message: 'Error interno del servidor al añadir/actualizar insumo a la receta.' });
    } finally {
        if (connection) connection.release();
    }
});

// 7. Ruta para eliminar un insumo de una receta
app.delete('/api/recipes/:platillo_id/insumos/:insumo_id', async (req, res) => {
    const platilloId = req.params.platillo_id;
    const insumoId = req.params.insumo_id;
    let connection;
    try {
        connection = await pool.getConnection();
        const [result] = await connection.query('DELETE FROM recipes WHERE platillo_id = ? AND insumo_id = ?', [platilloId, insumoId]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Insumo de receta no encontrado para este platillo.' });
        }
        res.json({ message: 'Insumo eliminado de la receta exitosamente.' });
    } catch (err) {
        console.error('Error al eliminar insumo de receta:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al eliminar insumo de la receta.' });
    } finally {
        if (connection) connection.release();
    }
});


// 8. Ruta para obtener productos para el menú (solo platillos y bebidas, con stock calculado para platillos)
app.get('/api/sales/menu', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();

        const [menuItems] = await connection.query(`
            SELECT p.id, p.nombre_producto, p.precio_venta, p.cantidad_disponible, p.unidad_medida, c.nombre_categoria
            FROM products p
            JOIN categories c ON p.categoria_id = c.id
            WHERE c.nombre_categoria IN ('Platillos', 'Bebidas') AND p.activo = 1
            ORDER BY c.nombre_categoria, p.nombre_producto;
        `);

        const [recipes] = await connection.query(`
            SELECT r.platillo_id, r.insumo_id, r.cantidad_requerida, r.unidad_medida_receta,
                   p.cantidad_disponible as insumo_stock_disponible, p.unidad_medida as insumo_unidad_base
            FROM recipes r
            JOIN products p ON r.insumo_id = p.id;
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
                    maxPossible = 0;
                } else {
                    for (const recipeInsumo of itemRecipes) {
                        if (recipeInsumo.cantidad_requerida <= 0 || recipeInsumo.insumo_stock_disponible === null) {
                            continue;
                        }

                        const possibleFromThisInsumo = Math.floor(recipeInsumo.insumo_stock_disponible / recipeInsumo.cantidad_requerida);
                        maxPossible = Math.min(maxPossible, possibleFromThisInsumo);
                    }
                }
                item.cantidad_disponible = maxPossible;
            }
            return item;
        });

        res.json(menuWithCalculatedStock);

    } catch (err) {
        console.error('Error al obtener productos para el menú (backend):', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener el menú.' });
    } finally {
        if (connection) connection.release();
    }
});


// 9. Ruta para registrar una venta (COMPLETAMENTE REVISADA CON TRANSACCIONES Y VALIDACIONES)
app.post('/api/sales', async (req, res) => {
    const { cartItems, userId, paymentType } = req.body;

    if (!cartItems || cartItems.length === 0 || !userId || !paymentType) {
        return res.status(400).json({ message: 'Datos incompletos para registrar la venta.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        let subtotalVenta = 0;
        for (const item of cartItems) {
            subtotalVenta += item.quantity * item.unitPrice;
        }
        const ivaVenta = subtotalVenta * 0.16; // Asumiendo un IVA del 16%
        const totalVenta = subtotalVenta + ivaVenta;

        const [ventaPrincipalResult] = await connection.query(
            'INSERT INTO ventas (usuario_id, fecha_venta, total, tipo_pago) VALUES (?, NOW(), ?, ?)',
            [userId, totalVenta, paymentType]
        );
        const ventaId = ventaPrincipalResult.insertId;

        for (const item of cartItems) {
            const { productId, quantity, unitPrice, categoryName, productName } = item;
            const itemTotal = quantity * unitPrice;

            await connection.query(
                'INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, subtotal_linea) VALUES (?, ?, ?, ?, ?)',
                [ventaId, productId, quantity, unitPrice, itemTotal]
            );

            if (categoryName === 'Platillos') {
                const [recipeInsumos] = await connection.query(
                    `SELECT r.insumo_id, r.cantidad_requerida, p.nombre_producto as insumo_nombre,
                            p.cantidad_disponible as insumo_stock_actual, p.unidad_medida as insumo_unidad_base
                     FROM recipes r
                     JOIN products p ON r.insumo_id = p.id
                     WHERE r.platillo_id = ? FOR UPDATE`,
                    [productId]
                );

                if (recipeInsumos.length === 0) {
                    await connection.rollback();
                    return res.status(400).json({ message: `Platillo "${productName}" no tiene receta definida. No se puede vender.` });
                }

                for (const insumo of recipeInsumos) {
                    const requiredTotal = insumo.cantidad_requerida * quantity;

                    if (insumo.insumo_stock_actual === null || insumo.insumo_stock_actual < requiredTotal) {
                        await connection.rollback();
                        return res.status(400).json({ message: `Stock insuficiente de "${insumo.insumo_nombre}" para el platillo "${productName}". Necesitas ${requiredTotal} ${insumo.insumo_unidad_base}, tienes ${insumo.insumo_stock_actual || 0}.` });
                    }
                    await connection.query(
                        'UPDATE products SET cantidad_disponible = cantidad_disponible - ? WHERE id = ?',
                        [requiredTotal, insumo.insumo_id]
                    );
                }

            } else { // Si es una Bebida o cualquier otro producto que no sea platillo
                const [productStock] = await connection.query(
                    'SELECT cantidad_disponible FROM products WHERE id = ? FOR UPDATE',
                    [productId]
                );

                if (productStock.length === 0 || productStock[0].cantidad_disponible === null || productStock[0].cantidad_disponible < quantity) {
                    await connection.rollback();
                    return res.status(400).json({ message: `Stock insuficiente de "${productName}". Cantidad disponible: ${productStock[0] ? productStock[0].cantidad_disponible : 0}.` });
                }
                await connection.query(
                    'UPDATE products SET cantidad_disponible = cantidad_disponible - ? WHERE id = ?',
                    [quantity, productId]
                );
            }
        }

        await connection.commit();
        res.status(201).json({ message: 'Venta registrada y stock actualizado exitosamente.', ventaId: ventaId });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error al registrar venta o actualizar stock (backend):', err);
        res.status(500).json({ message: 'Error interno del servidor al procesar la venta.', error: err.message });
    } finally {
        if (connection) connection.release();
    }
});


// 10. Ruta para registrar un movimiento de stock
app.post('/api/stock_movements', async (req, res) => {
    const { productId, movementType, quantity, userId, observations } = req.body;
    if (!productId || !movementType || quantity === undefined || !userId) {
        return res.status(400).json({ message: 'Faltan datos para registrar el movimiento de stock (producto, tipo, cantidad, usuario).' });
    }
    if (isNaN(parseFloat(quantity)) || parseFloat(quantity) <= 0) {
        return res.status(400).json({ message: 'La cantidad del movimiento debe ser un número positivo.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        await connection.query(`
            INSERT INTO stock_movements (product_id, tipo_movimiento, cantidad, fecha_movimiento, user_id, observaciones)
            VALUES (?, ?, ?, NOW(), ?, ?);
        `, [productId, movementType, parseFloat(quantity), userId, observations || null]);

        let updateSql = '';
        if (movementType === 'entrada_compra' || movementType === 'ajuste_positivo') {
            updateSql = 'UPDATE products SET cantidad_disponible = cantidad_disponible + ?, ultima_actualizacion = NOW() WHERE id = ?;';
        } else if (movementType === 'salida_ajuste' || movementType === 'merma_caducidad' || movementType === 'merma_daño') {
            const [currentStock] = await connection.query('SELECT cantidad_disponible FROM products WHERE id = ? FOR UPDATE', [productId]);
            if (currentStock.length === 0 || currentStock[0].cantidad_disponible === null || currentStock[0].cantidad_disponible < parseFloat(quantity)) {
                await connection.rollback();
                return res.status(400).json({ message: `No hay suficiente stock para este movimiento de salida. Cantidad disponible: ${currentStock[0] ? currentStock[0].cantidad_disponible : 0}.` });
            }
            updateSql = 'UPDATE products SET cantidad_disponible = cantidad_disponible - ?, ultima_actualizacion = NOW() WHERE id = ?;';
        } else {
             await connection.rollback();
             return res.status(400).json({ message: 'Tipo de movimiento de stock no reconocido.' });
        }

        if (updateSql) {
            await connection.query(updateSql, [parseFloat(quantity), productId]);
        }

        await connection.commit();
        res.status(201).json({ message: 'Movimiento de stock registrado exitosamente.' });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('Error al registrar movimiento de stock (backend):', err);
        res.status(500).json({ message: 'Error interno del servidor al registrar el movimiento de stock.', error: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// --- Rutas de Usuarios (CRUD) ---

// 11. Obtener todos los usuarios
app.get('/api/users', async (req, res) => {
    let connection;
    try {
        connection = await pool.getConnection();
        // Excluir la contraseña al obtener todos los usuarios por seguridad
        const [rows] = await connection.query('SELECT id, username, nombre_completo, email, role, activo FROM users ORDER BY username ASC');
        res.json(rows);
    } catch (err) {
        console.error('Error al obtener usuarios:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener usuarios.' });
    } finally {
        if (connection) connection.release();
    }
});

// 12. Obtener un usuario por ID
app.get('/api/users/:id', async (req, res) => {
    const userId = req.params.id;
    let connection;
    try {
        connection = await pool.getConnection();
        // No incluyas el password aquí por seguridad
        const [rows] = await connection.query('SELECT id, username, nombre_completo, email, role, activo FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('Error al obtener usuario por ID:', err.message);
        res.status(500).json({ message: 'Error interno del servidor al obtener usuario.' });
    } finally {
        if (connection) connection.release();
    }
});

// 13. Crear un nuevo usuario
app.post('/api/users', async (req, res) => {
    const { username, password, nombre_completo, email, role, activo } = req.body;

    if (!username || !password || !role) {
        return res.status(400).json({ message: 'Usuario, contraseña y rol son obligatorios.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        // Verificar si el username ya existe
        const [existingUsers] = await connection.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existingUsers.length > 0) {
            return res.status(409).json({ message: 'El nombre de usuario ya está en uso.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10); // Hash de la contraseña con un salt de 10 rondas

        const [result] = await connection.query(`
            INSERT INTO users (username, password, nombre_completo, email, role, activo)
            VALUES (?, ?, ?, ?, ?, ?);
        `, [
            username,
            hashedPassword,
            nombre_completo || null,
            email || null,
            role,
            activo === undefined ? 1 : (activo ? 1 : 0) // Por defecto activo si no se especifica
        ]);

        res.status(201).json({ message: 'Usuario creado exitosamente.', userId: result.insertId });

    } catch (err) {
        console.error('Error al crear usuario:', err);
        res.status(500).json({ message: 'Error interno del servidor al crear usuario.', error: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// 14. Actualizar un usuario existente
app.put('/api/users/:id', async (req, res) => {
    const userId = req.params.id;
    const { username, password, nombre_completo, email, role, activo } = req.body;

    if (!username || !role || activo === undefined) {
        return res.status(400).json({ message: 'Usuario, rol y estado activo son obligatorios.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        // Verificar si el nuevo username ya existe en otro usuario
        const [existingUsers] = await connection.query('SELECT id FROM users WHERE username = ? AND id != ?', [username, userId]);
        if (existingUsers.length > 0) {
            return res.status(409).json({ message: 'El nombre de usuario ya está en uso por otro usuario.' });
        }

        let updateQuery = `
            UPDATE users SET
                username = ?,
                nombre_completo = ?,
                email = ?,
                role = ?,
                activo = ?
        `;
        const params = [username, nombre_completo || null, email || null, role, activo ? 1 : 0];

        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            updateQuery += ', password = ?';
            params.push(hashedPassword);
        }

        updateQuery += ' WHERE id = ?';
        params.push(userId);

        const [result] = await connection.query(updateQuery, params);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        res.status(200).json({ message: 'Usuario actualizado exitosamente.' });

    } catch (err) {
        console.error('Error al actualizar usuario:', err);
        res.status(500).json({ message: 'Error interno del servidor al actualizar usuario.', error: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// 15. Desactivar un usuario (soft delete)
app.delete('/api/users/:id', async (req, res) => {
    const userId = req.params.id;
    let connection;
    try {
        connection = await pool.getConnection();
        const [result] = await connection.query('UPDATE users SET activo = 0 WHERE id = ?', [userId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Usuario no encontrado o ya estaba inactivo.' });
        }
        res.status(200).json({ message: 'Usuario desactivado exitosamente.' });
    } catch (err) {
        console.error('Error al desactivar usuario:', err);
        res.status(500).json({ message: 'Error interno del servidor al desactivar usuario.', error: err.message });
    } finally {
        if (connection) connection.release();
    }
});

// --- Rutas para Reportes ---
// Ruta para obtener ventas por rango de fechas
app.get('/api/reports/sales-by-date', async (req, res) => {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
        return res.status(400).json({ message: 'Se requieren fechas de inicio y fin para el reporte de ventas.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        const query = `
            SELECT
                v.id,
                v.fecha_venta,
                v.total,
                v.tipo_pago,
                u.username as cajero_username
            FROM
                ventas v
            JOIN
                users u ON v.usuario_id = u.id
            WHERE
                v.fecha_venta BETWEEN ? AND ?
            ORDER BY
                v.fecha_venta ASC;
        `;

        const [results] = await connection.execute(query, [startDate + ' 00:00:00', endDate + ' 23:59:59']);
        res.json(results);

    } catch (err) {
        console.error('Error al obtener reporte de ventas por fecha:', err);
        res.status(500).json({ message: 'Error interno del servidor al generar el reporte.' });
    } finally {
        if (connection) connection.release();
    }
});


// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`Servidor de El Marro ejecutándose en http://localhost:${PORT}`);
});