const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🐙 KRAKEN PRO - ESTRUCTURA DE MERCADO');
console.log('📊 IMPULSO + RETROCESO (AMBAS DIRECCIONES)');

const REST_BASE = 'https://api.derivws.com';
const ALL_PAIRS = ['BOOM1000', 'CRASH1000', 'CRASH900', 'BOOM900'];
const EMA_PERIODS = [2, 5, 13, 34];
const TIMEFRAME = 60;

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

let activeTrend = {};

ALL_PAIRS.forEach(p => {
    pairState[p] = {
        price: null, ema: {}, prevEma: {}, candles: [], loaded: false,
        lastTrend: null, waitingForNewTrend: false, lastSignal: null,
        signalExpired: false, _lastCandleClose: null, _lastLogTime: 0,
        _trendStarted: false, _tp1Hit: false, 
        _entryPrice: null,
        _tpPrice: null,
        _slPrice: null,
        _support: null,
        _resistance: null,
        _supportCount: 0,
        _resistanceCount: 0,
        _pips: 0,
        _isWin: false,
        _structure: {
            impulse: null,
            retracement: null,
            trend: null,
            lastImpulseHigh: null,
            lastImpulseLow: null,
            lastRetracementHigh: null,
            lastRetracementLow: null,
            impulseCount: 0,
            structureConfirmed: false,
            lastImpulseDirection: null // 'up' o 'down'
        }
    };
    activeTrend[p] = null;
    EMA_PERIODS.forEach(period => {
        pairState[p].ema[period] = null;
        pairState[p].prevEma[period] = null;
    });
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
    if (!st.candles || st.candles.length < 34) return;
    const prices = st.candles.slice();
    EMA_PERIODS.forEach(period => {
        st.ema[period] = calculateEMA(prices, period);
    });
}

// 🎯 DETECTAR ESTRUCTURA DE MERCADO (IMPULSO + RETROCESO)
function detectMarketStructure(sym) {
    const st = pairState[sym];
    if (!st || st.candles.length < 10) return;

    const candles = st.candles;
    const lookback = Math.min(20, candles.length - 5);
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

    if (highs.length >= 2 && lows.length >= 2) {
        const lastHigh = highs[highs.length - 1];
        const prevHigh = highs[highs.length - 2];
        const lastLow = lows[lows.length - 1];
        const prevLow = lows[lows.length - 2];

        // 🎯 ESTRUCTURA ALCISTA: cada impulso supera al anterior (subiendo)
        const isBullish = lastHigh.price > prevHigh.price && lastLow.price > prevLow.price;
        
        // 🎯 ESTRUCTURA BAJISTA: cada impulso supera al anterior (bajando)
        const isBearish = lastHigh.price < prevHigh.price && lastLow.price < prevLow.price;

        if (isBullish) {
            st._structure.trend = 'bullish';
            st._structure.lastImpulseHigh = lastHigh.price;
            st._structure.lastRetracementLow = lastLow.price;
            st._structure.structureConfirmed = true;
            st._structure.lastImpulseDirection = 'up';
            if (activeTrend[sym] !== 'bullish') {
                activeTrend[sym] = 'bullish';
                addLog(`📈 ${sym}: ESTRUCTURA ALCISTA | Impulso sube: $${lastHigh.price.toFixed(4)} | Retroceso: $${lastLow.price.toFixed(4)}`, 'trend');
            }
        } else if (isBearish) {
            st._structure.trend = 'bearish';
            st._structure.lastImpulseLow = lastLow.price;
            st._structure.lastRetracementHigh = lastHigh.price;
            st._structure.structureConfirmed = true;
            st._structure.lastImpulseDirection = 'down';
            if (activeTrend[sym] !== 'bearish') {
                activeTrend[sym] = 'bearish';
                addLog(`📉 ${sym}: ESTRUCTURA BAJISTA | Impulso baja: $${lastLow.price.toFixed(4)} | Retroceso: $${lastHigh.price.toFixed(4)}`, 'trend');
            }
        }
    }
}

// 🎯 DETECTAR SOPORTE (piso) Y RESISTENCIA (techo)
function detectSR(sym) {
    const st = pairState[sym];
    if (!st || st.candles.length < 20) return;

    const candles = st.candles;
    const lookback = Math.min(20, candles.length - 5);
    const start = candles.length - lookback - 5;
    const end = candles.length - 2;

    let support = null;
    let resistance = null;
    let supportCount = 0;
    let resistanceCount = 0;

    for (let i = start; i < end; i++) {
        const price = candles[i];
        const prev = candles[i - 1] || price;
        const next = candles[i + 1] || price;

        if (price < prev && price < next && price < candles[i - 2] && price < candles[i + 2]) {
            if (support === null || Math.abs(price - support) / support < 0.005) {
                support = support !== null ? (support + price) / 2 : price;
                supportCount++;
            } else if (price < support) {
                support = price;
                supportCount = 1;
            }
        }

        if (price > prev && price > next && price > candles[i - 2] && price > candles[i + 2]) {
            if (resistance === null || Math.abs(price - resistance) / resistance < 0.005) {
                resistance = resistance !== null ? (resistance + price) / 2 : price;
                resistanceCount++;
            } else if (price > resistance) {
                resistance = price;
                resistanceCount = 1;
            }
        }
    }

    st._support = support;
    st._resistance = resistance;
    st._supportCount = supportCount;
    st._resistanceCount = resistanceCount;

    if (support && supportCount >= 2) {
        addLog(`📊 ${sym}: SOPORTE (piso) en $${support.toFixed(4)} (${supportCount} toques)`, 'trend');
    }
    if (resistance && resistanceCount >= 2) {
        addLog(`📊 ${sym}: RESISTENCIA (techo) en $${resistance.toFixed(4)} (${resistanceCount} toques)`, 'trend');
    }
}

function calculatePips(price1, price2) {
    return parseFloat((Math.abs(price2 - price1) * 10000).toFixed(2));
}

// 🎯 GENERAR SEÑAL (1 por tendencia)
function generateSignal(sym) {
    const st = pairState[sym];
    if (!st || st.lastSignal && !st.signalExpired) return;

    // ✅ Solo 1 operación por tendencia
    if (st.lastSignal) {
        addLog(`⏳ ${sym}: Ya hay operación activa en esta tendencia`, 'info');
        return;
    }

    const isBoom = sym.includes('BOOM');
    const price = st.price;
    const isBullish = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
    const isBearish = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];

    // ✅ BOOM → SOPORTE + ESTRUCTURA ALCISTA → COMPRA
    // ✅ CRASH → RESISTENCIA + ESTRUCTURA BAJISTA → VENTA
    let condition = false;
    let srType = '';
    let srPrice = 0;
    let srCount = 0;

    if (isBoom && isBullish && st._support && st._supportCount >= 2) {
        const nearSupport = Math.abs(price - st._support) / st._support < 0.005;
        if (nearSupport && price > st._support && st._structure.trend === 'bullish') {
            condition = true;
            srType = 'SOPORTE (piso)';
            srPrice = st._support;
            srCount = st._supportCount;
        }
    }

    if (!isBoom && isBearish && st._resistance && st._resistanceCount >= 2) {
        const nearResistance = Math.abs(price - st._resistance) / st._resistance < 0.005;
        if (nearResistance && price < st._resistance && st._structure.trend === 'bearish') {
            condition = true;
            srType = 'RESISTENCIA (techo)';
            srPrice = st._resistance;
            srCount = st._resistanceCount;
        }
    }

    if (!condition) return;

    const slPrice = parseFloat(st.ema[34].toFixed(4));
    const risk = Math.abs(price - slPrice);
    const tp = parseFloat((price + (isBullish ? risk : -risk)).toFixed(4));
    const pips = calculatePips(price, tp);

    // 🎯 Determinar dirección del último impulso
    const impulseDir = st._structure.lastImpulseDirection || 'N/A';
    const trendEmoji = st._structure.trend === 'bullish' ? '📈' : '📉';

    const signal = {
        sym,
        type: isBoom && isBullish ? 'MULTUP' : 'MULTDOWN',
        price,
        tp,
        sl: slPrice,
        time: new Date().toLocaleTimeString(),
        status: 'PENDIENTE',
        srType: srType,
        srPrice: srPrice,
        srCount: srCount,
        pips: pips,
        trend: st._structure.trend || 'N/A',
        impulseDir: impulseDir
    };

    st.lastSignal = signal;
    st.signalExpired = false;
    st._trendStarted = true;
    st._tp1Hit = false;
    st._entryPrice = price;
    st._tpPrice = tp;
    st._slPrice = slPrice;
    totalSignals++;
    lastSignalTime[sym] = Date.now();

    const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
    const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';
    const impulseEmoji = signal.impulseDir === 'up' ? '⬆️' : '⬇️';

    const msg =
        `${emoji} 🐙 KRAKEN PRO\n\n` +
        `<b>Par:</b> ${signal.sym}\n` +
        `<b>Dirección:</b> ${dir}\n` +
        `<b>Estructura:</b> ${trendEmoji} ${signal.trend.toUpperCase()} (${impulseEmoji} impulso ${signal.impulseDir})\n` +
        `<b>${srType}:</b> $${signal.srPrice.toFixed(4)} (${signal.srCount} toques)\n` +
        `<b>Entrada:</b> $${signal.price}\n` +
        `<b>TP:</b> $${signal.tp} 🎯 (${signal.pips} pips)\n` +
        `<b>SL:</b> $${signal.sl} 🛑\n\n` +
        `⏰ ${signal.time}`;

    addLog(`🔔 ${sym}: ${dir} | Estructura ${signal.trend} | ${srType} $${signal.srPrice.toFixed(4)} | Pips: ${signal.pips}`, 'signal');
    sendTelegramMessage(msg);
}

