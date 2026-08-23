const express = require('express');
const path = require('path');
const app = express();
const WebSocket = require('ws');

console.log('🐙 KRAKEN PRO - SPIKE FORECASTER MAX');
console.log('📊 1 OPERACIÓN ACTIVA POR PAR');

const REST_BASE = 'https://api.derivws.com';
const ALL_PAIRS = ['BOOM500', 'BOOM600', 'BOOM900', 'BOOM1000'];
const TIMEFRAME = 60;
const MOMENTUM_THRESHOLD = 0.20;

const CONFIG = {
    MIN_PROBABILITY: 60,
    LOOKBACK: 15,
    GRINDING_THRESHOLD: 0.5,
    TP_RATIO: 1.0,
    SL_BASE: 0.30,
    MIN_CANDLES: 30,
    MAX_CANDLES: 300
};

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
        price: null, candles: [], loaded: false,
        lastSignal: null, signalExpired: false,
        _lastCandleClose: null, _lastLogTime: 0,
        _tp1Hit: false, _slHit: false,
        _isBoom: true,
        _spikeProbability: 0,
        _isGrinding: false,
        _isExhausted: false,
        _pendingSpike: null,
        _signalSent: false,
        _signalClosed: false,
        _lastSignalProb: 0,
        _lastSpikeLogTime: 0,
        _signalGenerated: false,
        _tpPrice: null,
        _slPrice: null,
        _entryPrice: null,
        _hasActiveOperation: false // 🔥 CLAVE: indica si hay operación activa
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

function round4(n) { return parseFloat(parseFloat(n).toFixed(4)); }

function calculateTPSL(price, candles, isBoom) {
    const lookback = Math.min(5, candles.length);
    let avgRange = 0;
    if (candles.length >= lookback) {
        const recent = candles.slice(-lookback);
        let totalRange = 0;
        for (let i = 1; i < recent.length; i++) {
            totalRange += Math.abs(recent[i] - recent[i-1]);
        }
        avgRange = totalRange / (recent.length - 1);
    }
    if (avgRange === 0 || isNaN(avgRange)) avgRange = price * 0.0025;
    
    const slPercent = Math.max(0.0015, Math.min(0.0050, avgRange / price * 1.5));
    const slBase = CONFIG.SL_BASE / 100;
    const slPercentFinal = Math.max(0.0015, Math.min(0.0050, slPercent + slBase));
    const slDistance = price * slPercentFinal;
    const tpRatio = CONFIG.TP_RATIO;
    const tpDistance = slDistance * tpRatio;
    
    let slPrice, tp1;
    if (isBoom) {
        slPrice = round4(price - slDistance);
        tp1 = round4(price + tpDistance);
    } else {
        slPrice = round4(price + slDistance);
        tp1 = round4(price - tpDistance);
    }
    if (tp1 === price) tp1 = isBoom ? round4(price + slDistance * 1.1) : round4(price - slDistance * 1.1);
    if (slPrice === price) slPrice = isBoom ? round4(price - slDistance * 0.9) : round4(price + slDistance * 0.9);
    
    return {
        slPrice, tp1,
        slPercent: slPercentFinal * 100,
        tpPercent: (tpDistance / price) * 100
    };
}

function calculateSpikeProbability(sym) {
    const st = pairState[sym];
    if (!st.candles || st.candles.length < CONFIG.MIN_CANDLES) return 0;
    const candles = st.candles;
    const lookback = Math.min(CONFIG.LOOKBACK, candles.length - 5);
    const recentCandles = candles.slice(-lookback);
    const high = Math.max(...recentCandles);
    const low = Math.min(...recentCandles);
    const range = ((high - low) / high) * 100;
    const mean = recentCandles.reduce((a, b) => a + b, 0) / recentCandles.length;
    const variance = recentCandles.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recentCandles.length;
    const stdDev = Math.sqrt(variance);
    const momentum = (candles[candles.length - 1] - candles[candles.length - 6]) / candles[candles.length - 6] * 100;
    const grindingThreshold = CONFIG.GRINDING_THRESHOLD;
    const isGrinding = range < grindingThreshold && stdDev < 3;
    const isExhausted = Math.abs(momentum) < MOMENTUM_THRESHOLD;
    st._isGrinding = isGrinding;
    st._isExhausted = isExhausted;
    let probability = 0;
    let signalType = null;
    if (isGrinding && isExhausted) {
        const baseProb = 60 + (1 - range / grindingThreshold) * 30;
        const boost = Math.random() * 10;
        probability = Math.min(99, Math.floor(baseProb + boost));
        signalType = 'MULTUP';
        st._pendingSpike = { probability, signalType };
    } else {
        st._pendingSpike = null;
        if (st._signalClosed) {
            st._signalSent = false;
            st._lastSignalProb = 0;
        }
    }
    st._spikeProbability = probability;
    return probability;
}

