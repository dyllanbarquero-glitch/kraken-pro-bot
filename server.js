const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🐙 KRAKEN PRO 2.0 - BACKEND 24/7');
console.log('📊 EMAs: 2,5,13,34');
console.log('🎯 TP 1:1 basado en EMA34');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const ALL_PAIRS = ['BOOM1000', 'CRASH1000', 'CRASH900', 'BOOM900'];
const EMA_PERIODS = [2, 5, 13, 34];
const TIMEFRAME = 60;
const MIN_SCORE = 10;
const COOLDOWN_MINUTES = 1;
const MAX_DISTANCE_EMA13 = 2.0;
const ADX_THRESHOLD = 40;

const APP_ID = '33A0UhDa0Wa1FkvF9zlKh';
const PAT_TOKEN = 'pat_3ee3edc2b80c8daea41968ea5d8205df7f75f187d17f17175d3eb863acb82d23';
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
let tradeLogs = [];
let botStats = { balance: 0, totalProfit: 0, winCount: 0, lossCount: 0, totalTrades: 0 };
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
        price: null, ema: {}, prevEma: {}, candles: [], loaded: false,
        lastTrend: null, waitingForNewTrend: false, lastSignal: null,
        signalExpired: false, _lastCandleClose: null, _lastLogTime: 0,
        _trendStarted: false, _trendStartTime: null, _trendAge: 0,
        _tp1Hit: false, _pendingEntry: false, _rsi: 50, _adx: 20,
        _pullbackDetected: false, _candleConfirmed: false, _lastCandleOpen: null,
        _lastScore: 0, _lastScoreTime: 0,
        _entryPrice: null,
        _tpPrice: null,
        _slPrice: null
    };
    EMA_PERIODS.forEach(period => {
        pairState[p].ema[period] = null;
        pairState[p].prevEma[period] = null;
    });
    lastCandleKey[p] = null;
    candleCloseProcessed[p] = false;
    lastSignalTime[p] = 0;
});

// ==================== LOGS ====================
function addLog(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    tradeLogs.unshift({ time, msg, type });
    if (tradeLogs.length > 200) tradeLogs.pop();
    console.log(`[${time}] ${msg}`);
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
            console.log('📨 Mensaje enviado a Telegram ✅');
            return true;
        }
        console.log('❌ Error Telegram:', result.description || 'Error desconocido');
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
    if (!st.candles || st.candles.length < 34) return;
    const prices = st.candles.slice();
    EMA_PERIODS.forEach(period => {
        st.ema[period] = calculateEMA(prices, period);
    });
}

// ==================== RSI ====================
function calculateRSI(candles, period = 14) {
    if (candles.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = candles.length - period; i < candles.length - 1; i++) {
        const diff = candles[i + 1] - candles[i];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
}

// ==================== ADX ====================
function calculateADX(candles, period = 14) {
    if (candles.length < period * 2) return 20;
    let plusDM = 0, minusDM = 0, tr = 0;
    for (let i = candles.length - period; i < candles.length - 1; i++) {
        const high = candles[i + 1] - candles[i];
        const low = candles[i] - candles[i + 1];
        const range = Math.abs(candles[i + 1] - candles[i]);
        if (high > low && high > 0) plusDM += high;
        else if (low > high && low > 0) minusDM += low;
        tr += range;
    }
    if (tr === 0) return 20;
    const plusDI = 100 * plusDM / tr;
    const minusDI = 100 * minusDM / tr;
    const dx = 100 * Math.abs(plusDI - minusDI) / (plusDI + minusDI);
    return Math.min(100, dx);
}

// ==================== DETECTAR PULLBACK ====================
function detectPullback(sym) {
    const st = pairState[sym];
    if (!st || st.candles.length < 10 || st.ema[5] === null || st.ema[13] === null) return false;
    const price = st.price;
    const ema5 = st.ema[5], ema13 = st.ema[13];
    const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
    const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];
    if (!isBullishTrend && !isBearishTrend) return false;
    if (isBullishTrend) {
        const nearEMA5 = Math.abs(price - ema5) / ema5 * 100 < 0.5;
        const nearEMA13 = Math.abs(price - ema13) / ema13 * 100 < 0.5;
        return nearEMA5 || nearEMA13;
    }
    if (isBearishTrend) {
        const nearEMA5 = Math.abs(price - ema5) / ema5 * 100 < 0.5;
        const nearEMA13 = Math.abs(price - ema13) / ema13 * 100 < 0.5;
        return nearEMA5 || nearEMA13;
    }
    return false;
}

