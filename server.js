const express = require('express');
const WebSocket = require('ws');
const app = express();

console.log('🐙 THE KRAKEN PRO — Deriv Edition v5.0 - SEÑALES FUERTES');
console.log('⚡ Filtros: EMAs separadas + OB múltiple + Momentum');

// ==================== CONFIGURACIÓN ====================
const REST_BASE = 'https://api.derivws.com';
const ALL_PAIRS = ['BOOM1000', 'CRASH1000', 'CRASH900', 'BOOM900'];
const EMA_PERIODS = [2, 5, 13, 34, 55, 89, 144];
const TIMEFRAME = 60;
const OB_LOOKBACK = 20;

// NUEVOS FILTROS DE FUERZA
const MIN_EMA_SEPARATION = 0.001; // 0.1% de separación mínima entre EMAs
const MIN_OB_STRENGTH = 0.5; // Fuerza mínima del Order Block
const MIN_MOMENTUM_CANDLES = 3; // Velas consecutivas en la dirección

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
        _entryTaken: false,
        orderBlocks: [],
        _lastOBHigh: null,
        _lastOBLow: null,
        _obValid: false,
        // NUEVOS CAMPOS PARA SEÑALES FUERTES
        _momentumCandles: 0,
        _lastMomentumDirection: null
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
    st._momentumCandles = 0;
    st._lastMomentumDirection = null;
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

// ==================== ORDER BLOCKS MEJORADO ====================
function detectOrderBlocks(sym) {
    const st = pairState[sym];
    if (!st.candles || st.candles.length < OB_LOOKBACK + 10) return;

    const candles = st.candles;
    const length = candles.length;
    const newBlocks = [];

    for (let i = length - OB_LOOKBACK - 5; i < length - 2; i++) {
        if (i < 5) continue;
        
        const open = candles[i - 4] || candles[i];
        const close = candles[i];
        const high = Math.max(candles[i - 4] || candles[i], candles[i - 3] || candles[i], 
                              candles[i - 2] || candles[i], candles[i - 1] || candles[i], candles[i]);
        const low = Math.min(candles[i - 4] || candles[i], candles[i - 3] || candles[i], 
                             candles[i - 2] || candles[i], candles[i - 1] || candles[i], candles[i]);
        
        const body = Math.abs(close - open);
        const upperShadow = high - Math.max(open, close);
        const lowerShadow = Math.min(open, close) - low;
        const bodyRatio = body / (high - low + 0.0001);
        
        if (upperShadow > body * 1.5 && bodyRatio > 0.3 && upperShadow > lowerShadow * 1.2) {
            const rejectionZone = Math.max(open, close) + upperShadow * 0.3;
            const strength = Math.min(1, upperShadow / (body + 0.0001));
            newBlocks.push({
                type: 'bearish',
                high: high,
                low: rejectionZone,
                price: rejectionZone,
                strength: strength,
                timestamp: i
            });
        }
        
        if (lowerShadow > body * 1.5 && bodyRatio > 0.3 && lowerShadow > upperShadow * 1.2) {
            const rejectionZone = Math.min(open, close) - lowerShadow * 0.3;
            const strength = Math.min(1, lowerShadow / (body + 0.0001));
            newBlocks.push({
                type: 'bullish',
                high: rejectionZone,
                low: low,
                price: rejectionZone,
                strength: strength,
                timestamp: i
            });
        }
    }

    if (newBlocks.length > 0) {
        const uniqueBlocks = [];
        const seen = new Set();
        for (let ob of newBlocks) {
            const key = `${ob.type}_${ob.high.toFixed(4)}_${ob.low.toFixed(4)}`;
            if (!seen.has(key) && ob.strength > MIN_OB_STRENGTH) {
                seen.add(key);
                uniqueBlocks.push(ob);
            }
        }
        uniqueBlocks.sort((a, b) => b.strength - a.strength);
        st.orderBlocks = uniqueBlocks.slice(0, 5);
        
        if (st.orderBlocks.length > 0) {
            const lastOB = st.orderBlocks[0];
            st._lastOBHigh = lastOB.high;
            st._lastOBLow = lastOB.low;
            st._obValid = true;
            console.log(`🧱 ${sym}: OB ${lastOB.type.toUpperCase()} | Fuerza: ${(lastOB.strength * 100).toFixed(0)}%`);
        }
    }
}

