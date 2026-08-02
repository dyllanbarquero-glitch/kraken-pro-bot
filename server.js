const express = require('express');
const WebSocket = require('ws');
const app = express();

console.log('🐙 THE KRAKEN PRO — Deriv Edition - SIMPLIFICADO');
console.log('⚡ Solo EMAs · 1 hora · TP1 = 1');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const ALL_PAIRS = ['BOOM1000', 'CRASH1000', 'CRASH900', 'BOOM900'];
const EMA_PERIODS = [2, 5, 13, 34, 55, 89, 144];
const TIMEFRAME = 3600; // 1 HORA (3600 segundos)

// Credenciales
const APP_ID = '33A0UhDa0Wa1FkvF9zlKh';
const PAT_TOKEN = 'pat_3ee3edc2b80c8daea41968ea5d8205df7f75f187d17f17175d3eb863acb82d23';

// Telegram
const TELEGRAM_TOKEN = '8345003490:AAGhSXXzdltZ5dS2Civ4l0ld0dXJScQbsBo';
const TELEGRAM_CHAT = '-1003177595391';

// ==================== ESTADO ====================
let ws = null;
let signalsActive = false;
let running = false;
let totalSignals = 0;
let wins = 0;
let losses = 0;
let pairState = {};
let reconnectAttempts = 0;
let reconnectTimer = null;
let lastCandleKey = {};
let candleCloseProcessed = {};
let dataLoaded = false;
let analysisQueue = [];
let isProcessingQueue = false;
let lastSignalTime = {};

ALL_PAIRS.forEach(p => {
    pairState[p] = {
        price: null,
        ema: {},
        prevEma: {},
        candles: [],
        loaded: false,
        lastTrend: null,
        waitingForNewTrend: false,
        lastSignal: null,
        signalExpired: false,
        _lastCandleClose: null,
        _lastLogTime: 0,
        _trendStarted: false,
        _trendStartTime: null,
        _trendAge: 0,
        _tp1Hit: false,
        _partialSLLogged: false,
        _pendingEntry: false,
        _ema144Aligned: false,
        _entryTaken: false
    };
    EMA_PERIODS.forEach(period => {
        pairState[p].ema[period] = null;
        pairState[p].prevEma[period] = null;
    });
    lastCandleKey[p] = null;
    candleCloseProcessed[p] = false;
    lastSignalTime[p] = 0;
});

// ==================== REINICIAR ESTADO ====================
function resetPairState(sym) {
    const st = pairState[sym];
    if (!st) return;
    console.log(`🔄 ${sym}: Reiniciando estado...`);
    st.lastSignal = null;
    st.signalExpired = false;
    st._trendStarted = false;
    st._trendStartTime = null;
    st._trendAge = 0;
    st._tp1Hit = false;
    st._partialSLLogged = false;
    st._pendingEntry = false;
    st._ema144Aligned = false;
    st._entryTaken = false;
    st.waitingForNewTrend = false;
    st.lastTrend = null;
}

// ==================== TELEGRAM ====================
async function sendTelegramMessage(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: message, parse_mode: 'HTML' })
        });
        const result = await response.json();
        if (result.ok) {
            console.log('📨 Mensaje enviado a Telegram');
            return true;
        }
        return false;
    } catch (error) {
        console.log('❌ Error Telegram:', error.message);
        return false;
    }
}

// ==================== EMAS ====================
function calculateEMA(prices, period) {
    if (prices.length < period) return null;
    let sum = 0;
    for (let i = 0; i < period; i++) sum += prices[i];
    let ema = sum / period;
    const k = 2 / (period + 1);
    for (let i = period; i < prices.length; i++) ema = (prices[i] - ema) * k + ema;
    return parseFloat(ema.toFixed(4));
}

function calcEMAs(sym) {
    const st = pairState[sym];
    if (!st.candles || st.candles.length < 144) return;
    const prices = st.candles.slice();
    EMA_PERIODS.forEach(period => {
        st.ema[period] = calculateEMA(prices, period);
    });
}

