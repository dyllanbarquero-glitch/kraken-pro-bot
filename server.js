# Import necessary libraries
import json
import os
import requests
import time
import WebSocket

# Define constants
REST_BASE = 'https://api.derivws.com'
ALL_PAIRS = ['BOOM500', 'BOOM600', 'BOOM900', 'BOOM1000']
TIMEFRAME = 60
MOMENTUM_THRESHOLD = 0.20
CONFIG = {
    LOOKBACK: 15,
    GRINDING_THRESHOLD: 1.5,
    TP_RATIO: 1.2,
    SL_BASE: 0.30,
    MIN_CANDLES: 20,
    MAX_CANDLES: 500,
    CONFIRMATION_RANGE: 5.0
}
APP_ID = '33A0UhDa0Wa1FkvF9zlKh'
PAT_TOKEN = 'pat_3ee3edc2b80c8daea41968ea5d8205df7f75f187d17f17175d3eb863acb82d23'
TELEGRAM_TOKEN = '8345003490:AAGhSXXzdltZ5dS2Civ4l0ld0dXJScQbsBo'
TELEGRAM_CHAT = '-1003177595391'

# Initialize variables
ws = None
signalsActive = False
running = False
totalSignals = 0
wins = 0
losses = 0
pairState = {}
tradeLogs = []
botStats = { balance: 0, totalProfit: 0, winCount: 0, lossCount: 0, totalTrades: 0 }
reconnectAttempts = 0
reconnectTimer = None
lastCandleKey = {}
candleCloseProcessed = {}
dataLoaded = False
analysisQueue = []
isProcessingQueue = False
lastSignalTime = {}
activationSent = False

# Initialize pair state
for p in ALL_PAIRS:
    pairState[p] = {
        price: None, candles: [], loaded: False,
        lastSignal: None, signalExpired: False,
        _lastCandleClose: None, _lastLogTime: 0,
        _tp1Hit: False, _slHit: False,
        _isBoom: True,
        _spikeProbability: 0,
        _isGrinding: False,
        _isExhausted: False,
        _pendingSpike: None,
        _signalSent: False,
        _signalClosed: False,
        _lastSignalProb: 0,
        _lastSpikeLogTime: 0,
        _signalGenerated: False,
        _tpPrice: None,
        _slPrice: None,
        _entryPrice: None,
        _hasActiveOperation: False
    }
    lastCandleKey[p] = None
    candleCloseProcessed[p] = False
    lastSignalTime[p] = 0

# Define functions
def addLog(msg, type):
    time = new Date().toLocaleTimeString()
    tradeLogs.unshift({ time: time, msg: msg, type: type })
    if len(tradeLogs) > 200:
        tradeLogs.pop()
    print(f'[{time}] {msg}')

def sendTelegramMessage(message):
    url = f'https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage'
    response = requests.post(url, json={'chat_id': TELEGRAM_CHAT, 'text': message, 'parse_mode': 'HTML'})
    return response.json().get('ok', False)

def round4(n):
    return round(float(n), 4)

def hasGrindingConfirmation(candles, lookback=8):
    if len(candles) < lookback:
        return True
    recent = candles[-lookback:]
    high = max(recent)
    low = min(recent)
    range = ((high - low) / high) * 100
    result = range < CONFIG['CONFIRMATION_RANGE']
    if not result:
        addLog(f'Confirmacion grinding fallida: rango {range:.2f}% (max {CONFIG["CONFIRMATION_RANGE"]}%)', 'info')
    return result