// ==================== NUEVOS FILTROS DE FUERZA ====================

// 1. VERIFICAR SEPARACIÓN DE EMAS
function isEMASeparationStrong(sym) {
    const st = pairState[sym];
    if (!st || st.ema[2] === null || st.ema[144] === null) return false;

    const isBoom = sym.includes('BOOM');
    const isBullish = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] &&
                      st.ema[13] > st.ema[34] && st.ema[34] > st.ema[55] &&
                      st.ema[55] > st.ema[89] && st.ema[89] > st.ema[144];
    const isBearish = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] &&
                      st.ema[13] < st.ema[34] && st.ema[34] < st.ema[55] &&
                      st.ema[55] < st.ema[89] && st.ema[89] < st.ema[144];

    if (!isBullish && !isBearish) return false;

    // Calcular separación entre EMAs
    const emaPairs = [
        [2, 5], [5, 13], [13, 34], [34, 55], [55, 89], [89, 144]
    ];

    let allSeparated = true;
    for (let [shortEma, longEma] of emaPairs) {
        const short = st.ema[shortEma];
        const long = st.ema[longEma];
        if (short === null || long === null) return false;
        
        const separation = Math.abs(short - long) / long;
        if (separation < MIN_EMA_SEPARATION) {
            allSeparated = false;
            break;
        }
    }

    if (allSeparated) {
        console.log(`✅ ${sym}: EMAs bien separadas (${(MIN_EMA_SEPARATION * 100).toFixed(1)}% mínimo)`);
    } else {
        console.log(`⏳ ${sym}: EMAs muy juntas - esperando separación`);
    }

    return allSeparated;
}

// 2. VERIFICAR MOMENTUM (velas consecutivas en la dirección)
function isMomentumStrong(sym) {
    const st = pairState[sym];
    if (!st || !st.candles || st.candles.length < MIN_MOMENTUM_CANDLES + 1) return false;

    const isBoom = sym.includes('BOOM');
    const isBullish = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] &&
                      st.ema[13] > st.ema[34] && st.ema[34] > st.ema[55] &&
                      st.ema[55] > st.ema[89] && st.ema[89] > st.ema[144];
    const isBearish = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] &&
                      st.ema[13] < st.ema[34] && st.ema[34] < st.ema[55] &&
                      st.ema[55] < st.ema[89] && st.ema[89] < st.ema[144];

    if (!isBullish && !isBearish) return false;

    const candles = st.candles;
    const lastCandles = candles.slice(-MIN_MOMENTUM_CANDLES);
    const direction = isBullish ? 1 : -1;

    // Verificar que las últimas velas vayan en la dirección de la tendencia
    let momentumCount = 0;
    for (let i = 1; i < lastCandles.length; i++) {
        const diff = (lastCandles[i] - lastCandles[i - 1]) * direction;
        if (diff > 0) momentumCount++;
    }

    const isStrong = momentumCount >= MIN_MOMENTUM_CANDLES - 1;
    if (isStrong) {
        console.log(`✅ ${sym}: Momentum fuerte (${momentumCount}/${MIN_MOMENTUM_CANDLES} velas)`);
    } else {
        console.log(`⏳ ${sym}: Momentum débil (${momentumCount}/${MIN_MOMENTUM_CANDLES} velas)`);
    }

    return isStrong;
}