// ==================== DETECTAR TENDENCIA ====================
function detectTrendStart(sym) {
    const st = pairState[sym];
    if (!st || st.ema[2] === null || st.ema[5] === null || st.ema[13] === null ||
        st.ema[34] === null || st.ema[55] === null || st.ema[89] === null || st.ema[144] === null) return false;

    const isBoom = sym.includes('BOOM');
    
    // ✅ SOLO VERIFICAR QUE LAS EMAS ESTÉN ALINEADAS
    const isBullish = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] &&
                      st.ema[13] > st.ema[34] && st.ema[34] > st.ema[55] &&
                      st.ema[55] > st.ema[89] && st.ema[89] > st.ema[144];
                      
    const isBearish = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] &&
                      st.ema[13] < st.ema[34] && st.ema[34] < st.ema[55] &&
                      st.ema[55] < st.ema[89] && st.ema[89] < st.ema[144];

    if (!isBullish && !isBearish) {
        return false;
    }

    // ✅ VERIFICAR EMA144 ALINEADA (CONFIRMACIÓN)
    const ema144Aligned = isEMA144Aligned(sym);
    if (!ema144Aligned) {
        return false;
    }

    // ✅ EVITAR SEÑALES DUPLICADAS
    if (st.lastSignal && !st.signalExpired) {
        return false;
    }

    console.log(`🚀 ${sym}: SEÑAL CONFIRMADA | ${isBullish ? 'ALCISTA' : 'BAJISTA'} | EMA144 ✅`);
    return true;
}

function isEMA144Aligned(sym) {
    const st = pairState[sym];
    if (!st || st.ema[144] === null || st.ema[34] === null) return false;
    const isBoom = sym.includes('BOOM');
    const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] &&
                           st.ema[13] > st.ema[34] && st.ema[34] > st.ema[55] &&
                           st.ema[55] > st.ema[89] && st.ema[89] > st.ema[144];
    const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] &&
                           st.ema[13] < st.ema[34] && st.ema[34] < st.ema[55] &&
                           st.ema[55] < st.ema[89] && st.ema[89] < st.ema[144];
    if (isBoom && isBullishTrend) return st.ema[144] < st.ema[34];
    if (!isBoom && isBearishTrend) return st.ema[144] > st.ema[34];
    return false;
}

// ==================== GENERAR SEÑAL ====================
function generateSignal(sym) {
    const st = pairState[sym];
    if (!st || st.lastSignal && !st.signalExpired) return;

    const isBoom = sym.includes('BOOM');
    const price = st.price;
    const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] &&
                           st.ema[13] > st.ema[34] && st.ema[34] > st.ema[55] &&
                           st.ema[55] > st.ema[89] && st.ema[89] > st.ema[144];
    const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] &&
                           st.ema[13] < st.ema[34] && st.ema[34] < st.ema[55] &&
                           st.ema[55] < st.ema[89] && st.ema[89] < st.ema[144];

    if (!isBullishTrend && !isBearishTrend) return;

    // ✅ TP1 = 1 (ratio 1:1)
    const tpRatio = 1;
    const distancia = Math.abs(price - st.ema[34]);
    const tp1 = parseFloat((price + (isBoom ? distancia * tpRatio : -distancia * tpRatio)).toFixed(4));
    const slPrice = parseFloat(st.ema[144].toFixed(4));

    const signal = {
        sym,
        type: isBoom && isBullishTrend ? 'MULTUP' : 'MULTDOWN',
        price,
        tp1,
        sl: slPrice,
        time: new Date().toLocaleTimeString(),
        status: 'PENDIENTE'
    };

    st.lastSignal = signal;
    st.signalExpired = false;
    st._trendStarted = true;
    st._tp1Hit = false;
    totalSignals++;
    lastSignalTime[sym] = Date.now();

    console.log(`🔔 ${sym}: SEÑAL ${signal.type === 'MULTUP' ? 'COMPRA' : 'VENTA'} | Entry: $${price} | TP1: $${tp1} | SL: $${slPrice}`);

    const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
    const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';
    sendTelegramMessage(
        `${emoji} <b>🐙 SEÑAL KRAKEN PRO</b>\n\n<b>Par:</b> ${signal.sym}\n<b>Dirección:</b> ${dir}\n<b>Momento:</b> 🚀 INICIO DE TENDENCIA ${isBullishTrend ? 'ALCISTA' : 'BAJISTA'}\n<b>Filtro EMA144:</b> ✅ ALINEADA\n\n<b>Entrada:</b> $${signal.price}\n<b>TP1:</b> $${signal.tp1} 🎯 (1:1)\n<b>SL (EMA144):</b> $${signal.sl} 🛑\n\n⏰ ${signal.time}`
    );
}