def calculateTPSL(price, candles, isBoom):
    lookback = min(5, len(candles))
    avgRange = 0
    if len(candles) >= lookback:
        recent = candles[-lookback:]
        totalRange = sum(abs(recent[i] - recent[i-1]) for i in range(1, len(recent)))
        avgRange = totalRange / (len(recent) - 1)
    if avgRange == 0 or isNaN(avgRange):
        avgRange = price * 0.0025

    slPercent = max(0.0015, min(0.0050, avgRange / price * 1.5))
    slBase = CONFIG['SL_BASE'] / 100
    slPercentFinal = max(0.0015, min(0.0050, slPercent + slBase))
    slDistance = price * slPercentFinal
    tpRatio = CONFIG['TP_RATIO']
    tpDistance = slDistance * tpRatio

    slPrice, tp1 = None, None
    if isBoom:
        slPrice = round4(price - slDistance)
        tp1 = round4(price + tpDistance)
    else:
        slPrice = round4(price + slDistance)
        tp1 = round4(price - tpDistance)
    if tp1 == price:
        tp1 = round4(price + slDistance * 1.1) if isBoom else round4(price - slDistance * 1.1)
    if slPrice == price:
        slPrice = round4(price - slDistance * 0.9) if isBoom else round4(price + slDistance * 0.9)

    return {
        slPrice: slPrice,
        tp1: tp1,
        slPercent: slPercentFinal * 100,
        tpPercent: (tpDistance / price) * 100
    }

def calculateSpikeProbability(sym):
    st = pairState[sym]
    if not st['candles'] or len(st['candles']) < CONFIG['MIN_CANDLES']:
        addLog(f'{sym}: Velas insuficientes ({len(st["candles"])}/{CONFIG["MIN_CANDLES"]})', 'info')
        return 0
    candles = st['candles']
    lookback = min(CONFIG['LOOKBACK'], len(candles) - 5)
    recentCandles = candles[-lookback:]
    high = max(recentCandles)
    low = min(recentCandles)
    range = ((high - low) / high) * 100
    mean = sum(recentCandles) / len(recentCandles)
    variance = sum((b - mean) ** 2 for b in recentCandles) / len(recentCandles)
    stdDev = variance ** 0.5
    momentum = (candles[-1] - candles[-6]) / candles[-6] * 100
    grindingThreshold = CONFIG['GRINDING_THRESHOLD']
    isGrinding = range < grindingThreshold and stdDev < 5
    isExhausted = abs(momentum) < MOMENTUM_THRESHOLD
    st['_isGrinding'] = isGrinding
    st['_isExhausted'] = isExhausted
    probability = 0
    signalType = None
    if isGrinding and isExhausted:
        baseProb = 50 + (1 - range / grindingThreshold) * 30
        boost = random.random() * 15
        probability = min(99, int(baseProb + boost))
        signalType = 'MULTUP'
        st['_pendingSpike'] = { 'probability': probability, 'signalType': signalType }
        addLog(f'{sym}: GRINDING {range:.2f}% | Prob: {probability}%', 'spike')
    else:
        st['_pendingSpike'] = None
        if st['_signalClosed']:
            st['_signalSent'] = False
            st['_lastSignalProb'] = 0
        if not isGrinding:
            addLog(f'{sym}: No grinding (rango {range:.2f}% > {grindingThreshold}%)', 'info')
    st['_spikeProbability'] = probability
    return probability

def checkSpikeSignal(sym):
    st = pairState[sym]
    if not st or st['price'] is None or not st['candles'] or len(st['candles']) < CONFIG['MIN_CANDLES']:
        return None
    if not signalsActive:
        return None
    if st['_hasActiveOperation']:
        return None
    if st['_signalClosed']:
        st['_signalSent'] = False
        st['_lastSignalProb'] = 0
        return None
    if not hasGrindingConfirmation(st['candles']):
        return None
    probability = calculateSpikeProbability(sym)
    if st['_pendingSpike'] and not st['_signalSent'] and not st['_signalClosed']:
        signalType = st['_pendingSpike']['signalType']
        price = st['price']
        result = calculateTPSL(price, st['candles'], True)
        signal = {
            'sym': sym,
            'type': signalType,
            'price': price,
            'tp1': result['tp1'],
            'sl': result['slPrice'],
            'slPercent': result['slPercent'],
            'tpPercent': result['tpPercent'],
            'probability': st['_pendingSpike']['probability'],
            'time': new Date().toLocaleTimeString(),
            'status': 'PENDIENTE'
        }
        st['_signalSent'] = True
        st['_signalClosed'] = False
        st['_lastSignalProb'] = st['_pendingSpike']['probability']
        st['_signalGenerated'] = True
        st['_tpPrice'] = signal['tp1']
        st['_slPrice'] = signal['sl']
        st['_entryPrice'] = price
        st['_hasActiveOperation'] = True
        addLog(f'{sym}: SEÑAL {signal["probability"]}% | Entry: ${price:.4f} | TP: ${signal["tp1"]:.4f} | SL: ${signal["sl"]:.4f}', 'signal')
        return signal
    return None