// 3. VERIFICAR ORDER BLOCK MÚLTIPLE (al menos 2 OB confirmando)
function isOrderBlockStrong(sym, direction) {
    const st = pairState[sym];
    if (!st || !st.orderBlocks || st.orderBlocks.length === 0) return false;

    const isBuy = direction === 'MULTUP';
    const price = st.price;

    let validBlocks = 0;
    for (let ob of st.orderBlocks) {
        if (isBuy && ob.type === 'bullish') {
            if (price >= ob.low && price <= ob.high * 1.01) {
                validBlocks++;
            }
        }
        if (!isBuy && ob.type === 'bearish') {
            if (price <= ob.high && price >= ob.low * 0.99) {
                validBlocks++;
            }
        }
    }

    const isStrong = validBlocks >= 2;
    if (isStrong) {
        console.log(`✅ ${sym}: ${validBlocks} Order Blocks confirmando ${isBuy ? 'COMPRA' : 'VENTA'}`);
    } else {
        console.log(`⏳ ${sym}: Solo ${validBlocks} Order Block(s) - esperando más confirmación`);
    }

    return isStrong;
}

// ==================== DETECTAR TENDENCIA CON FILTROS DE FUERZA ====================
function detectTrendStart(sym) {
    const st = pairState[sym];
    if (!st || st.ema[2] === null || st.ema[5] === null || st.ema[13] === null ||
        st.ema[34] === null || st.ema[55] === null || st.ema[89] === null || st.ema[144] === null) return false;

    const isBoom = sym.includes('BOOM');
    
    const isBullish = st.ema[2] > st.ema[5] && st.ema[5] > st.ema[13] &&
                      st.ema[13] > st.ema[34] && st.ema[34] > st.ema[55] &&
                      st.ema[55] > st.ema[89] && st.ema[89] > st.ema[144];
                      
    const isBearish = st.ema[2] < st.ema[5] && st.ema[5] < st.ema[13] &&
                      st.ema[13] < st.ema[34] && st.ema[34] < st.ema[55] &&
                      st.ema[55] < st.ema[89] && st.ema[89] < st.ema[144];

    if (!isBullish && !isBearish) {
        st._pendingEntry = false;
        return false;
    }

    const direction = isBullish ? 'MULTUP' : 'MULTDOWN';

    // ✅ FILTRO 1: EMA144 alineada
    const ema144Aligned = isEMA144Aligned(sym);
    if (!ema144Aligned) {
        st._pendingEntry = true;
        console.log(`⏳ ${sym}: ESPERANDO EMA144`);
        return false;
    }

    // ✅ FILTRO 2: Separación de EMAs (FUERZA)
    const emaSeparation = isEMASeparationStrong(sym);
    if (!emaSeparation) {
        st._pendingEntry = true;
        console.log(`⏳ ${sym}: EMAS MUY JUNTAS - esperando separación`);
        return false;
    }

    // ✅ FILTRO 3: Momentum (FUERZA)
    const momentum = isMomentumStrong(sym);
    if (!momentum) {
        st._pendingEntry = true;
        console.log(`⏳ ${sym}: MOMENTUM DÉBIL - esperando aceleración`);
        return false;
    }

    // ✅ FILTRO 4: Order Block fuerte (FUERZA)
    const obStrong = isOrderBlockStrong(sym, direction);
    if (!obStrong) {
        st._pendingEntry = true;
        console.log(`⏳ ${sym}: ORDER BLOCK DÉBIL - esperando confirmación`);
        return false;
    }

    if (st.lastSignal && !st.signalExpired) {
        return false;
    }

    console.log(`🚀 ${sym}: SEÑAL FUERTE CONFIRMADA | ${isBullish ? 'ALCISTA' : 'BAJISTA'} | EMA144 ✅ | EMAs separadas ✅ | Momentum ✅ | OB fuerte ✅`);
    st._pendingEntry = false;
    return true;
}

