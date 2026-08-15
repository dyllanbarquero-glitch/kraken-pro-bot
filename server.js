const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🐙 KRAKEN PRO - VALIDACIÓN 1-2-3');
console.log('📊 IMPULSO → RETROCESO → IMPULSO QUE SUPERA → RETESTEO');

const REST_BASE = 'https://api.derivws.com';
const ALL_PAIRS = ['BOOM1000', 'CRASH1000', 'CRASH900', 'BOOM900'];
const TIMEFRAME = 300;

const APP_ID = '33A0UhDa0Wa1FkvF9zlKh';
const PAT_TOKEN = 'pat_3ee3edc2b80c8daea41968ea5d8205df7f75f187d17f17175d3eb863acb82d23';
const TELEGRAM_TOKEN = '8345003490:AAGhSXXzdltZ5dS2Civ4l0ld0dXJScQbsBo';
const TELEGRAM_CHAT = '-1003177595391';

let ws = null;
let signalsActive = false;
let running = false;
let totalSignals = 0;
let wins = 0;
let losses = 0;
let pairState = {};
let tradeLogs = [];
let botStats = { 
    balance: 0, 
    totalProfit: 0, 
    winCount: 0, 
    lossCount: 0, 
    totalTrades: 0,
    totalPipsGained: 0,
    totalPipsLost: 0,
    netPips: 0
};
let reconnectAttempts = 0;
let reconnectTimer = null;
let lastCandleKey = {};
let candleCloseProcessed = {};
let dataLoaded = false;
let analysisQueue = [];
let isProcessingQueue = false;
let lastSignalTime = {};
let activationSent = false;

ALL_PAIRS.forEach(p => {
    pairState[p] = {
        price: null, candles: [], loaded: false,
        lastSignal: null, signalExpired: false,
        _lastCandleClose: null, _lastLogTime: 0,
        _tp1Hit: false,
        _entryPrice: null,
        _tpPrice: null,
        _slPrice: null,
        _pips: 0,
        _isWin: false,
        // 🎯 Validación 1-2-3
        _structure: {
            step: 0,              // 0=esperando, 1=impulso1, 2=retroceso, 3=impulso2, 4=retesteo
            impulse1: null,       // Precio del primer impulso
            retracement: null,    // Precio del retroceso
            impulse2: null,       // Precio del segundo impulso
            trend: null,          // 'bullish' o 'bearish'
            impulse1High: null,
            impulse1Low: null,
            retracementHigh: null,
            retracementLow: null,
            impulse2High: null,
            impulse2Low: null,
            confirmed: false,
            retestZone: null,
            retestDetected: false
        }
    };
    lastCandleKey[p] = null;
    candleCloseProcessed[p] = false;
    lastSignalTime[p] = 0;
});

function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    tradeLogs.unshift({ time, msg, type });
    if (tradeLogs.length > 200) tradeLogs.pop();
    console.log(`[${time}] ${msg}`);
}

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
            console.log('📨 Mensaje enviado a Telegram ✅');
            return true;
        }
        return false;
    } catch (error) {
        console.log('❌ Error Telegram:', error.message);
        return false;
    }
}

