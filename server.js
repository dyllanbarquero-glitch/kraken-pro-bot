const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🐙 KRAKEN PRO 2.0 - BACKEND 24/7');
console.log('📊 EMAs: 2,5,13,34');
console.log('🎯 ESTRUCTURA DE MERCADO: MÁX/MÍN');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const ALL_PAIRS = ['BOOM1000', 'CRASH1000', 'CRASH900', 'BOOM900'];
const EMA_PERIODS = [2, 5, 13, 34];
const TIMEFRAME = 60;
const MIN_SCORE = 6;
const COOLDOWN_MINUTES = 3;
const MAX_DISTANCE_EMA13 = 2.0;
const ADX_THRESHOLD = 20;

// 🎯 Configuración de estructura de mercado
const STRUCTURE_CONFIG = {
    LOOKBACK_CANDLES: 20,      // Velas para buscar máximos/mínimos
    BREAKOUT_THRESHOLD: 0.2,   // % para confirmar ruptura
    RETEST_THRESHOLD: 0.3,     // % para confirmar retroceso
    MIN_STRENGTH: 2            // Número de toques para considerar fuerte
};

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
        _slPrice: null,
        // 🎯 Estructura de mercado
        _structure: {
            max: null,        // Precio del máximo
            min: null,        // Precio del mínimo
            maxCandle: null,  // Índice de la vela del máximo
            minCandle: null,  // Índice de la vela del mínimo
            maxCount: 0,      // Veces que se ha tocado el máximo
            minCount: 0,      // Veces que se ha tocado el mínimo
            structureType: null, // 'strong_min' o 'weak_max'
            confirmed: false,
            breakoutPrice: null
        }
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

// ==================== DETECTAR ESTRUCTURA DE MERCADO ====================
function detectMarketStructure(sym) {
    const st = pairState[sym];
    if (!st || st.candles.length < STRUCTURE_CONFIG.LOOKBACK_CANDLES) return;

    const candles = st.candles;
    const lookback = Math.min(STRUCTURE_CONFIG.LOOKBACK_CANDLES, candles.length - 10);
    const start = candles.length - lookback - 10;
    const end = candles.length - 2;

    let maxPrice = -Infinity;
    let minPrice = Infinity;
    let maxIndex = -1;
    let minIndex = -1;
    let maxCount = 0;
    let minCount = 0;

    // ✅ Buscar máximos y mínimos
    for (let i = start; i < end; i++) {
        const price = candles[i];
        const prev = candles[i - 1] || price;
        const next = candles[i + 1] || price;

        // Pico (máximo)
        if (price > prev && price > next && price > candles[i - 2] && price > candles[i + 2]) {
            if (price > maxPrice) {
                maxPrice = price;
                maxIndex = i;
            }
            maxCount++;
        }

        // Valle (mínimo)
        if (price < prev && price < next && price < candles[i - 2] && price < candles[i + 2]) {
            if (price < minPrice) {
                minPrice = price;
                minIndex = i;
            }
            minCount++;
        }
    }

    // ✅ Determinar si es un MÍNIMO FUERTE (para compras)
    const isStrongMin = minCount >= STRUCTURE_CONFIG.MIN_STRENGTH && minPrice > 0;

    // ✅ Determinar si es un MÁXIMO DÉBIL (para ventas)
    const isWeakMax = maxCount < STRUCTURE_CONFIG.MIN_STRENGTH && maxPrice > 0;

    // ✅ Guardar estructura
    st._structure.max = maxPrice > 0 ? maxPrice : null;
    st._structure.min = minPrice < Infinity ? minPrice : null;
    st._structure.maxCount = maxCount;
    st._structure.minCount = minCount;
    st._structure.maxCandle = maxIndex;
    st._structure.minCandle = minIndex;

    // ✅ Determinar tipo de estructura
    if (isStrongMin) {
        st._structure.structureType = 'strong_min';
        st._structure.confirmed = true;
        addLog(`📊 ${sym}: MÍNIMO FUERTE detectado en $${minPrice.toFixed(4)} (${minCount} toques)`, 'trend');
    } else if (isWeakMax) {
        st._structure.structureType = 'weak_max';
        st._structure.confirmed = true;
        addLog(`📊 ${sym}: MÁXIMO DÉBIL detectado en $${maxPrice.toFixed(4)} (${maxCount} toques)`, 'trend');
    } else {
        st._structure.confirmed = false;
        st._structure.structureType = null;
    }
}