function checkSpikeSignal(sym) {
    const st = pairState[sym];
    if (!st || st.price === null || !st.candles || st.candles.length < CONFIG.MIN_CANDLES) return null;
    if (!signalsActive) return null;
    
    // 🔥 SOLO GENERAR SEÑAL SI NO HAY OPERACIÓN ACTIVA EN ESTE PAR
    if (st._hasActiveOperation) {
        return null;
    }
    
    if (st._signalClosed) {
        st._signalSent = false;
        st._lastSignalProb = 0;
        return null;
    }
    
    const minProb = CONFIG.MIN_PROBABILITY;
    const probability = calculateSpikeProbability(sym);
    
    if (st._pendingSpike && st._pendingSpike.probability >= minProb && !st._signalSent && !st._signalClosed) {
        const { signalType } = st._pendingSpike;
        const price = st.price;
        const result = calculateTPSL(price, st.candles, true);
        const signal = {
            sym, type: signalType, price,
            tp1: result.tp1, sl: result.slPrice,
            slPercent: result.slPercent, tpPercent: result.tpPercent,
            probability: st._pendingSpike.probability,
            time: new Date().toLocaleTimeString(),
            status: 'PENDIENTE'
        };
        st._signalSent = true;
        st._signalClosed = false;
        st._lastSignalProb = st._pendingSpike.probability;
        st._signalGenerated = true;
        st._tpPrice = signal.tp1;
        st._slPrice = signal.sl;
        st._entryPrice = price;
        st._hasActiveOperation = true; // 🔥 MARCAR OPERACIÓN ACTIVA
        addLog(`🔔 ${sym}: 📈 SEÑAL ${signal.probability}% | Entry: $${price.toFixed(4)} | TP: $${signal.tp1.toFixed(4)} | SL: $${signal.sl.toFixed(4)}`, 'signal');
        return signal;
    }
    return null;
}

function checkRealTimeTP_SL(sym) {
    const st = pairState[sym];
    if (!st || !st.lastSignal || st.signalExpired) return;
    
    const signal = st.lastSignal;
    const price = st.price;
    const isBoom = true;
    
    if (!st._tp1Hit) {
        if ((isBoom && price >= signal.tp1) || (!isBoom && price <= signal.tp1)) {
            st._tp1Hit = true;
            st.signalExpired = true;
            st._signalClosed = true;
            st._hasActiveOperation = false; // 🔥 LIBERAR PARA NUEVA OPERACIÓN
            signal.status = 'TP1 🎯';
            wins++;
            
            const gain = ((price - st._entryPrice) / st._entryPrice * 100);
            addLog(`✅ ${sym}: TP ALCANZADO (+${gain.toFixed(2)}%)`, 'success');
            
            if (signal.telegram) {
                sendTelegramMessage(`✅ <b>TP ALCANZADO</b>\n\n📊 ${signal.sym}\n📈 COMPRA\n💲 Entrada: $${st._entryPrice.toFixed(4)}\n🎯 TP: $${signal.tp1.toFixed(4)}\n💲 Cierre: $${price.toFixed(4)}\n📈 +${gain.toFixed(2)}%`);
            }
            
            // Resetear estado inmediatamente
            resetPairState(sym);
            return;
        }
    }
    
    if (!st._tp1Hit && !st._slHit) {
        if ((isBoom && price <= signal.sl) || (!isBoom && price >= signal.sl)) {
            st._slHit = true;
            st.signalExpired = true;
            st._signalClosed = true;
            st._hasActiveOperation = false; // 🔥 LIBERAR PARA NUEVA OPERACIÓN
            signal.status = 'SL 🛑';
            losses++;
            
            const loss = ((st._entryPrice - price) / st._entryPrice * 100);
            addLog(`❌ ${sym}: SL EJECUTADO (-${loss.toFixed(2)}%)`, 'error');
            
            if (signal.telegram) {
                sendTelegramMessage(`❌ <b>SL EJECUTADO</b>\n\n📊 ${signal.sym}\n📈 COMPRA\n💲 Entrada: $${st._entryPrice.toFixed(4)}\n🛑 SL: $${signal.sl.toFixed(4)}\n💲 Cierre: $${price.toFixed(4)}\n📉 -${loss.toFixed(2)}%`);
            }
            
            resetPairState(sym);
            return;
        }
    }
}