function analyzeTrendStart(sym) {
    if (isProcessingQueue) { analysisQueue.push(sym); return; }
    isProcessingQueue = true;

    try {
        const st = pairState[sym];
        if (!st || st.ema[2] === null) { isProcessingQueue = false; processNextInQueue(); return; }
        if (!signalsActive) { isProcessingQueue = false; processNextInQueue(); return; }

        detectMarketStructure(sym);
        detectSR(sym);

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
            activeTrend[sym] = null;
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
            activeTrend[sym] = null;
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
    st._trendStarted = false;
    st._tp1Hit = false;
    st._entryPrice = null;
    st._tpPrice = null;
    st._slPrice = null;
    st._pips = 0;
    st._isWin = false;
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
        st._lastCandleOpen = candles[candles.length - 2]?.open ? parseFloat(candles[candles.length - 2].open) : st.price;
        st._lastCandleClose = st.price;
        EMA_PERIODS.forEach(period => { st.prevEma[period] = null; });
        calcEMAs(sym);
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
                st._lastCandleOpen = st.candles[st.candles.length - 1] || st.price;
                st._lastCandleClose = st.price;
                EMA_PERIODS.forEach(period => { st.prevEma[period] = st.ema[period]; });
                st.candles.push(st.price);
                if (st.candles.length > 500) st.candles.shift();
                calcEMAs(sym);
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
            addLog(`🚀 KRAKEN PRO - SEÑALES ACTIVADAS`, 'start');
            if (!activationSent) {
                activationSent = true;
                sendTelegramMessage(`🐙 KRAKEN PRO ACTIVADO\n\n✅ Sistema en marcha\n📡 Monitoreando ${ALL_PAIRS.length} símbolos\n🎯 ESTRUCTURA DE MERCADO\n📊 Impulso + Retroceso (ambas direcciones)\n🔴 BOOM: Soporte + Estructura Alcista → COMPRA\n🔵 CRASH: Resistencia + Estructura Bajista → VENTA\n📌 1 operación por tendencia\n⏰ ${new Date().toLocaleString()}`);
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
console.log('🎯 ESTRUCTURA DE MERCADO (Impulso + Retroceso)');

addLog('🎯 Iniciando KRAKEN PRO con ESTRUCTURA DE MERCADO...', 'info');

setTimeout(() => {
    sendTelegramMessage(`🐙 KRAKEN PRO INICIADO\n\n🔄 Conectando a Deriv...\n⏳ El bot se activará automáticamente\n📡 ${ALL_PAIRS.length} símbolos\n🎯 ESTRUCTURA DE MERCADO\n📊 Impulso + Retroceso (ambas direcciones)\n📌 1 operación por tendencia\n⏰ ${new Date().toLocaleString()}`);
}, 3000);

connectDeriv();
