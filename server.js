const express = require('express');
const WebSocket = require('ws');
const app = express();

console.log('🐙 THE KRAKEN PRO — Deriv Edition v5.0 - 4 FILTROS');
console.log('⚡ FILTROS: FUERZA + VOLUMEN + VELA + 5min');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const ALL_PAIRS = ['BOOM1000', 'CRASH1000', 'CRASH900', 'BOOM900'];
const EMA_PERIODS = [2, 5, 13];
const TIMEFRAME = 60;
const TIMEFRAME_5MIN = 300;

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
let lastCandleKey5min = {};
let candleCloseProcessed = {};
let candleCloseProcessed5min = {};
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
        candles5min: [],
        loaded: false,
        loaded5min: false,
        lastTrend: null,
        waitingForNewTrend: false,
        lastSignal: null,
        signalExpired: false,
        _lastCandleClose: null,
        _lastCandleClose5min: null,
        _lastLogTime: 0,
        _trendStarted: false,
        _trendStartTime: null,
        _trendAge: 0,
        _tp1Hit: false,
        _partialSLLogged: false,
        _pendingEntry: false,
        _entryTaken: false,
        _force: 0,
        _volume: 0,
        _candleBody: 0
    };
    EMA_PERIODS.forEach(period => {
        pairState[p].ema[period] = null;
        pairState[p].prevEma[period] = null;
    });
    lastCandleKey[p] = null;
    lastCandleKey5min[p] = null;
    candleCloseProcessed[p] = false;
    candleCloseProcessed5min[p] = false;
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
    if (!st.candles || st.candles.length < 13) return;
    const prices = st.candles.slice();
    EMA_PERIODS.forEach(period => {
        st.ema[period] = calculateEMA(prices, period);
    });
}

function calcEMAs5min(sym) {
    const st = pairState[sym];
    if (!st.candles5min || st.candles5min.length < 13) return;
    const prices = st.candles5min.slice();
    const ema5min = {};
    EMA_PERIODS.forEach(period => {
        ema5min[period] = calculateEMA(prices, period);
    });
    return ema5min;
}

// ==================== FILTROS ====================
function calculateForce(sym) {
    const st = pairState[sym];
    if (!st || st.ema[2] === null || st.ema[13] === null) return 0;
    const ema2 = st.ema[2];
    const ema13 = st.ema[13];
    const distance = Math.abs(ema2 - ema13);
    return distance / (ema13 + 0.0001);
}

function isForceValid(sym) {
    const st = pairState[sym];
    if (!st) return false;
    const force = calculateForce(sym);
    st._force = force;
    return force >= 0.0015;
}

function hasVolume(sym) {
    const st = pairState[sym];
    if (!st || !st.candles || st.candles.length < 20) return false;
    const prices = st.candles.slice(-20);
    const avgRange = prices.reduce((sum, p, i, arr) => {
        if (i === 0) return 0;
        return sum + Math.abs(p - arr[i-1]);
    }, 0) / (prices.length - 1);
    const currentRange = st.candles.length > 1 ? 
        Math.abs(st.candles[st.candles.length - 1] - st.candles[st.candles.length - 2]) : 0;
    st._volume = currentRange / (avgRange + 0.0001);
    return st._volume > 1.2;
}

function hasStrongCandle(sym) {
    const st = pairState[sym];
    if (!st || !st.candles || st.candles.length < 20) return false;
    const prices = st.candles.slice(-20);
    const avgBody = prices.reduce((sum, p, i, arr) => {
        if (i === 0) return 0;
        return sum + Math.abs(p - arr[i-1]);
    }, 0) / (prices.length - 1);
    const currentBody = st.candles.length > 1 ? 
        Math.abs(st.candles[st.candles.length - 1] - st.candles[st.candles.length - 2]) : 0;
    st._candleBody = currentBody / (avgBody + 0.0001);
    return st._candleBody > 1.8;
}

function checkMultiTimeframe(sym) {
    const st = pairState[sym];
    if (!st || !st.candles5min || st.candles5min.length < 13) return true;
    const ema5min = calcEMAs5min(sym);
    if (!ema5min || ema5min[2] === null) return true;
    const isBullish5min = ema5min[2] > ema5min[5] && ema5min[5] > ema5min[13];
    const isBearish5min = ema5min[2] < ema5min[5] && ema5min[5] < ema5min[13];
    const isBullish1min = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13];
    const isBearish1min = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13];
    if (isBullish1min && !isBullish5min) return false;
    if (isBearish1min && !isBearish5min) return false;
    return true;
}