// 🎯 DETECTAR VALIDACIÓN 1-2-3
function detectStructure123(sym) {
    const st = pairState[sym];
    if (!st || st.candles.length < 20) return;

    const candles = st.candles;
    const lookback = Math.min(30, candles.length - 5);
    const start = candles.length - lookback - 5;
    const end = candles.length - 2;

    let highs = [];
    let lows = [];
    
    for (let i = start; i < end; i++) {
        const price = candles[i];
        const prev = candles[i - 1] || price;
        const next = candles[i + 1] || price;
        const prev2 = candles[i - 2] || price;
        const next2 = candles[i + 2] || price;

        if (price > prev && price > next && price > prev2 && price > next2) {
            highs.push({ price: price, index: i });
        }
        if (price < prev && price < next && price < prev2 && price < next2) {
            lows.push({ price: price, index: i });
        }
    }

    // 🎯 Buscar patrón 1-2-3
    if (highs.length >= 2 && lows.length >= 2) {
        const lastHigh = highs[highs.length - 1];
        const prevHigh = highs[highs.length - 2];
        const lastLow = lows[lows.length - 1];
        const prevLow = lows[lows.length - 2];

        // 📈 ESTRUCTURA ALCISTA: 
        // Impulso1 (prevLow) → Retroceso (prevHigh) → Impulso2 (lastLow) que supera a Impulso1
        const isBullish = lastLow.price < prevLow.price && lastHigh.price > prevHigh.price;

        // 📉 ESTRUCTURA BAJISTA:
        // Impulso1 (prevHigh) → Retroceso (prevLow) → Impulso2 (lastHigh) que supera a Impulso1
        const isBearish = lastHigh.price > prevHigh.price && lastLow.price < prevLow.price;

        // 📈 ALCISTA: Impulso1 (baja) → Retroceso (sube) → Impulso2 (baja más)
        if (isBullish) {
            st._structure.trend = 'bullish';
            st._structure.impulse1 = prevLow.price;
            st._structure.retracement = prevHigh.price;
            st._structure.impulse2 = lastLow.price;
            st._structure.impulse1Low = prevLow.price;
            st._structure.retracementHigh = prevHigh.price;
            st._structure.impulse2Low = lastLow.price;
            st._structure.step = 3;
            st._structure.confirmed = true;
            st._structure.retestZone = prevLow.price + (prevHigh.price - prevLow.price) * 0.5;
            
            if (st._structure.step === 3) {
                addLog(`📈 ${sym}: VALIDACIÓN 1-2-3 ALCISTA | Impulso1: $${prevLow.price.toFixed(4)} | Retroceso: $${prevHigh.price.toFixed(4)} | Impulso2: $${lastLow.price.toFixed(4)} ✅ SUPERA`, 'trend');
            }
        } 
        // 📉 BAJISTA: Impulso1 (sube) → Retroceso (baja) → Impulso2 (sube más)
        else if (isBearish) {
            st._structure.trend = 'bearish';
            st._structure.impulse1 = prevHigh.price;
            st._structure.retracement = prevLow.price;
            st._structure.impulse2 = lastHigh.price;
            st._structure.impulse1High = prevHigh.price;
            st._structure.retracementLow = prevLow.price;
            st._structure.impulse2High = lastHigh.price;
            st._structure.step = 3;
            st._structure.confirmed = true;
            st._structure.retestZone = prevHigh.price - (prevHigh.price - prevLow.price) * 0.5;
            
            if (st._structure.step === 3) {
                addLog(`📉 ${sym}: VALIDACIÓN 1-2-3 BAJISTA | Impulso1: $${prevHigh.price.toFixed(4)} | Retroceso: $${prevLow.price.toFixed(4)} | Impulso2: $${lastHigh.price.toFixed(4)} ✅ SUPERA`, 'trend');
            }
        }
    }
}

// 🎯 DETECTAR RETESTEO (entrada en la zona de retroceso)
function detectRetest(sym) {
    const st = pairState[sym];
    if (!st || !st._structure.confirmed) return false;

    const price = st.price;
    const structure = st._structure;
    const tolerance = 0.005; // 0.5% de tolerancia

    if (structure.trend === 'bullish') {
        // En tendencia alcista, el retesteo es en la zona del retroceso (cerca del máximo del retroceso)
        const retestZone = structure.retracement;
        const isNearRetest = Math.abs(price - retestZone) / retestZone < tolerance;
        const isAbove = price > structure.impulse1; // Precio por encima del impulso1 (soporte)
        
        if (isNearRetest && isAbove) {
            structure.retestDetected = true;
            structure.step = 4;
            addLog(`🔄 ${sym}: RETESTEO CONFIRMADO en $${price.toFixed(4)} (zona de retroceso)`, 'trend');
            return true;
        }
    }

    if (structure.trend === 'bearish') {
        // En tendencia bajista, el retesteo es en la zona del retroceso (cerca del mínimo del retroceso)
        const retestZone = structure.retracement;
        const isNearRetest = Math.abs(price - retestZone) / retestZone < tolerance;
        const isBelow = price < structure.impulse1; // Precio por debajo del impulso1 (resistencia)
        
        if (isNearRetest && isBelow) {
            structure.retestDetected = true;
            structure.step = 4;
            addLog(`🔄 ${sym}: RETESTEO CONFIRMADO en $${price.toFixed(4)} (zona de retroceso)`, 'trend');
            return true;
        }
    }

    return false;
}

function calculatePips(price1, price2) {
    return parseFloat((Math.abs(price2 - price1) * 10000).toFixed(2));
}