// ==================== ANALIZAR ====================
function analyzeTrendStart(sym) {
    if (isProcessingQueue) {
        analysisQueue.push(sym);
        return;
    }
    isProcessingQueue = true;

    try {
        const st = pairState[sym];
        if (!st || !st.loaded || st.ema[2] === null) {
            isProcessingQueue = false;
            processNextInQueue();
            return;
        }
        if (!signalsActive) {
            isProcessingQueue = false;
            processNextInQueue();
            return;
        }

        const trendStarted = detectTrendStart(sym);
        
        if (trendStarted && !st.lastSignal) {
            generateSignal(sym);
            isProcessingQueue = false;
            processNextInQueue();
            return;
        }

        if (st.lastSignal && !st.signalExpired) {
            checkSignalExpiry(sym);
        }

    } catch (e) {
        console.log(`⚠️ Error en ${sym}: ${e.message}`);
    }

    isProcessingQueue = false;
    processNextInQueue();
}

function processNextInQueue() {
    if (analysisQueue.length > 0) {
        const nextSym = analysisQueue.shift();
        analyzeTrendStart(nextSym);
    }
}

function checkSignalExpiry(sym) {
    const st = pairState[sym];
    if (!st || !st.lastSignal || st.signalExpired) return;

    const price = st.price;
    const signal = st.lastSignal;
    const isBoom = sym.includes('BOOM');

    if (!st._tp1Hit) {
        if ((isBoom && price >= signal.tp1) || (!isBoom && price <= signal.tp1)) {
            st._tp1Hit = true;
            st.signalExpired = true;
            wins++;
            console.log(`🎯 TP1 ALCANZADO en ${sym}`);
            sendTelegramMessage(`🐙 <b>${sym}</b>\n\n🎯✅ ¡TP1 ALCANZADO! 💰\n📈 Operación cerrada con éxito.\n🐙 ¡Excelente!`);
            resetPairState(sym);
            return;
        }
    }

    if (!st.signalExpired) {
        if ((isBoom && price <= signal.sl) || (!isBoom && price >= signal.sl)) {
            st.signalExpired = true;
            losses++;
            console.log(`🛑 SL ALCANZADO en ${sym}`);
            sendTelegramMessage(`🐙 <b>${sym}</b>\n\n🛑❌ ¡STOP LOSS ALCANZADO!\n📉 Operación cerrada.\n🐙 ¡Siguiente!`);
            resetPairState(sym);
            return;
        }
    }

    if (st.signalExpired) {
        resetPairState(sym);
        return;
    }
}

// ==================== WEBSOCKET ====================
function handleMsg(data) {
    if (data.error) {
        const err = data.error.message || '';
        if (!err.includes('rate limit') && !err.includes('already subscribed')) {
            console.log('❌ Error:', err);
        }
        return;
    }
    const t = data.msg_type;

    if (t === 'candles' || data.candles) {
        const sym = data.passthrough?.symbol;
        const candles = data.candles || [];
        const st = pairState[sym];
        if (!st || !candles.length) return;

        st.candles = candles.map(c => typeof c === 'object' ? parseFloat(c.close) : parseFloat(c));
        st.price = st.candles[st.candles.length - 1];
        EMA_PERIODS.forEach(period => { st.prevEma[period] = null; });
        calcEMAs(sym);
        st.loaded = true;
        st._lastCandleClose = st.price;

        dataLoaded = true;
        console.log(`📊 ${sym}: ${st.candles.length} velas cargadas (1H)`);
        return;
    }

    if (t === 'tick' || data.tick) {
        const sym = data.tick?.symbol || data.symbol;
        const st = pairState[sym];
        if (!st || !data.tick?.quote) return;

        st.price = parseFloat(data.tick.quote);

        const now = new Date();
        const minutes = now.getMinutes();
        const candleKey = `${now.getHours()}:${minutes}`;

        if (lastCandleKey[sym] && lastCandleKey[sym] !== candleKey) {
            if (!candleCloseProcessed[sym]) {
                candleCloseProcessed[sym] = true;
                EMA_PERIODS.forEach(period => { st.prevEma[period] = st.ema[period]; });
                st.candles.push(st.price);
                if (st.candles.length > 500) st.candles.shift();
                calcEMAs(sym);
                st._lastCandleClose = st.price;

                if (dataLoaded && signalsActive) {
                    analyzeTrendStart(sym);
                }
            }
        } else {
            candleCloseProcessed[sym] = false;
        }
        lastCandleKey[sym] = candleKey;
    }
}