// ==================== CONFIRMACIÓN DE VELA ====================
function checkCandleConfirmation(sym) {
    const st = pairState[sym];
    if (!st || st._lastCandleOpen === null || st._lastCandleClose === null) return false;
    const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
    const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];
    if (isBullishTrend) {
        const closeAboveOpen = st._lastCandleClose > st._lastCandleOpen;
        const closeAboveEMA5 = st._lastCandleClose > st.ema[5];
        const range = st._lastCandleClose - st._lastCandleOpen;
        const nearTop = range > 0 && (st._lastCandleClose - st._lastCandleOpen) / range > 0.6;
        return closeAboveOpen && closeAboveEMA5 && nearTop;
    }
    if (isBearishTrend) {
        const closeBelowOpen = st._lastCandleClose < st._lastCandleOpen;
        const closeBelowEMA5 = st._lastCandleClose < st.ema[5];
        const range = st._lastCandleOpen - st._lastCandleClose;
        const nearBottom = range > 0 && (st._lastCandleOpen - st._lastCandleClose) / range > 0.6;
        return closeBelowOpen && closeBelowEMA5 && nearBottom;
    }
    return false;
}

// ==================== SISTEMA DE PUNTUACIÓN ====================
function calculateKrakenScore(sym) {
    const st = pairState[sym];
    if (!st || st.ema[2] === null || st.ema[5] === null || st.ema[13] === null || st.ema[34] === null) return 0;
    let score = 0;
    const isBoom = sym.includes('BOOM');
    const price = st.price;
    const ema2 = st.ema[2], ema5 = st.ema[5], ema13 = st.ema[13], ema34 = st.ema[34];
    const prevEma13 = st.prevEma[13], prevEma34 = st.prevEma[34];
    const rsi = st._rsi || 50, adx = st._adx || 20;
    const isBullishTrend = ema2 > ema5 && ema5 > ema13 && ema13 > ema34;
    const isBearishTrend = ema2 < ema5 && ema5 < ema13 && ema13 < ema34;
    if (isBullishTrend || isBearishTrend) score++;
    const ema13Slope = prevEma13 ? st.ema[13] - prevEma13 : 0;
    const ema34Slope = prevEma34 ? st.ema[34] - prevEma34 : 0;
    if ((isBullishTrend && ema13Slope > 0 && ema34Slope > 0) ||
        (isBearishTrend && ema13Slope < 0 && ema34Slope < 0)) score++;
    if (adx > ADX_THRESHOLD) score++;
    if (isBullishTrend && rsi > 50 && rsi < 75) score++;
    if (isBearishTrend && rsi < 50 && rsi > 25) score++;
    if (st._pullbackDetected) score++;
    if (st._candleConfirmed) score++;
    const distanceFromEMA13 = Math.abs(price - st.ema[13]) / st.ema[13] * 100;
    if (distanceFromEMA13 < MAX_DISTANCE_EMA13) score++;
    const timeSinceLast = Date.now() - lastSignalTime[sym];
    if (timeSinceLast > COOLDOWN_MINUTES * 60 * 1000) score++;
    const volatility = st.candles.length > 20 ?
        st.candles.slice(-20).reduce((acc, v, i, arr) => i > 0 ? acc + Math.abs(v - arr[i - 1]) : acc, 0) / 20 : 0;
    if (volatility > 0.5) score++;
    st._lastScore = score;
    st._lastScoreTime = Date.now();
    return score;
}