// ==================== DETECTAR TENDENCIA ====================
function detectTrendStart(sym) {
    const st = pairState[sym];
    if (!st || st.ema[2] === null || st.ema[5] === null || st.ema[13] === null) return false;

    const isBoom = sym.includes('BOOM');
    const isBullish = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13];
    const isBearish = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13];

    if (!isBullish && !isBearish) {
        st._pendingEntry = false;
        return false;
    }

    if (!isForceValid(sym)) { st._pendingEntry = true; return false; }
    if (!hasVolume(sym)) { st._pendingEntry = true; return false; }
    if (!hasStrongCandle(sym)) { st._pendingEntry = true; return false; }
    if (!checkMultiTimeframe(sym)) { st._pendingEntry = true; return false; }

    const prevEma2 = st.prevEma[2];
    const prevEma5 = st.prevEma[5];
    const prevEma13 = st.prevEma[13];

    if (prevEma2 === null || prevEma5 === null || prevEma13 === null) return false;

    const ema2CrossedAbove5 = (prevEma2 <= prevEma5) && (st.ema[2] > st.ema[5]);
    const ema5CrossedAbove13 = (prevEma5 <= prevEma13) && (st.ema[5] > st.ema[13]);
    const ema2CrossedBelow5 = (prevEma2 >= prevEma5) && (st.ema[2] < st.ema[5]);
    const ema5CrossedBelow13 = (prevEma5 >= prevEma13) && (st.ema[5] < st.ema[13]);

    if (isBoom && ema2CrossedAbove5 && ema5CrossedAbove13) {
        st._pendingEntry = false; return true;
    }
    if (!isBoom && ema2CrossedBelow5 && ema5CrossedBelow13) {
        st._pendingEntry = false; return true;
    }

    if (!st._trendStarted && !st.lastSignal) {
        const prevBullish = prevEma2 > prevEma5 && prevEma5 > prevEma13;
        const prevBearish = prevEma2 < prevEma5 && prevEma5 < prevEma13;
        if (isBoom && isBullish && prevBullish) { return true; }
        if (!isBoom && isBearish && prevBearish) { return true; }
    }
    return false;
}

// ==================== GENERAR SEÑAL ====================
function generateSignal(sym) {
    const st = pairState[sym];
    if (!st || st.lastSignal && !st.signalExpired) return;

    const isBoom = sym.includes('BOOM');
    const price = st.price;
    const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13];
    const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13];

    if (!isBullishTrend && !isBearishTrend) return;

    const distancia = Math.abs(st.ema[2] - st.ema[13]);
    const tp1 = parseFloat((price + (isBoom ? distancia : -distancia)).toFixed(4));
    const slPrice = parseFloat((price - (isBoom ? distancia : -distancia)).toFixed(4));

    const signal = {
        sym,
        type: isBoom && isBullishTrend ? 'MULTUP' : 'MULTDOWN',
        price,
        tp1,
        sl: slPrice,
        time: new Date().toLocaleTimeString(),
        status: 'PENDIENTE',
        force: st._force,
        volume: st._volume,
        candleBody: st._candleBody
    };

    st.lastSignal = signal;
    st.signalExpired = false;
    st._trendStarted = true;
    st._tp1Hit = false;
    totalSignals++;
    lastSignalTime[sym] = Date.now();

    const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
    const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';
    const forcePct = (st._force * 10000).toFixed(2);
    const volPct = (st._volume * 100).toFixed(0);
    const bodyPct = (st._candleBody * 100).toFixed(0);
    
    sendTelegramMessage(
        `${emoji} <b>🐙 SEÑAL KRAKEN PRO</b>\n\n<b>Par:</b> ${signal.sym}\n<b>Dirección:</b> ${dir}\n<b>Momento:</b> 🚀 INICIO DE TENDENCIA ${isBullishTrend ? 'ALCISTA' : 'BAJISTA'}\n<b>Filtros:</b> ✅ FUERZA ✅ VOLUMEN ✅ VELA ✅ 5min\n\n<b>Entrada:</b> $${signal.price}\n<b>TP1:</b> $${signal.tp1} 🎯\n<b>SL:</b> $${signal.sl} 🛑\n<b>Fuerza:</b> ${forcePct}%\n<b>Volumen:</b> ${volPct}%\n<b>Cuerpo:</b> ${bodyPct}%\n\n⏰ ${signal.time}`
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
        if (!st || st.ema[2] === null) {
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
            const timeSinceLastSignal = Date.now() - lastSignalTime[sym];
            if (timeSinceLastSignal < 30000) {
                isProcessingQueue = false;
                processNextInQueue();
                return;
            }
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
            sendTelegramMessage(`🐙 <b>${sym}</b>\n\n🎯✅ ¡TP1 ALCANZADO! 💰\n📈 Operación cerrada.\n🐙 ¡Excelente!`);
            resetPairState(sym);
            return;
        }
    }

    if (!st.signalExpired) {
        if ((isBoom && price <= signal.sl) || (!isBoom && price >= signal.sl)) {
            st.signalExpired = true;
            losses++;
            console.log(`🛑 SL ALCANZADO en ${sym}`);
            sendTelegramMessage(`🐙 <b>${sym}</b>\n\n🛑❌ ¡SL ALCANZADO!\n📉 Operación cerrada.\n🐙 ¡Siguiente!`);
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

        const granularity = data.granularity || 60;
        
        if (granularity === TIMEFRAME) {
            st.candles = candles.map(c => typeof c === 'object' ? parseFloat(c.close) : parseFloat(c));
            st.price = st.candles[st.candles.length - 1];
            EMA_PERIODS.forEach(period => { st.prevEma[period] = null; });
            calcEMAs(sym);
            st.loaded = true;
            st._lastCandleClose = st.price;
            dataLoaded = true;
            console.log(`📊 ${sym}: ${st.candles.length} velas 1min cargadas`);
        } else if (granularity === TIMEFRAME_5MIN) {
            st.candles5min = candles.map(c => typeof c === 'object' ? parseFloat(c.close) : parseFloat(c));
            st.loaded5min = true;
            st._lastCandleClose5min = st.candles5min[st.candles5min.length - 1];
            console.log(`📊 ${sym}: ${st.candles5min.length} velas 5min cargadas`);
        }
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
        const candleKey5min = `${now.getHours()}:${Math.floor(minutes / 5) * 5}`;

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

        if (lastCandleKey5min[sym] && lastCandleKey5min[sym] !== candleKey5min) {
            if (!candleCloseProcessed5min[sym]) {
                candleCloseProcessed5min[sym] = true;
                st.candles5min.push(st.price);
                if (st.candles5min.length > 200) st.candles5min.shift();
                st._lastCandleClose5min = st.price;
            }
        } else {
            candleCloseProcessed5min[sym] = false;
        }
        lastCandleKey5min[sym] = candleKey5min;
    }
}

