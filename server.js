const express = require('express');
const path = require('path');
const app = express();

// Servir archivos estáticos
app.use(express.static('public'));

// Ruta principal - SIRVE EL BOT
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Ruta para UptimeRobot (MANTENER ACTIVO)
app.get('/ping', (req, res) => {
    res.status(200).send('🐙 KRAKEN PRO 2.0 - Activo ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log('🌐 Servidor web en puerto ' + PORT);
});

console.log('🐙 KRAKEN PRO 2.0 - Servidor iniciado');
console.log('⏰ Ejecutándose automáticamente 24/7');