def checkRealTimeTP_SL(sym):
    st = pairState[sym]
    if not st or not st['lastSignal'] or st['signalExpired']:
        return
    signal = st['lastSignal']
    price = st['price']
    isBoom = True
    if not st['_tp1Hit']:
        if (isBoom and price >= signal['tp1']) or (not isBoom and price <= signal['tp1']):
            st['_tp1Hit'] = True
            st['signalExpired'] = True
            st['_signalClosed'] = True
            st['_hasActiveOperation'] = False
            signal['status'] = 'TP1'
            global wins
            wins += 1
            gain = ((price - st['_entryPrice']) / st['_entryPrice'] * 100)
            addLog(f'{sym}: TP ALCANZADO (+{gain:.2f}%)', 'success')
            if signal.get('telegram'):
                sendTelegramMessage(f'TP ALCANZADO\n\n{sym}\nCOMPRA\nEntrada: ${st["_entryPrice"]:.4f}\nTP: ${signal["tp1"]:.4f}\nCierre: ${price:.4f}\n+{gain:.2f}%')
            resetPairState(sym)
            return
    if not st['_tp1Hit'] and not st['_slHit']:
        if (isBoom and price <= signal['sl']) or (not isBoom and price >= signal['sl']):
            st['_slHit'] = True
            st['signalExpired'] = True
            st['_signalClosed'] = True
            st['_hasActiveOperation'] = False
            signal['status'] = 'SL'
            global losses
            losses += 1
            loss = ((st['_entryPrice'] - price) / st['_entryPrice'] * 100)
            addLog(f'{sym}: SL EJECUTADO (-{loss:.2f}%)', 'error')
            if signal.get('telegram'):
                sendTelegramMessage(f'SL EJECUTADO\n\n{sym}\nCOMPRA\nEntrada: ${st["_entryPrice"]:.4f}\nSL: ${signal["sl"]:.4f}\nCierre: ${price:.4f}\n-{loss:.2f}%')
            resetPairState(sym)
            return

def resetPairState(sym):
    st = pairState[sym]
    if not st:
        return
    st['_signalClosed'] = False
    st['_signalSent'] = False
    st['_tp1Hit'] = False
    st['_slHit'] = False
    st['signalExpired'] = False
    st['lastSignal'] = None
    st['_lastSignalProb'] = 0
    st['_pendingSpike'] = None
    st['_signalGenerated'] = False
    st['_tpPrice'] = None
    st['_slPrice'] = None
    st['_entryPrice'] = None
    st['_hasActiveOperation'] = False