// 🎯 GENERAR SEÑAL EN RETESTEO
function generateSignal(sym) {
    const st = pairState[sym];
    if (!st || st.lastSignal && !st.signalExpired) return;

    if (st.lastSignal) {
        addLog(`⏳ ${sym}: Ya hay operación activa`, 'info');
        return;
    }

    const isBoom = sym.includes('BOOM');
    const price = st.price;
    const structure = st._structure;

    // ✅ Validación completa: Estructura 1-2-3 confirmada + Retesteo detectado
    if (!structure.confirmed || !structure.retestDetected) return;

    // 🔴 BOOM solo COMPRAS en estructura ALCISTA
    // 🔵 CRASH solo VENTAS en estructura BAJISTA
    let condition = false;
    let srType = '';
    let srPrice = 0;

    if (isBoom && structure.trend === 'bullish') {
        condition = true;
        srType = 'RETESTEO (zona de retroceso)';
        srPrice = structure.retracement;
    }

    if (!isBoom && structure.trend === 'bearish') {
        condition = true;
        srType = 'RETESTEO (zona de retroceso)';
        srPrice = structure.retracement;
    }

    if (!condition) return;

    // 🎯 SL y TP basados en la estructura
    let slPrice, tp, risk;
    
    if (isBoom) {
        // COMPRA: SL debajo del impulso1 (soporte)
        slPrice = parseFloat((structure.impulse1 * 0.998).toFixed(4));
        risk = Math.abs(price - slPrice);
        tp = parseFloat((price + risk).toFixed(4));
    } else {
        // VENTA: SL arriba del impulso1 (resistencia)
        slPrice = parseFloat((structure.impulse1 * 1.002).toFixed(4));
        risk = Math.abs(price - slPrice);
        tp = parseFloat((price - risk).toFixed(4));
    }

    const pips = calculatePips(price, tp);
    const trendEmoji = structure.trend === 'bullish' ? '📈' : '📉';

    const signal = {
        sym,
        type: isBoom ? 'MULTUP' : 'MULTDOWN',
        price,
        tp,
        sl: slPrice,
        time: new Date().toLocaleTimeString(),
        status: 'PENDIENTE',
        trend: structure.trend || 'N/A',
        impulse1: structure.impulse1,
        retracement: structure.retracement,
        impulse2: structure.impulse2,
        pips: pips,
        srType: srType,
        srPrice: srPrice
    };

    st.lastSignal = signal;
    st.signalExpired = false;
    st._tp1Hit = false;
    st._entryPrice = price;
    st._tpPrice = tp;
    st._slPrice = slPrice;
    totalSignals++;
    lastSignalTime[sym] = Date.now();

    const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
    const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';

    const msg =
        `${emoji} 🐙 KRAKEN PRO - VALIDACIÓN 1-2-3\n\n` +
        `<b>Par:</b> ${signal.sym}\n` +
        `<b>Dirección:</b> ${dir}\n` +
        `<b>Estructura:</b> ${trendEmoji} ${signal.trend.toUpperCase()}\n` +
        `<b>1️⃣ Impulso 1:</b> $${signal.impulse1.toFixed(4)}\n` +
        `<b>2️⃣ Retroceso:</b> $${signal.retracement.toFixed(4)}\n` +
        `<b>3️⃣ Impulso 2:</b> $${signal.impulse2.toFixed(4)} ✅ SUPERA\n` +
        `<b>🔄 Retesteo:</b> $${signal.price.toFixed(4)}\n\n` +
        `<b>Entrada:</b> $${signal.price}\n` +
        `<b>TP:</b> $${signal.tp} 🎯 (${signal.pips} pips)\n` +
        `<b>SL:</b> $${signal.sl} 🛑\n\n` +
        `⏰ ${signal.time}`;

    addLog(`🔔 ${sym}: ${dir} | 1-2-3 ${signal.trend} | Retesteo: $${price} | Pips: ${signal.pips}`, 'signal');
    sendTelegramMessage(msg);
}

