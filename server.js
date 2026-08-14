const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🐙 KRAKEN PRO 2.0 - BACKEND 24/7');
console.log('📊 ESTRATEGIA: REVERSIÓN EXTREMA');
console.log('📈 BOOM: Oversold → Compra | CRASH: Overbought → Venta');
console.log('📊 PIPs: Cálculo y conteo automático');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const ALL_PAIRS = ['BOOM1000', 'CRASH1000', 'CRASH900', 'BOOM900'];
const EMA_PERIODS = [2, 5, 13, 34];
const TIMEFRAME = 60;
const MIN_SCORE = 7;
const COOLDOWN_MINUTES = 5;
const ADX_THRESHOLD = 20;

// 🎯 Configuración de movimiento extremo
const EXTREME_CONFIG = {
    LOOKBACK_CANDLES: 30,
    EXTREME_THRESHOLD: 2.0,
    RSI_OVERSOLD: 30,
    RSI_OVERBOUGHT: 70,
    MIN_EXTREME_CANDLES: 5,
    CONFIRMATION_CANDLES: 2
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
let botStats = { 
    balance: 0, 
    totalProfit: 0, 
    winCount: 0, 
    lossCount: 0, 
    totalTrades: 0,
    // 📊 PIPs
    totalPipsGained: 0,
    totalPipsLost: 0,
    netPips: 0,
    avgPipsPerTrade: 0,
    bestTradePips: 0,
    worstTradePips: 0
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
        _extreme: {
            detected: false,
            type: null,
            startPrice: null,
            endPrice: null,
            movement: 0,
            extremeCandles: [],
            confirmed: false,
            reversalCandle: null
        },
        // 📊 PIPs
        _pips: 0,
        _isWin: false
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

// ==================== DETECTAR MOVIMIENTO EXTREMO ====================
function detectExtremeMovement(sym) {
    const st = pairState[sym];
    if (!st || st.candles.length < EXTREME_CONFIG.LOOKBACK_CANDLES) return;

    const candles = st.candles;
    const lookback = Math.min(EXTREME_CONFIG.LOOKBACK_CANDLES, candles.length - 5);
    const start = candles.length - lookback - 5;
    const end = candles.length - 2;

    const isBoom = sym.includes('BOOM');
    
    let startPrice = candles[start];
    let endPrice = candles[end];
    let movement = ((endPrice - startPrice) / startPrice) * 100;

    let extremePrice = startPrice;
    let extremeIndex = start;
    for (let i = start; i <= end; i++) {
        if (isBoom && candles[i] < extremePrice) {
            extremePrice = candles[i];
            extremeIndex = i;
        }
        if (!isBoom && candles[i] > extremePrice) {
            extremePrice = candles[i];
            extremeIndex = i;
        }
    }

    let movementFromExtreme = ((endPrice - extremePrice) / extremePrice) * 100;
    
    let isExtreme = false;
    let type = null;

    if (isBoom && movementFromExtreme < -EXTREME_CONFIG.EXTREME_THRESHOLD) {
        isExtreme = true;
        type = 'oversold';
    }

    if (!isBoom && movementFromExtreme > EXTREME_CONFIG.EXTREME_THRESHOLD) {
        isExtreme = true;
        type = 'overbought';
    }

    if (isExtreme) {
        st._extreme.detected = true;
        st._extreme.type = type;
        st._extreme.startPrice = startPrice;
        st._extreme.endPrice = endPrice;
        st._extreme.movement = movementFromExtreme;
        st._extreme.extremePrice = extremePrice;
        st._extreme.extremeIndex = extremeIndex;
        
        const extremeLabel = type === 'oversold' ? 'OVERSOLD' : 'OVERBOUGHT';
        addLog(`🔥 ${sym}: MOVIMIENTO EXTREMO ${extremeLabel} detectado | ${movementFromExtreme.toFixed(2)}% | Desde $${extremePrice.toFixed(4)}`, 'trend');
        return true;
    }

    st._extreme.detected = false;
    return false;
}

// ==================== VERIFICAR ALINEACIÓN DE EMAS ====================
function checkEMAsAlignmentAfterExtreme(sym) {
    const st = pairState[sym];
    if (!st || !st._extreme.detected) return false;

    const isBoom = sym.includes('BOOM');
    const ema2 = st.ema[2];
    const ema5 = st.ema[5];
    const ema13 = st.ema[13];
    const ema34 = st.ema[34];

    if (ema2 === null || ema5 === null || ema13 === null || ema34 === null) return false;

    const isBullishAlignment = ema2 > ema5 && ema5 > ema13 && ema13 > ema34;
    const isBearishAlignment = ema2 < ema5 && ema5 < ema13 && ema13 < ema34;

    if (isBoom && isBullishAlignment) {
        addLog(`✅ ${sym}: EMAS ALINEADAS ALCISTAS después de OVERSOLD`, 'success');
        return true;
    }

    if (!isBoom && isBearishAlignment) {
        addLog(`✅ ${sym}: EMAS ALINEADAS BAJISTAS después de OVERBOUGHT`, 'success');
        return true;
    }

    return false;
}

// ==================== CALCULAR PIPS ====================
function calculatePips(entry, exit, isBuy) {
    const difference = Math.abs(exit - entry);
    return parseFloat((difference * 10000).toFixed(2)); // 4 decimales → pips
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

    if (st._extreme.detected) score += 2;
    const isBullishTrend = ema2 > ema5 && ema5 > ema13 && ema13 > ema34;
    const isBearishTrend = ema2 < ema5 && ema5 < ema13 && ema13 < ema34;
    if (isBullishTrend || isBearishTrend) score++;
    if (checkEMAsAlignmentAfterExtreme(sym)) score += 2;
    if (isBoom && rsi < EXTREME_CONFIG.RSI_OVERSOLD) score++;
    if (!isBoom && rsi > EXTREME_CONFIG.RSI_OVERBOUGHT) score++;
    if (adx > ADX_THRESHOLD) score++;
    if (st._candleConfirmed) score++;
    const ema13Slope = prevEma13 ? st.ema[13] - prevEma13 : 0;
    const ema34Slope = prevEma34 ? st.ema[34] - prevEma34 : 0;
    if ((isBullishTrend && ema13Slope > 0 && ema34Slope > 0) ||
        (isBearishTrend && ema13Slope < 0 && ema34Slope < 0)) score++;
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

    const slPrice = parseFloat(st.ema[34].toFixed(4));
    const riskDistance = Math.abs(price - slPrice);
    const tp = parseFloat((price + (isBullishTrend ? riskDistance : -riskDistance)).toFixed(4));

    const extremeType = st._extreme.type === 'oversold' ? 'OVERSOLD (Bajada Extrema)' : 'OVERBOUGHT (Subida Extrema)';
    const extremeEmoji = st._extreme.type === 'oversold' ? '📉' : '📈';
    const movementPct = st._extreme.movement ? st._extreme.movement.toFixed(2) : '0';

    // 📊 Calcular pips potenciales
    const potentialPips = calculatePips(price, tp, isBullishTrend);

    const signal = {
        sym,
        type: isBoom && isBullishTrend ? 'MULTUP' : 'MULTDOWN',
        price,
        tp,
        sl: slPrice,
        time: new Date().toLocaleTimeString(),
        status: 'PENDIENTE',
        score: st._lastScore,
        extreme: extremeType,
        movement: movementPct,
        rsi: st._rsi,
        potentialPips: potentialPips
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

    // 📊 Mensaje con pips potenciales
    const telegramMsg =
        `${emoji} 🐙 KRAKEN PRO 2.0\n\n` +
        `<b>Par:</b> ${signal.sym}\n` +
        `<b>Dirección:</b> ${dir}\n` +
        `<b>Extremo:</b> ${extremeEmoji} ${extremeType}\n` +
        `<b>Movimiento:</b> ${movementPct}%\n` +
        `<b>RSI:</b> ${signal.rsi.toFixed(1)}\n` +
        `<b>Entrada:</b> $${signal.price}\n` +
        `<b>TP:</b> $${signal.tp} 🎯 (${signal.potentialPips} pips)\n` +
        `<b>SL:</b> $${signal.sl} 🛑\n\n` +
        `⏰ ${signal.time}`;

    addLog(`🔔 ${sym}: ${dir} | ${extremeType} | Mov: ${movementPct}% | RSI: ${signal.rsi.toFixed(1)} | Pips: ${signal.potentialPips}`, 'signal');
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

        detectExtremeMovement(sym);

        const candleConfirmed = checkCandleConfirmation(sym);
        if (candleConfirmed && !st._candleConfirmed) {
            st._candleConfirmed = true;
            addLog(`✅ ${sym}: VELA DE CONFIRMACIÓN`, 'success');
        }

        const score = calculateKrakenScore(sym);
        const isBoom = sym.includes('BOOM');
        const isBullishTrend = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] && st.ema[13] > st.ema[34];
        const isBearishTrend = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] && st.ema[13] < st.ema[34];

        if (st._extreme.detected && (!st._lastScoreTime || Date.now() - st._lastScoreTime > 60000)) {
            const extremeLabel = st._extreme.type === 'oversold' ? 'OVERSOLD' : 'OVERBOUGHT';
            addLog(`📊 ${sym}: SCORE ${score}/10 | ${extremeLabel} ${st._extreme.movement.toFixed(2)}% | RSI: ${st._rsi.toFixed(1)} | ADX: ${st._adx.toFixed(1)}`, 'score');
        }

        if (st.lastSignal && !st.signalExpired) {
            checkSignalExpiry(sym);
            isProcessingQueue = false; processNextInQueue(); return;
        }

        let allowedDirection = false;
        let signalType = null;
        if (isBoom && isBullishTrend) { allowedDirection = true; signalType = 'MULTUP'; }
        else if (!isBoom && isBearishTrend) { allowedDirection = true; signalType = 'MULTDOWN'; }

        const hasExtreme = st._extreme.detected;
        const emasAligned = isBullishTrend || isBearishTrend;

        if (score >= MIN_SCORE && !st.lastSignal && !st.signalExpired && allowedDirection && hasExtreme && emasAligned) {
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

// ==================== CHECK SIGNAL EXPIRY CON PIPS ====================
function checkSignalExpiry(sym) {
    const st = pairState[sym];
    if (!st || !st.lastSignal || st.signalExpired) return;

    const price = st.price;
    const signal = st.lastSignal;
    const isBoom = sym.includes('BOOM');
    const sl = st._slPrice || signal.sl;
    const tp = st._tpPrice || signal.tp;
    const entry = st._entryPrice || signal.price;
    const isBuy = signal.type === 'MULTUP';

    if (!st._tp1Hit) {
        if ((isBoom && price >= tp) || (!isBoom && price <= tp)) {
            st._tp1Hit = true;
            st.signalExpired = true;
            wins++;
            
            // 📊 Calcular pips de ganancia
            const pipsGained = calculatePips(entry, price, isBuy);
            botStats.totalPipsGained += pipsGained;
            botStats.netPips += pipsGained;
            botStats.totalTrades++;
            
            if (pipsGained > botStats.bestTradePips) {
                botStats.bestTradePips = pipsGained;
            }
            
            st._pips = pipsGained;
            st._isWin = true;
            
            addLog(`🎯 TP ALCANZADO en ${sym} | +${pipsGained} pips`, 'success');
            
            const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
            const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';
            
            sendTelegramMessage(
                `${emoji} 🐙 KRAKEN PRO 2.0\n\n` +
                `<b>Par:</b> ${sym}\n` +
                `<b>Dirección:</b> ${dir}\n` +
                `✅ TP ALCANZADO 🎯\n` +
                `<b>Pips:</b> +${pipsGained} pips 📈\n\n` +
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
            
            // 📊 Calcular pips de pérdida
            const pipsLost = calculatePips(entry, price, isBuy);
            botStats.totalPipsLost += pipsLost;
            botStats.netPips -= pipsLost;
            botStats.totalTrades++;
            
            if (pipsLost > botStats.worstTradePips) {
                botStats.worstTradePips = pipsLost;
            }
            
            st._pips = -pipsLost;
            st._isWin = false;
            
            addLog(`❌ SL ALCANZADO en ${sym} | -${pipsLost} pips`, 'error');
            
            const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
            const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';
            
            sendTelegramMessage(
                `${emoji} 🐙 KRAKEN PRO 2.0\n\n` +
                `<b>Par:</b> ${sym}\n` +
                `<b>Dirección:</b> ${dir}\n` +
                `❌ SL ALCANZADO 🛑\n` +
                `<b>Pips:</b> -${pipsLost} pips 📉\n\n` +
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
    st._extreme.detected = false;
    st._extreme.type = null;
    st._pips = 0;
    st._isWin = false;
}

// ==================== CONFIRMACIÓN DE VELA ====================
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
            addLog(`🚀 KRAKEN PRO 2.0 - SEÑALES ACTIVADAS (MOVIMIENTO EXTREMO + PIPS)`, 'start');
            
            if (!activationSent) {
                activationSent = true;
                sendTelegramMessage(`🐙 KRAKEN PRO 2.0 ACTIVADO\n\n✅ Sistema en marcha\n📡 Monitoreando ${ALL_PAIRS.length} símbolos\n🎯 Estrategia: REVERSIÓN EXTREMA\n📉 BOOM: Oversold → COMPRAS\n📈 CRASH: Overbought → VENTAS\n📊 PIPS: Cálculo y conteo automático\n⏰ ${new Date().toLocaleString()}`);
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
        // 📊 Estadísticas de pips
        totalPipsGained: botStats.totalPipsGained,
        totalPipsLost: botStats.totalPipsLost,
        netPips: botStats.netPips,
        bestTradePips: botStats.bestTradePips,
        worstTradePips: botStats.worstTradePips,
        avgPipsPerTrade: botStats.totalTrades > 0 ? (botStats.netPips / botStats.totalTrades).toFixed(2) : 0,
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
console.log('🎯 ESTRATEGIA: REVERSIÓN EXTREMA');
console.log('📉 BOOM: Oversold → COMPRAS');
console.log('📈 CRASH: Overbought → VENTAS');
console.log('📊 PIPS: Cálculo y conteo automático');

// ==================== INICIO ====================
addLog('🎯 Iniciando KRAKEN PRO 2.0 con PIPS...', 'info');

setTimeout(() => {
    sendTelegramMessage(`🐙 KRAKEN PRO 2.0 INICIADO\n\n🔄 Conectando a Deriv...\n⏳ El bot se activará automáticamente\n📡 ${ALL_PAIRS.length} símbolos monitoreados\n🎯 Estrategia: REVERSIÓN EXTREMA\n📉 BOOM: Oversold → COMPRAS\n📈 CRASH: Overbought → VENTAS\n📊 PIPS: Cálculo y conteo automático\n⏰ ${new Date().toLocaleString()}`);
}, 3000);

connectDeriv();