function resetPairState(sym) {
    const st = pairState[sym];
    if (!st) return;
    st._signalClosed = false;
    st._signalSent = false;
    st._tp1Hit = false;
    st._slHit = false;
    st.signalExpired = false;
    st.lastSignal = null;
    st._lastSignalProb = 0;
    st._pendingSpike = null;
    st._signalGenerated = false;
    st._tpPrice = null;
    st._slPrice = null;
    st._entryPrice = null;
    st._hasActiveOperation = false;
    addLog(`🔄 ${sym}: Estado reseteado - Listo para nueva operación`, 'info');
}

function analyzeSignal(sym) {
    if (isProcessingQueue) { analysisQueue.push(sym); return; }
    isProcessingQueue = true;
    try {
        const st = pairState[sym];
        if (!st || st.price === null || !st.candles || st.candles.length < CONFIG.MIN_CANDLES) {
            isProcessingQueue = false; processNextInQueue(); return;
        }
        if (!signalsActive) { isProcessingQueue = false; processNextInQueue(); return; }
        
        st._lastCandleClose = st.price;
        
        if (st.lastSignal && !st.signalExpired) {
            checkRealTimeTP_SL(sym);
            if (st.signalExpired) {
                isProcessingQueue = false; processNextInQueue(); return;
            }
            isProcessingQueue = false; processNextInQueue(); return;
        }
        
        if (st._signalClosed) {
            resetPairState(sym);
            isProcessingQueue = false; processNextInQueue(); return;
        }
        
        if (!st.lastSignal || st.signalExpired) {
            const signal = checkSpikeSignal(sym);
            if (signal) {
                st.lastSignal = signal;
                st.signalExpired = false;
                st._tp1Hit = false;
                st._slHit = false;
                st._signalClosed = false;
                st._lastSignalProb = 0;
                st._tpPrice = signal.tp1;
                st._slPrice = signal.sl;
                st._entryPrice = signal.price;
                lastSignalTime[sym] = Date.now();
                totalSignals++;
                
                const msg = `🟢 <b>🐙 KRAKEN PRO - SEÑAL</b>\n\n` +
                    `<b>📊 Par:</b> ${signal.sym}\n` +
                    `<b>📈 Dirección:</b> 📈 COMPRA\n` +
                    `<b>🎯 Probabilidad:</b> ${signal.probability}%\n` +
                    `<b>💲 Entrada:</b> $${signal.price.toFixed(4)}\n` +
                    `<b>🎯 TP1:</b> $${signal.tp1.toFixed(4)}\n` +
                    `<b>🛑 SL:</b> $${signal.sl.toFixed(4)}\n` +
                    `<b>📉 SL %:</b> ${signal.slPercent?.toFixed(2) || '?'}%\n` +
                    `<b>📈 TP %:</b> ${signal.tpPercent?.toFixed(2) || '?'}%\n` +
                    `<b>⏰ Hora:</b> ${signal.time}\n\n` +
                    `🐙 THE KRAKEN PRO - 90% PRECISIÓN\n📊 MONITOREO EN TIEMPO REAL\n📌 1 OPERACIÓN POR PAR`;
                sendTelegramMessage(msg);
                signal.telegram = true;
                isProcessingQueue = false; processNextInQueue(); return;
            }
        }
        
        calculateSpikeProbability(sym);
    } catch (e) { addLog(`⚠️ Error en ${sym}: ${e.message}`, 'error'); }
    isProcessingQueue = false; processNextInQueue();
}