function analyzeTrendStart(sym) {
    if (isProcessingQueue) { analysisQueue.push(sym); return; }
    isProcessingQueue = true;

    try {
        const st = pairState[sym];
        if (!st || st.candles.length < 20) { isProcessingQueue = false; processNextInQueue(); return; }
        if (!signalsActive) { isProcessingQueue = false; processNextInQueue(); return; }

        // 🎯 DETECTAR VALIDACIÓN 1-2-3
        detectStructure123(sym);

        // 🎯 DETECTAR RETESTEO
        if (st._structure.confirmed) {
            detectRetest(sym);
        }

        if (st.lastSignal && !st.signalExpired) {
            checkSignalExpiry(sym);
            isProcessingQueue = false; processNextInQueue(); return;
        }

        const timeSinceLast = Date.now() - lastSignalTime[sym];
        if (timeSinceLast < 300000) {
            isProcessingQueue = false; processNextInQueue(); return;
        }

        generateSignal(sym);

    } catch (e) { addLog(`⚠️ Error en ${sym}: ${e.message}`, 'error'); }

    isProcessingQueue = false; processNextInQueue();
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
    const sl = st._slPrice || signal.sl;
    const tp = st._tpPrice || signal.tp;
    const entry = st._entryPrice || signal.price;

    if (!st._tp1Hit) {
        if ((isBoom && price >= tp) || (!isBoom && price <= tp)) {
            st._tp1Hit = true;
            st.signalExpired = true;
            wins++;
            const pips = calculatePips(entry, price);
            botStats.totalPipsGained += pips;
            botStats.netPips += pips;
            botStats.totalTrades++;
            st._pips = pips;
            st._isWin = true;
            addLog(`🎯 TP ALCANZADO en ${sym} | +${pips} pips`, 'success');
            const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
            const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';
            sendTelegramMessage(
                `${emoji} 🐙 KRAKEN PRO\n\n` +
                `<b>Par:</b> ${sym}\n` +
                `<b>Dirección:</b> ${dir}\n` +
                `✅ TP ALCANZADO 🎯\n` +
                `<b>Pips:</b> +${pips} 📈\n\n` +
                `⏰ ${new Date().toLocaleTimeString()}`
            );
            resetPairState(sym);
            return;
        }
    }

    if (!st.signalExpired) {
        if ((isBoom && price <= sl) || (!isBoom && price >= sl)) {
            st.signalExpired = true;
            losses++;
            const pips = calculatePips(entry, price);
            botStats.totalPipsLost += pips;
            botStats.netPips -= pips;
            botStats.totalTrades++;
            st._pips = -pips;
            st._isWin = false;
            addLog(`❌ SL ALCANZADO en ${sym} | -${pips} pips`, 'error');
            const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
            const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';
            sendTelegramMessage(
                `${emoji} 🐙 KRAKEN PRO\n\n` +
                `<b>Par:</b> ${sym}\n` +
                `<b>Dirección:</b> ${dir}\n` +
                `❌ SL ALCANZADO 🛑\n` +
                `<b>Pips:</b> -${pips} 📉\n\n` +
                `⏰ ${new Date().toLocaleTimeString()}`
            );
            resetPairState(sym);
            return;
        }
    }
}

function resetPairState(sym) {
    const st = pairState[sym];
    if (!st) return;
    st.lastSignal = null;
    st.signalExpired = false;
    st._tp1Hit = false;
    st._entryPrice = null;
    st._tpPrice = null;
    st._slPrice = null;
    st._pips = 0;
    st._isWin = false;
    // Resetear estructura para nueva validación 1-2-3
    st._structure.step = 0;
    st._structure.confirmed = false;
    st._structure.retestDetected = false;
    st._structure.impulse1 = null;
    st._structure.retracement = null;
    st._structure.impulse2 = null;
    st._structure.trend = null;
}

function handleMsg(data) {
    if (data.error) {
        const err = data.error.message || '';
        if (!err.includes('rate limit') && !err.includes('already subscribed')) {
            addLog(`❌ Error: ${err}`, 'error');
        }
        return;
    }
    const t = data.msg_type;

    if (t === 'balance' || data.balance) {
        const bal = data.balance?.balance || data.balance;
        if (bal && typeof bal === 'number') { botStats.balance = parseFloat(bal); }
        return;
    }

    if (t === 'candles' || data.candles) {
        const sym = data.passthrough?.symbol;
        const candles = data.candles || [];
        const st = pairState[sym];
        if (!st || !candles.length) return;

        st.candles = candles.map(c => typeof c === 'object' ? parseFloat(c.close) : parseFloat(c));
        st.price = st.candles[st.candles.length - 1];
        st._lastCandleClose = st.price;
        st.loaded = true;
        dataLoaded = true;
        addLog(`📊 ${sym}: ${st.candles.length} velas cargadas`, 'info');
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
                st.candles.push(st.price);
                if (st.candles.length > 500) st.candles.shift();
                st._lastCandleClose = st.price;
                if (dataLoaded && signalsActive) { analyzeTrendStart(sym); }
                if (st.lastSignal && !st.signalExpired) {
                    checkSignalExpiry(sym);
                }
            }
        } else { candleCloseProcessed[sym] = false; }
        lastCandleKey[sym] = candleKey;
    }
}