def analyzeSignal(sym):
    global isProcessingQueue, analysisQueue
    if isProcessingQueue:
        analysisQueue.append(sym)
        return
    isProcessingQueue = True
    try:
        st = pairState[sym]
        if not st or st['price'] is None or not st['candles'] or len(st['candles']) < CONFIG['MIN_CANDLES']:
            isProcessingQueue = False
            processNextInQueue()
            return
        if not signalsActive:
            isProcessingQueue = False
            processNextInQueue()
            return
        st['_lastCandleClose'] = st['price']
        if st['lastSignal'] and not st['signalExpired']:
            checkRealTimeTP_SL(sym)
            if st['signalExpired']:
                isProcessingQueue = False
                processNextInQueue()
                return
            isProcessingQueue = False
            processNextInQueue()
            return
        if st['_signalClosed']:
            resetPairState(sym)
            isProcessingQueue = False
            processNextInQueue()
            return
        if not st['lastSignal'] or st['signalExpired']:
            signal = checkSpikeSignal(sym)
            if signal:
                st['lastSignal'] = signal
                st['signalExpired'] = False
                st['_tp1Hit'] = False
                st['_slHit'] = False
                st['_signalClosed'] = False
                st['_lastSignalProb'] = 0
                st['_tpPrice'] = signal['tp1']
                st['_slPrice'] = signal['sl']
                st['_entryPrice'] = signal['price']
                lastSignalTime[sym] = time.time()
                global totalSignals
                totalSignals += 1
                msg = f'KRAKEN PRO - SEÑAL\n\nPar: {signal["sym"]}\nDireccion: COMPRA\nProbabilidad: {signal["probability"]}%\nEntrada: ${signal["price"]:.4f}\nTP1: ${signal["tp1"]:.4f}\nSL: ${signal["sl"]:.4f}\nSL %: {signal["slPercent"]:.2f}%\nTP %: {signal["tpPercent"]:.2f}%\nHora: {signal["time"]}\n\nKRAKEN PRO - FILTROS FLEXIBLES\n1 OPERACION POR PAR'
                sendTelegramMessage(msg)
                signal['telegram'] = True
                isProcessingQueue = False
                processNextInQueue()
                return
        calculateSpikeProbability(sym)
    except Exception as e:
        addLog(f'Error en {sym}: {e.message}', 'error')
    isProcessingQueue = False
    processNextInQueue()

def processNextInQueue():
    global analysisQueue, isProcessingQueue
    if len(analysisQueue) > 0:
        nextSym = analysisQueue.pop(0)
        analyzeSignal(nextSym)