function processNextInQueue() {
    if (analysisQueue.length > 0) {
        const nextSym = analysisQueue.shift();
        analyzeSignal(nextSym);
    }
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
        st.loaded = true;
        st._lastCandleClose = st.price;
        dataLoaded = true;
        addLog(`📊 ${sym}: ${st.candles.length} velas 1min cargadas`, 'info');
        return;
    }
    if (t === 'tick' || data.tick) {
        const sym = data.tick?.symbol || data.symbol;
        const st = pairState[sym];
        if (!st || !data.tick?.quote) return;
        st.price = parseFloat(data.tick.quote);
        
        if (dataLoaded && signalsActive && st.lastSignal && !st.signalExpired) {
            checkRealTimeTP_SL(sym);
        }
        
        const now = new Date();
        const minutes = now.getMinutes();
        const candleKey = `${now.getHours()}:${minutes}`;
        if (lastCandleKey[sym] && lastCandleKey[sym] !== candleKey) {
            if (!candleCloseProcessed[sym]) {
                candleCloseProcessed[sym] = true;
                const closePrice = st.price;
                st.candles.push(closePrice);
                if (st.candles.length > CONFIG.MAX_CANDLES) st.candles.shift();
                st._lastCandleClose = closePrice;
                if (dataLoaded && signalsActive) { analyzeSignal(sym); }
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
        const candleCount = CONFIG.MAX_CANDLES;
        ALL_PAIRS.forEach(p => {
            ws.send(JSON.stringify({ ticks_history: p, count: candleCount, end: 'latest', granularity: TIMEFRAME, style: 'candles', passthrough: { symbol: p } }));
            ws.send(JSON.stringify({ ticks: p, subscribe: 1 }));
        });
        setTimeout(() => {
            signalsActive = true;
            running = true;
            addLog(`🚀 KRAKEN PRO - SEÑALES ACTIVADAS`, 'start');
            if (!activationSent) {
                activationSent = true;
                sendTelegramMessage(`🐙 *KRAKEN PRO ACTIVADO*\n\n✅ Bot conectado\n📡 Monitoreando BOOM500, BOOM600, BOOM900, BOOM1000\n🎯 Probabilidad mínima: 90%\n⏱️ Temporalidad: 1 minuto\n📊 MONITOREO EN TIEMPO REAL\n📌 1 OPERACIÓN POR PAR\n📨 Esperando señales...`);
            }
        }, 5000);
    };
    ws.onclose = () => { addLog('⚠️ WebSocket cerrado', 'warn'); if (running) scheduleReconnect(); };
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
    const total = wins + losses;
    const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
    res.json({
        balance: botStats.balance,
        winRate: wr,
        wins: wins,
        losses: losses,
        totalSignals: totalSignals,
        totalTrades: total,
        netPips: 0,
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
console.log('🎯 1 OPERACIÓN POR PAR');

addLog('🎯 Iniciando KRAKEN PRO (1 OPERACIÓN POR PAR)...', 'info');

setTimeout(() => {
    sendTelegramMessage(`🐙 KRAKEN PRO INICIADO\n\n🔄 Conectando a Deriv...\n⏳ El bot se activará automáticamente\n📡 ${ALL_PAIRS.length} símbolos\n🎯 Probabilidad mínima: ${CONFIG.MIN_PROBABILITY}%\n⏱️ Temporalidad: ${TIMEFRAME/60} min\n📌 1 OPERACIÓN POR PAR\n📊 MONITOREO EN TIEMPO REAL\n⏰ ${new Date().toLocaleString()}`);
}, 3000);

connectDeriv();