// ==================== VERIFICAR RUPTURA Y RETROCESO ====================
function checkBreakoutAndRetest(sym) {
    const st = pairState[sym];
    if (!st || !st._structure.confirmed) return false;

    const price = st.price;
    const structure = st._structure;
    const threshold = STRUCTURE_CONFIG.BREAKOUT_THRESHOLD / 100;
    const retestThreshold = STRUCTURE_CONFIG.RETEST_THRESHOLD / 100;

    // ✅ Para COMPRAS: Mínimo fuerte
    if (structure.structureType === 'strong_min') {
        const min = structure.min;
        // Ruptura alcista: precio sube más del X% sobre el mínimo
        const isBreakout = price > min * (1 + threshold);
        // Retroceso: precio vuelve a la zona del mínimo
        const isRetest = Math.abs(price - min) / min < retestThreshold;
        
        if (isBreakout && isRetest) {
            structure.breakoutPrice = price;
            addLog(`🔄 ${sym}: RETROCESO CONFIRMADO en mínimo fuerte $${min.toFixed(4)}`, 'trend');
            return true;
        }
    }

    // ✅ Para VENTAS: Máximo débil
    if (structure.structureType === 'weak_max') {
        const max = structure.max;
        // Ruptura bajista: precio baja más del X% bajo el máximo
        const isBreakout = price < max * (1 - threshold);
        // Retroceso: precio vuelve a la zona del máximo
        const isRetest = Math.abs(price - max) / max < retestThreshold;
        
        if (isBreakout && isRetest) {
            structure.breakoutPrice = price;
            addLog(`🔄 ${sym}: RETROCESO CONFIRMADO en máximo débil $${max.toFixed(4)}`, 'trend');
            return true;
        }
    }

    return false;
}