// ==================== GENERAR SEÑAL ====================
function generateSignal(sym) {
    const st = pairState[sym];
    if (!st || st.lastSignal && !st.signalExpired) return;

    const isBoom = sym.includes('BOOM');
    const price = st.price;
    const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
    const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];

    if (!isBullishTrend && !isBearishTrend) return;

    const slPrice = parseFloat(st.ema[34].toFixed(4));
    const riskDistance = Math.abs(price - slPrice);
    const tp = parseFloat((price + (isBullishTrend ? riskDistance : -riskDistance)).toFixed(4));

    const signal = {
        sym,
        type: isBoom && isBullishTrend ? 'MULTUP' : 'MULTDOWN',
        price,
        tp,
        sl: slPrice,
        time: new Date().toLocaleTimeString(),
        status: 'PENDIENTE',
        score: st._lastScore
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
    const dirRestriction = isBoom ? '🔒 BOOM → SOLO COMPRAS' : '🔒 CRASH → SOLO VENTAS';

    // ✅ MENSAJE SIMPLIFICADO - "TP" en lugar de "TP1"
    const telegramMsg =
        `${emoji} 🐙 KRAKEN PRO 2.0\n\n` +
        `<b>Par:</b> ${signal.sym}\n` +
        `<b>Dirección:</b> ${dir}\n` +
        `<b>Entrada:</b> $${signal.price}\n` +
        `<b>TP:</b> $${signal.tp} 🎯\n` +
        `<b>SL:</b> $${signal.sl} 🛑\n\n` +
        `⏰ ${signal.time}`;

    addLog(`🔔 ${sym}: ${dir} | Entry: $${price} | TP: $${tp} | SL: $${slPrice}`, 'signal');
    sendTelegramMessage(telegramMsg);
}

// ==================== ANALIZAR ====================
function analyzeTrendStart(sym) {
    if (isProcessingQueue) { analysisQueue.push(sym); return; }
    isProcessingQueue = true;

    try {
        const st = pairState[sym];
        if (!st || st.ema[2] === null) { isProcessingQueue = false; processNextInQueue(); return; }
        if (!signalsActive) { isProcessingQueue = false; processNextInQueue(); return; }

        st._rsi = calculateRSI(st.candles);
        st._adx = calculateADX(st.candles);

        const pullbackDetected = detectPullback(sym);
        if (pullbackDetected && !st._pullbackDetected) {
            st._pullbackDetected = true;
            st._pullbackPrice = st.price;
            st._pullbackTime = Date.now();
            addLog(`🔄 ${sym}: PULLBACK detectado`, 'trend');
        }

        const candleConfirmed = checkCandleConfirmation(sym);
        if (candleConfirmed && !st._candleConfirmed) {
            st._candleConfirmed = true;
            addLog(`✅ ${sym}: VELA DE CONFIRMACIÓN`, 'success');
        }

        const score = calculateKrakenScore(sym);
        const isBoom = sym.includes('BOOM');
        const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
        const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];

        if (score > 0 && (!st._lastScoreTime || Date.now() - st._lastScoreTime > 60000)) {
            addLog(`📊 ${sym}: SCORE ${score}/10 | RSI: ${st._rsi.toFixed(1)} | ADX: ${st._adx.toFixed(1)}`, 'score');
        }

        if (st.lastSignal && !st.signalExpired) {
            checkSignalExpiry(sym);
            isProcessingQueue = false; processNextInQueue(); return;
        }

        let allowedDirection = false;
        let signalType = null;
        if (isBoom && isBullishTrend) { allowedDirection = true; signalType = 'MULTUP'; }
        else if (!isBoom && isBearishTrend) { allowedDirection = true; signalType = 'MULTDOWN'; }

        if (score >= MIN_SCORE && !st.lastSignal && !st.signalExpired && allowedDirection) {
            generateSignal(sym);
            st._pullbackDetected = false;
            st._candleConfirmed = false;
            isProcessingQueue = false; processNextInQueue(); return;
        }

    } catch (e) { addLog(`⚠️ Error en ${sym}: ${e.message}`, 'error'); }

    isProcessingQueue = false; processNextInQueue();
}

function processNextInQueue() {
    if (analysisQueue.length > 0) {
        const nextSym = analysisQueue.shift();
        analyzeTrendStart(nextSym);
    }
}

