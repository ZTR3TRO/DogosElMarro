const bcrypt = require('bcrypt');

async function hashAndLogPassword(password) {
    // saltRounds es el factor de costo. 10 es un valor seguro y común.
    // Debe ser el mismo que usas en tu app.js cuando registras usuarios.
    const saltRounds = 10;
    try {
        const hashedPassword = await bcrypt.hash(password, saltRounds);
        console.log('----------------------------------------------------');
        console.log('Contraseña Original: \x1b[33m%s\x1b[0m', password); // Mostrará en amarillo
        console.log('Contraseña Hasheada: \x1b[32m%s\x1b[0m', hashedPassword); // Mostrará en verde
        console.log('----------------------------------------------------');
    } catch (error) {
        console.error('Error al hashear la contraseña:', error);
    }
}

// --- ¡IMPORTANTE! ---
// Cambia 'admin123' por la contraseña que QUIERES que tenga tu usuario administrador
// en la base de datos. Si tu usuario 'admin' por defecto tiene 'admin123',
// déjalo así. Si prefieres otra, cámbiala aquí.
hashAndLogPassword('admin123'); // <--- Edita esta línea si quieres otra contraseña