// ==================== SISTEMA DE PUNTUACIÓN CON ESTRUCTURA ====================
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

    // 1. Tendencia definida
    if (isBullishTrend || isBearishTrend) score++;

    // 2. Pendiente positiva de EMAs
    const ema13Slope = prevEma13 ? st.ema[13] - prevEma13 : 0;
    const ema34Slope = prevEma34 ? st.ema[34] - prevEma34 : 0;
    if ((isBullishTrend && ema13Slope > 0 && ema34Slope > 0) ||
        (isBearishTrend && ema13Slope < 0 && ema34Slope < 0)) score++;

    // 3. ADX confirma tendencia
    if (adx > ADX_THRESHOLD) score++;

    // 4. RSI confirma
    if (isBullishTrend && rsi > 50 && rsi < 75) score++;
    if (isBearishTrend && rsi < 50 && rsi > 25) score++;

    // 5. ⭐ ESTRUCTURA DE MERCADO (2 puntos)
    if (st._structure.confirmed) {
        score += 2;
    }

    // 6. ⭐ RUPTURA + RETROCESO CONFIRMADO (2 puntos extra)
    if (st._pullbackDetected) {
        score += 2;
    }

    // 7. Vela de confirmación
    if (st._candleConfirmed) score++;

    // 8. Cooldown respetado
    const timeSinceLast = Date.now() - lastSignalTime[sym];
    if (timeSinceLast > COOLDOWN_MINUTES * 60 * 1000) score++;

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

    // SL en EMA34
    const slPrice = parseFloat(st.ema[34].toFixed(4));
    const riskDistance = Math.abs(price - slPrice);
    const tp = parseFloat((price + (isBullishTrend ? riskDistance : -riskDistance)).toFixed(4));

    // ✅ Determinar tipo de estructura para el mensaje
    let structureType = '';
    let structureInfo = '';
    
    if (st._structure.structureType === 'strong_min') {
        structureType = 'MÍNIMO FUERTE';
        structureInfo = `🟢 Mínimo fuerte en $${st._structure.min.toFixed(4)}`;
    } else if (st._structure.structureType === 'weak_max') {
        structureType = 'MÁXIMO DÉBIL';
        structureInfo = `🔴 Máximo débil en $${st._structure.max.toFixed(4)}`;
    }

    const signal = {
        sym,
        type: isBoom && isBullishTrend ? 'MULTUP' : 'MULTDOWN',
        price,
        tp,
        sl: slPrice,
        time: new Date().toLocaleTimeString(),
        status: 'PENDIENTE',
        score: st._lastScore,
        structure: structureType,
        structureInfo: structureInfo,
        pullbackDetected: st._pullbackDetected
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
    
    // ✅ MENSAJE CON ESTRUCTURA DE MERCADO
    const structureMsg = signal.pullbackDetected ? 
        `✅ Retroceso confirmado\n${signal.structureInfo}` : 
        `${signal.structureInfo}`;

    const telegramMsg =
        `${emoji} 🐙 KRAKEN PRO 2.0\n\n` +
        `<b>Par:</b> ${signal.sym}\n` +
        `<b>Dirección:</b> ${dir}\n` +
        `<b>Estructura:</b> ${signal.structure}\n` +
        `${structureMsg}\n` +
        `<b>Entrada:</b> $${signal.price}\n` +
        `<b>TP:</b> $${signal.tp} 🎯\n` +
        `<b>SL:</b> $${signal.sl} 🛑\n\n` +
        `⏰ ${signal.time}`;

    addLog(`🔔 ${sym}: ${dir} | ${signal.structure} | ${signal.structureInfo} | Entry: $${price}`, 'signal');
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

        // Calcular indicadores
        st._rsi = calculateRSI(st.candles);
        st._adx = calculateADX(st.candles);

        // 🎯 DETECTAR ESTRUCTURA DE MERCADO
        detectMarketStructure(sym);

        // ✅ VERIFICAR RUPTURA Y RETROCESO
        const breakoutConfirmed = checkBreakoutAndRetest(sym);
        if (breakoutConfirmed && !st._pullbackDetected) {
            st._pullbackDetected = true;
            st._pullbackPrice = st.price;
            st._pullbackTime = Date.now();
        }

        // ✅ VERIFICAR CONFIRMACIÓN DE VELA
        const candleConfirmed = checkCandleConfirmation(sym);
        if (candleConfirmed && !st._candleConfirmed) {
            st._candleConfirmed = true;
            addLog(`✅ ${sym}: VELA DE CONFIRMACIÓN`, 'success');
        }

        // Calcular score
        const score = calculateKrakenScore(sym);
        const isBoom = sym.includes('BOOM');
        const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
        const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];

        // Log de estructura
        if (st._structure.confirmed && (!st._lastScoreTime || Date.now() - st._lastScoreTime > 60000)) {
            const structType = st._structure.structureType === 'strong_min' ? 'MIN FUERTE' : 'MAX DEBIL';
            const price = st._structure.structureType === 'strong_min' ? st._structure.min : st._structure.max;
            addLog(`📊 ${sym}: SCORE ${score}/10 | ${structType} en $${price?.toFixed(4)} | RSI: ${st._rsi.toFixed(1)} | ADX: ${st._adx.toFixed(1)}`, 'score');
        }

        // Verificar señal existente
        if (st.lastSignal && !st.signalExpired) {
            checkSignalExpiry(sym);
            isProcessingQueue = false; processNextInQueue(); return;
        }

        // Restricción de dirección
        let allowedDirection = false;
        let signalType = null;
        if (isBoom && isBullishTrend) { allowedDirection = true; signalType = 'MULTUP'; }
        else if (!isBoom && isBearishTrend) { allowedDirection = true; signalType = 'MULTDOWN'; }

        // 🎯 CONDICIONES DE ENTRADA CON ESTRUCTURA DE MERCADO
        const hasStructure = st._structure.confirmed && st._pullbackDetected;
        const minScore = hasStructure ? 6 : 8;

        if (score >= minScore && !st.lastSignal && !st.signalExpired && allowedDirection) {
            // Verificar que la estructura coincide con la dirección
            let structureValid = false;
            if (isBullishTrend && st._structure.structureType === 'strong_min') {
                structureValid = true;
            } else if (isBearishTrend && st._structure.structureType === 'weak_max') {
                structureValid = true;
            }

            if (structureValid || score >= 9) {
                generateSignal(sym);
                st._pullbackDetected = false;
                st._candleConfirmed = false;
                isProcessingQueue = false; processNextInQueue(); return;
            }
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

    // TP ALCANZADO
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

    // SL ALCANZADO
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

// ==================== FUNCIÓN AUXILIAR: CONFIRMACIÓN DE VELA ====================
function checkCandleConfirmation(sym) {
    const st = pairState[sym];
    if (!st || st._lastCandleOpen === null || st._lastCandleClose === null) return false;

    const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
    const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];

    if (!isBullishTrend && !isBearishTrend) return false;

    if (isBullishTrend) {
        const isBullishCandle = st._lastCandleClose > st._lastCandleOpen;
        const range = st._lastCandleClose - st._lastCandleOpen;
        const nearTop = range > 0 && (st._lastCandleClose - st._lastCandleOpen) / range > 0.5;
        return isBullishCandle && nearTop;
    }

    if (isBearishTrend) {
        const isBearishCandle = st._lastCandleClose < st._lastCandleOpen;
        const range = st._lastCandleOpen - st._lastCandleClose;
        const nearBottom = range > 0 && (st._lastCandleOpen - st._lastCandleClose) / range > 0.5;
        return isBearishCandle && nearBottom;
    }

    return false;
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
            addLog(`🚀 KRAKEN PRO 2.0 - SEÑALES ACTIVADAS (ESTRUCTURA DE MERCADO)`, 'start');
            
            if (!activationSent) {
                activationSent = true;
                sendTelegramMessage(`🐙 KRAKEN PRO 2.0 ACTIVADO\n\n✅ Sistema en marcha\n📡 Monitoreando ${ALL_PAIRS.length} símbolos\n🎯 Estrategia: ESTRUCTURA DE MERCADO\n📊 Mínimo Fuerte (COMPRAS) | Máximo Débil (VENTAS)\n⏰ ${new Date().toLocaleString()}`);
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
console.log('🎯 ESTRATEGIA: ESTRUCTURA DE MERCADO');

// ==================== INICIO ====================
addLog('🎯 Iniciando KRAKEN PRO 2.0 con ESTRUCTURA DE MERCADO...', 'info');

setTimeout(() => {
    sendTelegramMessage(`🐙 KRAKEN PRO 2.0 INICIADO\n\n🔄 Conectando a Deriv...\n⏳ El bot se activará automáticamente\n📡 ${ALL_PAIRS.length} símbolos monitoreados\n🎯 Estrategia: ESTRUCTURA DE MERCADO\n📊 Mínimo Fuerte (COMPRAS) | Máximo Débil (VENTAS)\n⏰ ${new Date().toLocaleString()}`);
}, 3000);

connectDeriv();
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
        _slPrice: null,
        // 🎯 Nuevos campos para retrocesos
        _pullbackZone: null, // 'ema13' o 'ema34'
        _pullbackPrice: null,
        _pullbackTime: null,
        _pullbackConfirmed: false
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

// ==================== DETECTAR RETROCESO (PULLBACK) ====================
function detectPullback(sym) {
    const st = pairState[sym];
    if (!st || st.candles.length < 10) return false;

    const price = st.price;
    const ema13 = st.ema[13];
    const ema34 = st.ema[34];
    
    if (ema13 === null || ema34 === null) return false;

    const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
    const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];

    if (!isBullishTrend && !isBearishTrend) return false;

    const tolerance = PULLBACK_CONFIG.TOUCH_TOLERANCE / 100;
    let pullbackDetected = false;
    let zone = null;

    // ✅ Verificar retroceso a EMA13
    if (PULLBACK_CONFIG.USE_EMA13) {
        const distanceToEMA13 = Math.abs(price - ema13) / ema13;
        if (distanceToEMA13 < tolerance) {
            pullbackDetected = true;
            zone = 'EMA13';
        }
    }

    // ✅ Verificar retroceso a EMA34 (si no se detectó en EMA13)
    if (!pullbackDetected && PULLBACK_CONFIG.USE_EMA34) {
        const distanceToEMA34 = Math.abs(price - ema34) / ema34;
        if (distanceToEMA34 < tolerance) {
            pullbackDetected = true;
            zone = 'EMA34';
        }
    }

    if (pullbackDetected) {
        st._pullbackZone = zone;
        st._pullbackPrice = price;
        st._pullbackTime = Date.now();
        st._pullbackDetected = true;
        addLog(`🔄 ${sym}: RETROCESO detectado en ${zone} | Precio: $${price.toFixed(4)}`, 'trend');
        return true;
    }

    return false;
}

// ==================== CONFIRMACIÓN DE VELA PARA RETROCESO ====================
function checkPullbackCandleConfirmation(sym) {
    const st = pairState[sym];
    if (!st || st._lastCandleOpen === null || st._lastCandleClose === null) return false;

    const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
    const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];

    if (!isBullishTrend && !isBearishTrend) return false;

    if (isBullishTrend) {
        // Vela alcista: cierre > apertura, y cierre cerca del máximo
        const isBullishCandle = st._lastCandleClose > st._lastCandleOpen;
        const range = st._lastCandleClose - st._lastCandleOpen;
        const nearTop = range > 0 && (st._lastCandleClose - st._lastCandleOpen) / range > 0.5;
        return isBullishCandle && nearTop;
    }

    if (isBearishTrend) {
        // Vela bajista: cierre < apertura, y cierre cerca del mínimo
        const isBearishCandle = st._lastCandleClose < st._lastCandleOpen;
        const range = st._lastCandleOpen - st._lastCandleClose;
        const nearBottom = range > 0 && (st._lastCandleOpen - st._lastCandleClose) / range > 0.5;
        return isBearishCandle && nearBottom;
    }

    return false;
}