function openWS(url) {
    if (ws) try { ws.close(); } catch (e) {}

    ws = new WebSocket(url);
    ws.onopen = () => {
        console.log('✅ Conectado a Deriv WebSocket');
        const candleCount = 100; // Menos velas para 1H
        ALL_PAIRS.forEach(p => {
            ws.send(JSON.stringify({ ticks_history: p, count: candleCount, end: 'latest', granularity: TIMEFRAME, style: 'candles', passthrough: { symbol: p } }));
            ws.send(JSON.stringify({ ticks: p, subscribe: 1 }));
        });
        setTimeout(() => {
            signalsActive = true;
            running = true;
            console.log('🚀 KRAKEN PRO ACTIVADO - 1H | TP1 = 1');
            sendTelegramMessage('🐙 KRAKEN PRO ACTIVADO\n✅ Sistema en marcha\n📊 Temporalidad: 1 HORA\n🎯 TP1 = 1 (1:1)\n📊 Monitoreando 4 símbolos');
        }, 5000);
    };
    ws.onclose = () => {
        console.log('⚠️ WebSocket cerrado');
        if (running) scheduleReconnect();
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => handleMsg(JSON.parse(e.data));
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (reconnectAttempts >= 20) { console.log('❌ Máx reintentos'); return; }
    reconnectAttempts++;
    const delay = 5000 * reconnectAttempts;
    console.log(`🔄 Reconexión ${reconnectAttempts} en ${delay/1000}s`);
    reconnectTimer = setTimeout(() => {
        if (ws?.readyState === 1) { reconnectAttempts = 0; return; }
        connectDeriv();
    }, delay);
}

async function connectDeriv() {
    console.log('🔗 Conectando a Deriv...');
    try {
        const headers = { 'Deriv-App-ID': APP_ID, 'Authorization': `Bearer ${PAT_TOKEN}`, 'Content-Type': 'application/json' };
        const accResp = await fetch(`${REST_BASE}/trading/v1/options/accounts`, { headers });
        if (!accResp.ok) throw new Error(`Error ${accResp.status}`);
        const allAccounts = (await accResp.json()).data || [];
        const account = allAccounts.find(a => a.account_type === 'demo') || allAccounts[0];
        const otpResp = await fetch(`${REST_BASE}/trading/v1/options/accounts/${account.account_id}/otp`, { method: 'POST', headers });
        if (!otpResp.ok) throw new Error('Error OTP');
        const d = await otpResp.json();
        if (!d.data?.url) throw new Error('Sin URL');
        console.log('✅ Credenciales OK, conectando WebSocket...');
        openWS(d.data.url);
    } catch (e) {
        console.log(`⚠️ Error conexión: ${e.message}`);
        scheduleReconnect();
    }
}

// ==================== INICIO AUTOMÁTICO ====================
console.log('🔄 Iniciando KRAKEN PRO - 1H | TP1 = 1...');
connectDeriv();

// ==================== SERVIDOR WEB ====================
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send(`
        <html><body style="background:#060a18;color:#00d4ff;font-family:monospace;text-align:center;padding:50px;">
        <h1>🐙 KRAKEN PRO - SIMPLIFICADO</h1>
        <p>✅ Bot activo en modo servidor</p>
        <p>📊 Temporalidad: 1 HORA</p>
        <p>🎯 TP1 = 1 (ratio 1:1)</p>
        <p>📡 Señales generadas: ${totalSignals}</p>
        <p>🎯 Aciertos: ${wins} | Fallos: ${losses}</p>
        </body></html>
    `);
});

app.get('/ping', (req, res) => {
    res.status(200).send('🐙 KRAKEN PRO - 1H ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor web en puerto ${PORT}`);
});

console.log('⏰ Bot iniciado - 1H | TP1 = 1');