function openWS(url) {
    if (ws) try { ws.close(); } catch (e) {}

    ws = new WebSocket(url);
    ws.onopen = () => {
        addLog('✅ Conectado a Deriv WebSocket', 'success');
        ALL_PAIRS.forEach(p => {
            ws.send(JSON.stringify({ ticks_history: p, count: 500, end: 'latest', granularity: TIMEFRAME, style: 'candles', passthrough: { symbol: p } }));
            ws.send(JSON.stringify({ ticks: p, subscribe: 1 }));
        });
        setTimeout(() => {
            signalsActive = true;
            running = true;
            addLog(`🚀 KRAKEN PRO - SEÑALES ACTIVADAS (VALIDACIÓN 1-2-3)`, 'start');
            if (!activationSent) {
                activationSent = true;
                sendTelegramMessage(`🐙 KRAKEN PRO ACTIVADO\n\n✅ Sistema en marcha\n📡 Monitoreando ${ALL_PAIRS.length} símbolos\n🎯 VALIDACIÓN 1-2-3\n📊 Impulso → Retroceso → Impulso que SUPERA\n🔄 Entrada en RETESTEO\n🔴 BOOM: Estructura ALCISTA → COMPRA\n🔵 CRASH: Estructura BAJISTA → VENTA\n⏰ ${new Date().toLocaleString()}`);
            }
        }, 5000);
    };
    ws.onclose = () => {
        addLog('⚠️ WebSocket cerrado', 'warn');
        activationSent = false;
        if (running) scheduleReconnect();
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => handleMsg(JSON.parse(e.data));
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (reconnectAttempts >= 20) { addLog('❌ Máx reintentos', 'error'); return; }
    reconnectAttempts++;
    const delay = 5000 * reconnectAttempts;
    addLog(`🔄 Reconexión ${reconnectAttempts} en ${delay/1000}s`, 'warn');
    reconnectTimer = setTimeout(() => {
        if (ws?.readyState === 1) { reconnectAttempts = 0; return; }
        connectDeriv();
    }, delay);
}

async function connectDeriv() {
    addLog('🔗 Conectando a Deriv...', 'info');
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
        addLog(`✅ Cuenta: ${account.account_id} (${account.account_type.toUpperCase()})`, 'success');
        openWS(d.data.url);
    } catch (e) {
        addLog(`⚠️ Error conexión: ${e.message}`, 'error');
        scheduleReconnect();
    }
}

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/api/stats', (req, res) => {
    res.json({
        balance: botStats.balance,
        totalProfit: botStats.totalProfit,
        winCount: botStats.winCount,
        lossCount: botStats.lossCount,
        totalTrades: botStats.totalTrades,
        totalSignals: totalSignals,
        wins: wins,
        losses: losses,
        totalPipsGained: botStats.totalPipsGained,
        totalPipsLost: botStats.totalPipsLost,
        netPips: botStats.netPips,
        logs: tradeLogs.slice(0, 50)
    });
});

app.get('/ping', (req, res) => {
    res.status(200).send('🐙 KRAKEN PRO - Activo ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor web en puerto ${PORT}`);
    console.log(`🔗 https://kraken-pro-bot-production.up.railway.app`);
});

console.log('⏰ KRAKEN PRO - 24/7 ACTIVO');
console.log('🎯 VALIDACIÓN 1-2-3 + RETESTEO');

addLog('🎯 Iniciando KRAKEN PRO con VALIDACIÓN 1-2-3...', 'info');

setTimeout(() => {
    sendTelegramMessage(`🐙 KRAKEN PRO INICIADO\n\n🔄 Conectando a Deriv...\n⏳ El bot se activará automáticamente\n📡 ${ALL_PAIRS.length} símbolos\n🎯 VALIDACIÓN 1-2-3\n📊 Impulso → Retroceso → Impulso que SUPERA\n🔄 Entrada en RETESTEO\n⏰ ${new Date().toLocaleString()}`);
}, 3000);

connectDeriv();