// ==================== SISTEMA DE PUNTUACIÓN CON RETROCESO ====================
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

    // 1. Tendencia definida
    if (isBullishTrend || isBearishTrend) score++;

    // 2. Pendiente positiva de EMAs
    const ema13Slope = prevEma13 ? st.ema[13] - prevEma13 : 0;
    const ema34Slope = prevEma34 ? st.ema[34] - prevEma34 : 0;
    if ((isBullishTrend && ema13Slope > 0 && ema34Slope > 0) ||
        (isBearishTrend && ema13Slope < 0 && ema34Slope < 0)) score++;

    // 3. ADX confirma tendencia
    if (adx > ADX_THRESHOLD) score++;

    // 4. RSI confirma
    if (isBullishTrend && rsi > 50 && rsi < 75) score++;
    if (isBearishTrend && rsi < 50 && rsi > 25) score++;

    // 5. ⭐ RETROCESO DETECTADO (punto extra)
    if (st._pullbackDetected) score += 2;

    // 6. Vela de confirmación (punto extra)
    if (st._candleConfirmed) score++;

    // 7. Precio cerca de EMA (buena zona de entrada)
    const distanceFromEMA13 = Math.abs(price - st.ema[13]) / st.ema[13] * 100;
    if (distanceFromEMA13 < MAX_DISTANCE_EMA13) score++;

    // 8. Cooldown respetado
    const timeSinceLast = Date.now() - lastSignalTime[sym];
    if (timeSinceLast > COOLDOWN_MINUTES * 60 * 1000) score++;

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

    // SL en EMA34
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
        score: st._lastScore,
        pullbackZone: st._pullbackZone || 'N/A'
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
    const pullbackInfo = st._pullbackDetected ? `🔄 Retroceso en ${st._pullbackZone}` : '🚀 Entrada directa';

    // ✅ MENSAJE CON INFORMACIÓN DE RETROCESO
    const telegramMsg =
        `${emoji} 🐙 KRAKEN PRO 2.0\n\n` +
        `<b>Par:</b> ${signal.sym}\n` +
        `<b>Dirección:</b> ${dir}\n` +
        `<b>${pullbackInfo}</b>\n` +
        `<b>Entrada:</b> $${signal.price}\n` +
        `<b>TP:</b> $${signal.tp} 🎯\n` +
        `<b>SL:</b> $${signal.sl} 🛑\n\n` +
        `⏰ ${signal.time}`;

    addLog(`🔔 ${sym}: ${dir} | ${pullbackInfo} | Entry: $${price} | TP: $${tp} | SL: $${slPrice}`, 'signal');
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

        // Calcular indicadores
        st._rsi = calculateRSI(st.candles);
        st._adx = calculateADX(st.candles);

        // 🎯 DETECTAR RETROCESO
        const pullbackDetected = detectPullback(sym);
        if (pullbackDetected && !st._pullbackDetected) {
            st._pullbackDetected = true;
            st._pullbackPrice = st.price;
            st._pullbackTime = Date.now();
        }

        // ✅ VERIFICAR CONFIRMACIÓN DE VELA EN RETROCESO
        const candleConfirmed = checkPullbackCandleConfirmation(sym);
        if (candleConfirmed && !st._candleConfirmed) {
            st._candleConfirmed = true;
            addLog(`✅ ${sym}: VELA DE CONFIRMACIÓN EN RETROCESO`, 'success');
        }

        // Calcular score
        const score = calculateKrakenScore(sym);
        const isBoom = sym.includes('BOOM');
        const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
        const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];

        // Log de score
        if (score > 0 && (!st._lastScoreTime || Date.now() - st._lastScoreTime > 60000)) {
            const pullbackStatus = st._pullbackDetected ? `🔄 Retroceso en ${st._pullbackZone}` : 'Sin retroceso';
            addLog(`📊 ${sym}: SCORE ${score}/10 | RSI: ${st._rsi.toFixed(1)} | ADX: ${st._adx.toFixed(1)} | ${pullbackStatus}`, 'score');
        }

        // Verificar señal existente
        if (st.lastSignal && !st.signalExpired) {
            checkSignalExpiry(sym);
            isProcessingQueue = false; processNextInQueue(); return;
        }

        // Restricción de dirección
        let allowedDirection = false;
        let signalType = null;
        if (isBoom && isBullishTrend) { allowedDirection = true; signalType = 'MULTUP'; }
        else if (!isBoom && isBearishTrend) { allowedDirection = true; signalType = 'MULTDOWN'; }

        // 🎯 CONDICIONES DE ENTRADA CON RETROCESO
        const hasPullback = st._pullbackDetected && st._candleConfirmed;
        const minScore = hasPullback ? 6 : 8; // Si hay retroceso, se necesita menos score

        if (score >= minScore && !st.lastSignal && !st.signalExpired && allowedDirection) {
            // Si hay retroceso confirmado, entrar
            if (hasPullback || score >= 8) {
                generateSignal(sym);
                st._pullbackDetected = false;
                st._candleConfirmed = false;
                isProcessingQueue = false; processNextInQueue(); return;
            }
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

    // TP ALCANZADO
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

    // SL ALCANZADO
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
    st._pullbackZone = null;
    st._pullbackPrice = null;
    st._pullbackTime = null;
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
            addLog(`🚀 KRAKEN PRO 2.0 - SEÑALES ACTIVADAS (RETROCESOS)`, 'start');
            
            if (!activationSent) {
                activationSent = true;
                sendTelegramMessage(`🐙 KRAKEN PRO 2.0 ACTIVADO\n\n✅ Sistema en marcha\n📡 Monitoreando ${ALL_PAIRS.length} símbolos\n🔄 Estrategia: RETROCESOS (Pullback)\n⏰ ${new Date().toLocaleString()}`);
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
console.log('🔄 ESTRATEGIA: ENTRADAS EN RETROCESO (PULLBACK)');

// ==================== INICIO ====================
addLog('🔄 Iniciando KRAKEN PRO 2.0 con RETROCESOS...', 'info');

setTimeout(() => {
    sendTelegramMessage(`🐙 KRAKEN PRO 2.0 INICIADO\n\n🔄 Conectando a Deriv...\n⏳ El bot se activará automáticamente\n📡 ${ALL_PAIRS.length} símbolos monitoreados\n🔄 Estrategia: RETROCESOS (Pullback)\n⏰ ${new Date().toLocaleString()}`);
}, 3000);

connectDeriv();