def handleMsg(data):
    if data.get('error'):
        err = data['error'].get('message', '')
        if not err or ('rate limit' in err or 'already subscribed' in err):
            return
        addLog(f'Error: {err}', 'error')
        return
    t = data.get('msg_type')
    if t == 'balance' or data.get('balance'):
        bal = data.get('balance', {}).get('balance') or data.get('balance')
        if bal and isinstance(bal, (int, float)):
            global botStats
            botStats['balance'] = float(bal)
        return
    if t == 'candles' or data.get('candles'):
        sym = data.get('passthrough', {}).get('symbol')
        candles = data.get('candles', [])
        st = pairState.get(sym)
        if not st or not candles:
            return
        st['candles'] = [float(c['close']) if isinstance(c, dict) else float(c) for c in candles]
        st['price'] = st['candles'][-1]
        st['loaded'] = True
        st['_lastCandleClose'] = st['price']
        global dataLoaded
        dataLoaded = True
        addLog(f'{sym}: {len(st["candles"])} velas 5min cargadas', 'info')
        return
    if t == 'tick' or data.get('tick'):
        sym = data.get('tick', {}).get('symbol') or data.get('symbol')
        st = pairState.get(sym)
        if not st or not data.get('tick', {}).get('quote'):
            return
        st['price'] = float(data['tick']['quote'])
        if dataLoaded and signalsActive and st['lastSignal'] and not st['signalExpired']:
            checkRealTimeTP_SL(sym)
        now = datetime.datetime.now()
        minutes = (now.minute // 5) * 5
        candleKey = f'{now.hour}:{minutes:02d}'
        if lastCandleKey[sym] and lastCandleKey[sym] != candleKey:
            if not candleCloseProcessed[sym]:
                candleCloseProcessed[sym] = True
                closePrice = st['price']
                st['candles'].append(closePrice)
                if len(st['candles']) > CONFIG['MAX_CANDLES']:
                    st['candles'].pop(0)
                st['_lastCandleClose'] = closePrice
                if dataLoaded and signalsActive:
                    analyzeSignal(sym)
        else:
            candleCloseProcessed[sym] = False
        lastCandleKey[sym] = candleKey

def openWS(url):
    global ws, signalsActive, running, reconnectAttempts, reconnectTimer, activationSent
    if ws:
        try:
            ws.close()
        except Exception as e:
            pass
    ws = WebSocket(url)
    ws.onopen = lambda: (
        addLog('Conectado a Deriv WebSocket', 'success'),
        ws.send(json.dumps({'ticks_history': p, 'count': CONFIG['MAX_CANDLES'], 'end': 'latest', 'granularity': TIMEFRAME, 'style': 'candles', 'passthrough': {'symbol': p}})) for p in ALL_PAIRS,
        ws.send(json.dumps({'ticks': p, 'subscribe': 1})) for p in ALL_PAIRS,
        setTimeout(lambda: (signalsActive := True, running := True, addLog('KRAKEN PRO - SEÑALES ACTIVADAS', 'start'), activationSent and sendTelegramMessage('KRAKEN PRO ACTIVADO\n\nBot conectado\nMonitoreando BOOM500, BOOM600, BOOM900, BOOM1000\nFILTROS FLEXIBLES\nTemporalidad: 5 minutos\n1 OPERACION POR PAR\nEsperando señales...') or (activationSent := True)), 5000)
    )
    ws.onclose = lambda: (addLog('WebSocket cerrado', 'warn'), running and scheduleReconnect())
    ws.onerror = lambda: None
    ws.onmessage = lambda e: (handleMsg(json.loads(e.data)) if e.data else addLog('Error procesando mensaje: ' + e.message, 'error'))

def scheduleReconnect():
    global reconnectAttempts, reconnectTimer
    if reconnectTimer:
        clearTimeout(reconnectTimer)
    if reconnectAttempts >= 20:
        addLog('Max reintentos', 'error')
        return
    reconnectAttempts += 1
    delay = 5000 * reconnectAttempts
    addLog(f'Reconexion {reconnectAttempts} en {delay/1000:.0f}s', 'warn')
    reconnectTimer = setTimeout(lambda: (ws and ws.readyState == 1 and (reconnectAttempts := 0) or connectDeriv()), delay)

async def connectDeriv():
    addLog('Conectando a Deriv...', 'info')
    try:
        headers = {'Deriv-App-ID': APP_ID, 'Authorization': f'Bearer {PAT_TOKEN}', 'Content-Type': 'application/json'}
        accResp = await requests.get(f'{REST_BASE}/trading/v1/options/accounts', headers=headers)
        if not accResp.ok:
            raise Exception(f'Error {accResp.status}')
        accData = accResp.json()
        allAccounts = accData.get('data', [])
        account = next((a for a in allAccounts if a['account_type'] == 'real'), allAccounts[0])
        otpResp = await requests.post(f'{REST_BASE}/trading/v1/options/accounts/{account["account_id"]}/otp', headers=headers)
        if not otpResp.ok:
            raise Exception('Error OTP')
        d = otpResp.json()
        if not d.get('data') or not d['data'].get('url'):
            raise Exception('Sin URL')
        addLog(f'Cuenta: {account["account_id"]} ({account["account_type"].upper()})', 'success')
        openWS(d['data']['url'])
    except Exception as e:
        addLog(f'Error conexion: {e.message}', 'error')
        scheduleReconnect()

# Start the server
app = Flask(__name__)
app.use(express.static('public'))

@app.route('/')
def index():
    return send_file(path.join(__dirname, 'views', 'index.html'))

@app.route('/api/stats')
def stats():
    total = wins + losses
    wr = (wins / total * 100) if total > 0 else 0
    return json.dumps({
        'balance': botStats['balance'],
        'winRate': round(wr),
        'wins': wins,
        'losses': losses,
        'totalSignals': totalSignals,
        'totalTrades': total,
        'netPips': 0,
        'logs': tradeLogs[:50]
    })

@app.route('/ping')
def ping():
    return 'KRAKEN PRO - Activo ' + datetime.datetime.now().isoformat(), 200

PORT = int(os.environ.get('PORT', 3000))
app.listen(PORT, '0.0.0.0', lambda: (print(f'Servidor web en puerto {PORT}'), print('https://kraken-pro-bot-production.up.railway.app')))

addLog('Iniciando KRAKEN PRO (FILTROS FLEXIBLES)...', 'info')
setTimeout(lambda: sendTelegramMessage(f'KRAKEN PRO INICIADO\n\nConectando a Deriv...\nEl bot se activara automaticamente\n{len(ALL_PAIRS)} simbolos\nFILTROS FLEXIBLES\nTemporalidad: 5 minutos\n1 OPERACION POR PAR\n{datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")}'), 3000)
connectDeriv()