// ==================== CHECK SIGNAL EXPIRY ====================
function checkSignalExpiry(sym) {
    const st = pairState[sym];
    if (!st || !st.lastSignal || st.signalExpired) return;

    const price = st.price;
    const signal = st.lastSignal;
    const isBoom = sym.includes('BOOM');
    const sl = st._slPrice || signal.sl;
    const tp = st._tpPrice || signal.tp;

    // ✅ TP ALCANZADO - "TP" en lugar de "TP1"
    if (!st._tp1Hit) {
        if ((isBoom && price >= tp) || (!isBoom && price <= tp)) {
            st._tp1Hit = true;
            st.signalExpired = true;
            wins++;
            addLog(`🎯 TP ALCANZADO en ${sym}`, 'success');
            
            const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
            const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';
            
            sendTelegramMessage(
                `${emoji} 🐙 KRAKEN PRO 2.0\n\n` +
                `<b>Par:</b> ${sym}\n` +
                `<b>Dirección:</b> ${dir}\n` +
                `✅ TP ALCANZADO 🎯\n\n` +
                `⏰ ${new Date().toLocaleTimeString()}`
            );
            
            resetPairState(sym);
            return;
        }
    }

    // ✅ SL ALCANZADO
    if (!st.signalExpired) {
        if ((isBoom && price <= sl) || (!isBoom && price >= sl)) {
            st.signalExpired = true;
            losses++;
            addLog(`❌ SL ALCANZADO en ${sym}`, 'error');
            
            const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
            const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';
            
            sendTelegramMessage(
                `${emoji} 🐙 KRAKEN PRO 2.0\n\n` +
                `<b>Par:</b> ${sym}\n` +
                `<b>Dirección:</b> ${dir}\n` +
                `❌ SL ALCANZADO 🛑\n\n` +
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
    st._pullbackDetected = false;
    st._candleConfirmed = false;
    st.waitingForNewTrend = false;
    st.lastTrend = null;
    st._entryPrice = null;
    st._tpPrice = null;
    st._slPrice = null;
}

// ==================== WEBSOCKET ====================
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
                st._pullbackDetected = false;
                st._candleConfirmed = false;
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
        const candleCount = 500;
        ALL_PAIRS.forEach(p => {
            ws.send(JSON.stringify({ ticks_history: p, count: candleCount, end: 'latest', granularity: TIMEFRAME, style: 'candles', passthrough: { symbol: p } }));
            ws.send(JSON.stringify({ ticks: p, subscribe: 1 }));
        });
        setTimeout(() => {
            signalsActive = true;
            running = true;
            addLog(`🚀 KRAKEN PRO 2.0 - SEÑALES ACTIVADAS`, 'start');
            
            if (!activationSent) {
                activationSent = true;
                sendTelegramMessage(`🐙 KRAKEN PRO 2.0 ACTIVADO\n\n✅ Sistema en marcha\n📡 Monitoreando ${ALL_PAIRS.length} símbolos\n⏰ ${new Date().toLocaleString()}`);
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

// ==================== SERVIDOR WEB ====================
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
        logs: tradeLogs.slice(0, 50)
    });
});

app.get('/ping', (req, res) => {
    res.status(200).send('🐙 KRAKEN PRO 2.0 - Activo ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor web en puerto ${PORT}`);
    console.log(`🔗 https://kraken-pro-bot-production.up.railway.app`);
});

console.log('⏰ KRAKEN PRO 2.0 - 24/7 ACTIVO');
console.log('📊 EMAs: 2,5,13,34');
console.log('🎯 TP 1:1 basado en EMA34');

// ==================== INICIO ====================
addLog('🔄 Iniciando KRAKEN PRO 2.0...', 'info');

setTimeout(() => {
    sendTelegramMessage(`🐙 KRAKEN PRO 2.0 INICIADO\n\n🔄 Conectando a Deriv...\n⏳ El bot se activará automáticamente\n📡 ${ALL_PAIRS.length} símbolos monitoreados\n⏰ ${new Date().toLocaleString()}`);
}, 3000);

connectDeriv();