function openWS(url) {
    if (ws) try { ws.close(); } catch (e) {}

    ws = new WebSocket(url);
    ws.onopen = () => {
        console.log('✅ Conectado a Deriv WebSocket');
        const candleCount = 500;
        ALL_PAIRS.forEach(p => {
            ws.send(JSON.stringify({ ticks_history: p, count: candleCount, end: 'latest', granularity: TIMEFRAME, style: 'candles', passthrough: { symbol: p } }));
            ws.send(JSON.stringify({ ticks_history: p, count: 100, end: 'latest', granularity: TIMEFRAME_5MIN, style: 'candles', passthrough: { symbol: p } }));
            ws.send(JSON.stringify({ ticks: p, subscribe: 1 }));
        });
        setTimeout(() => {
            signalsActive = true;
            running = true;
            console.log('🚀 KRAKEN PRO - SEÑALES ACTIVADAS (4 FILTROS)');
            sendTelegramMessage('🐙 KRAKEN PRO ACTIVADO\n✅ FILTROS: FUERZA + VOLUMEN + VELA + 5min\n✅ Monitoreando 4 símbolos');
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
        const account = allAccounts.find(a => a.account_type === 'real') || allAccounts[0];
        const otpResp = await fetch(`${REST_BASE}/trading/v1/options/accounts/${account.account_id}/otp`, { method: 'POST', headers });
        if (!otpResp.ok) throw new Error('Error OTP');
        const d = await otpResp.json();
        if (!d.data?.url) throw new Error('Sin URL');
        console.log(`✅ Credenciales OK, conectando WebSocket... (${account.account_type.toUpperCase()})`);
        openWS(d.data.url);
    } catch (e) {
        console.log(`⚠️ Error conexión: ${e.message}`);
        scheduleReconnect();
    }
}

// ==================== INICIO AUTOMÁTICO ====================
console.log('🔄 Iniciando KRAKEN PRO con 4 filtros...');
connectDeriv();

// ==================== SERVIDOR WEB ====================
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send(`
        <html><body style="background:#060a18;color:#00d4ff;font-family:monospace;text-align:center;padding:50px;">
        <h1>🐙 KRAKEN PRO</h1>
        <p>✅ 4 FILTROS: FUERZA + VOLUMEN + VELA + 5min</p>
        <p>📡 Señales generadas: ${totalSignals}</p>
        <p>🎯 Aciertos: ${wins} | Fallos: ${losses}</p>
        <p style="color:#10b981;">🚀 Funcionando automáticamente</p>
        </body></html>
    `);
});

app.get('/ping', (req, res) => {
    res.status(200).send('🐙 KRAKEN PRO - Activo ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor web en puerto ${PORT}`);
});

console.log('⏰ Bot iniciado - 4 FILTROS ACTIVADOS');