// ==================== VERIFICACIONES ====================
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

    const direction = isBullishTrend ? 'MULTUP' : 'MULTDOWN';
    const obStrong = isOrderBlockStrong(sym, direction);
    if (!obStrong) return;

    st._pendingEntry = false;
    const tpRatio = 2;
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
        status: 'PENDIENTE',
        // NUEVA INFORMACIÓN DE FILTROS
        filters: {
            ema144: '✅',
            emaSeparation: '✅',
            momentum: '✅',
            ob: '✅'
        }
    };

    st.lastSignal = signal;
    st.signalExpired = false;
    st._trendStarted = true;
    st._tp1Hit = false;
    totalSignals++;
    lastSignalTime[sym] = Date.now();

    console.log(`🔔 ${sym}: SEÑAL FUERTE ${signal.type === 'MULTUP' ? 'COMPRA' : 'VENTA'} | Entry: $${price} | TP1: $${tp1} | SL: $${slPrice}`);

    const emoji = signal.type === 'MULTUP' ? '🟢' : '🔴';
    const dir = signal.type === 'MULTUP' ? '📈 COMPRA (CALL)' : '📉 VENTA (PUT)';
    sendTelegramMessage(
        `${emoji} <b>🐙 SEÑAL KRAKEN PRO - FUERTE</b>\n\n<b>Par:</b> ${signal.sym}\n<b>Dirección:</b> ${dir}\n<b>Momento:</b> 🚀 INICIO DE TENDENCIA ${isBullishTrend ? 'ALCISTA' : 'BAJISTA'}\n\n<b>Filtros confirmados:</b>\n🔹 EMA144: ✅ ALINEADA\n🔹 EMAs separadas: ✅\n🔹 Momentum: ✅\n🔹 Order Block: ✅ FUERTE\n\n<b>Entrada:</b> $${signal.price}\n<b>TP1:</b> $${signal.tp1} 🎯\n<b>SL (EMA144):</b> $${signal.sl} 🛑\n\n⏰ ${signal.time}`
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

        detectOrderBlocks(sym);
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
        console.log(`📊 ${sym}: ${st.candles.length} velas cargadas`);
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
        const candleCount = 500;
        ALL_PAIRS.forEach(p => {
            ws.send(JSON.stringify({ ticks_history: p, count: candleCount, end: 'latest', granularity: TIMEFRAME, style: 'candles', passthrough: { symbol: p } }));
            ws.send(JSON.stringify({ ticks: p, subscribe: 1 }));
        });
        setTimeout(() => {
            signalsActive = true;
            running = true;
            console.log('🚀 KRAKEN PRO - SEÑALES FUERTES ACTIVADAS');
            sendTelegramMessage('🐙 KRAKEN PRO ACTIVADO - SEÑALES FUERTES\n✅ Sistema en marcha\n📊 Monitoreando 4 símbolos\n🔍 Filtros: EMAs separadas + Momentum + OB fuerte');
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
console.log('🔄 Iniciando KRAKEN PRO - SEÑALES FUERTES...');
connectDeriv();

// ==================== SERVIDOR WEB ====================
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send(`
        <html><body style="background:#060a18;color:#00d4ff;font-family:monospace;text-align:center;padding:50px;">
        <h1>🐙 KRAKEN PRO - SEÑALES FUERTES</h1>
        <p>✅ Bot activo en modo servidor</p>
        <p>🔍 Filtros: EMAs separadas + Momentum + OB fuerte</p>
        <p>📡 Señales generadas: ${totalSignals}</p>
        <p>🎯 Aciertos: ${wins} | Fallos: ${losses}</p>
        <p style="color:#10b981;">🚀 Solo señales CON FUERZA</p>
        </body></html>
    `);
});

app.get('/ping', (req, res) => {
    res.status(200).send('🐙 KRAKEN PRO - SEÑALES FUERTES ' + new Date().toISOString());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Servidor web en puerto ${PORT}`);
});

console.log('⏰ Bot iniciado - Esperando señales con FILTROS DE FUERZA...');
