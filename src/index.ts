import axios from 'axios';
import WebSocket from 'ws';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { calcEma, calcRsi, calcBollinger, Candle } from './indicators';

dotenv.config();

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const API_BASE = process.env.API_BASE || 'http://gateway:80'; 
const WS_URL = process.env.WS_URL || 'ws://gateway:80/ws';

// ✅ НАСТРОЙКИ OLLAMA
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2'; // Имя скачанной модели

//const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const QUANTITY = parseFloat(process.env.QUANTITY || '0.1');
const LOOP_INTERVAL = parseInt(process.env.LOOP_INTERVAL || '30') * 1000;

const MAX_DRAWDOWN_PCT = parseFloat(process.env.MAX_DRAWDOWN_PCT || '5.0');
const MAX_DRAWUP_PCT = parseFloat(process.env.MAX_DRAWUP_PCT || '10.0'); // ✅ НОВАЯ 

const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || '2');
// Если задан TRADER_ID в .env, используем его (полезно для перезапусков контейнера)
const TRADER_ID = process.env.TRADER_ID || `AI_${SYMBOL}_${Date.now()}`;

// Файл для сохранения состояния (Peak Balance) между рестартами контейнера
const STATE_FILE = path.join(__dirname, `../data/state_${SYMBOL}.json`);

//const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

class QBigAgent {
    private jwt: string | null = null;
    private accountId: string | null = null;
    private prices: { bid: number, ask: number } = { bid: 0, ask: 0 };
    private peakBalance: number = 0;
    private startBalance: number = 0; 
    private running: boolean = false;

    async start() {
        console.log(`\n🤖 Starting Autonomous Agent [${TRADER_ID}] for ${SYMBOL}...`);
        
        this.loadState(); // Загружаем Peak Balance (если контейнер перезапустился)

        if (!await this.authenticate()) return;
        
        // Пытаемся найти уже наш аккаунт, если нет - клеймим новый
        if (!await this.resumeOrClaimAccount()) return;

        this.connectWebSocket();
        this.running = true;

        console.log(`⏳ Waiting for ${SYMBOL} live prices...`);
        await new Promise(r => setTimeout(r, 3000));

        this.runLoop();
    }

    async stop(reason: string = "Manual stop") {
        console.log(`\n🛑 Stopping agent: ${reason}`);
        this.running = false;
        
        if (this.accountId && this.jwt) {
            try {
                // 1. Закрываем все позиции
                console.log(`   🧹 Closing all open positions for ${this.accountId}...`);
                const closeRes = await axios.post(`${API_BASE}/api/position/close-bulk`, {
                    accountId: this.accountId
                }, {
                    headers: { Authorization: `Bearer ${this.jwt}` }
                });

                const closedCount = Number(closeRes.data?.closed || 0);
                const totalPnl = Number(closeRes.data?.totalPnl || 0); // ✅ Безопасный Number()

                if (closedCount > 0) {
                    console.log(`   ✅ Closed ${closedCount} positions. Realized PnL: $${totalPnl.toFixed(2)}`);
                } else {
                    console.log(`   ℹ️ No open positions to close.`);
                }

                // 2. Сдаем ключи
                console.log(`   🔑 Releasing account ${this.accountId}...`);
                await axios.post(`${API_BASE}/api/accounts/${this.accountId}/release`, {}, {
                    headers: { Authorization: `Bearer ${this.jwt}` }
                });
                console.log(`   ✅ Account successfully released to the pool.`);

            } catch (e: any) {
                console.error(`   ❌ Error during graceful shutdown:`, e.response?.data || e.message);
            }
        }
        
        console.log(`👋 Agent shutdown complete.\n`);
        process.exit(0);
    }

    // ─── 1. ПЕРСИСТЕНТНОСТЬ (Сохранение Peak Balance) ───────────────────────

    private loadState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
                this.peakBalance = data.peakBalance || 0;
                this.startBalance = data.startBalance || 0; // ✅ ЗАГРУЖАЕМ
                console.log(`📂 Loaded state: Start = $${this.startBalance.toFixed(2)} | Peak = $${this.peakBalance.toFixed(2)}`);
            } else {
                const dir = path.dirname(STATE_FILE);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            }
        } catch (e) {
            console.error(`⚠️ Failed to load state file:`, e);
        }
    }

    private saveState(currentBalance: number) {
        let changed = false;
        
        // Обновляем пик
        if (currentBalance > this.peakBalance) {
            this.peakBalance = currentBalance;
            changed = true;
        }

        // Если стартовый баланс еще 0 (первый запуск), инициализируем его
        if (this.startBalance === 0 && currentBalance > 0) {
            this.startBalance = currentBalance;
            changed = true;
        }

        if (changed) {
            try {
                // ✅ СОХРАНЯЕМ ОБА ПОЛЯ
                fs.writeFileSync(STATE_FILE, JSON.stringify({ 
                    peakBalance: this.peakBalance,
                    startBalance: this.startBalance 
                }));
            } catch (e) {}
        }
    }

    // ─── 2. АВТОРИЗАЦИЯ И АККАУНТ ───────────────────────────────────────────
    private async authenticate(): Promise<boolean> {
        try {
            const res = await axios.post(`${API_BASE}/api/auth/anonymous`, { trader_id: TRADER_ID });
            this.jwt = res.data.token;
            console.log(`🔑 Auth success. JWT obtained.`);
            return true;
        } catch (e: any) {
            console.error(`❌ Auth failed: ${e.message}`);
            return false;
        }
    }

    private async resumeOrClaimAccount(): Promise<boolean> {
        try {
            const res = await axios.get(`${API_BASE}/api/accounts`);
            const accounts = res.data.accounts || [];
            
            // Сначала ищем СВОЙ аккаунт (если контейнер упал и поднялся)
            const myAcc = accounts.find((a: any) => a.ownerId === TRADER_ID);
            if (myAcc) {
                this.accountId = myAcc.accountId;
                if (this.peakBalance === 0) this.peakBalance = Number(myAcc.balance);
                console.log(`🔄 Resumed existing session: ${this.accountId}`);
                return true;
            }

            // Если своего нет, ищем свободный
            const free = accounts.find((a: any) => !a.ownerId);
            if (!free) {
                console.error(`❌ No free accounts available in the pool.`);
                return false;
            }

            await axios.post(`${API_BASE}/api/accounts/${free.accountId}/claim`, {}, {
                headers: { Authorization: `Bearer ${this.jwt}` }
            });

            this.accountId = free.accountId;
            this.peakBalance = Number(free.balance);
            this.saveState(this.peakBalance);
            console.log(`🏦 Claimed new account: ${this.accountId}`);
            return true;
        } catch (e: any) {
            console.error(`❌ Claim failed:`, e.message);
            return false;
        }
    }

    // ─── 3. WEBSOCKET ───────────────────────────────────────────────────────
    private connectWebSocket() {
        const ws = new WebSocket(WS_URL);
        ws.on('open', () => console.log('🌐 WS Connected'));
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'PRICE_UPDATE' && msg.symbol === SYMBOL) {
                    this.prices = { bid: Number(msg.bid), ask: Number(msg.ask) };
                }
            } catch (e) {}
        });
        ws.on('error', () => {});
        ws.on('close', () => {
            if (this.running) setTimeout(() => this.connectWebSocket(), 3000);
        });
    }

    // ─── 4. ГЛАВНЫЙ ЦИКЛ ────────────────────────────────────────────────────
    private async runLoop() {
        while (this.running) {
            try {
                const now = new Date().toLocaleTimeString();
                
                const [accRes, posRes, candlesRes] = await Promise.all([
                    axios.get(`${API_BASE}/api/account/${this.accountId}`),
                    axios.get(`${API_BASE}/api/positions/${this.accountId}`),
                    axios.get(`${API_BASE}/api/getcharthistory?symbol=${SYMBOL}&timeframe=60&limit=120`)
                ]);

                const account = accRes.data;
                const eq = Number(account.equity || account.equityValue || 0);
                const bal = Number(account.balance || 0);
                
                // Обновляем персистентный максимум
                this.saveState(bal);

                let allPositions = Array.isArray(posRes.data) ? posRes.data : (posRes.data.positions || []);
                // Фильтруем позиции только для нашего символа (агент торгует только 1 символом)
                const activePositions = allPositions.filter((p: any) => p.symbol === SYMBOL);

               // --- RISK GUARD (KILL SWITCH) ---
                const drawdown = this.peakBalance > 0 ? ((this.peakBalance - eq) / this.peakBalance) * 100 : 0;
                
                // ✅ РАСЧЕТ PROFIT TARGET (DRAW-UP)
                const drawup = this.startBalance > 0 ? ((eq - this.startBalance) / this.startBalance) * 100 : 0;
                
                console.log(`\n[${now}] 📊 Eq: $${eq.toFixed(2)} | Peak: $${this.peakBalance.toFixed(2)} | DD: -${drawdown.toFixed(2)}% | Profit: +${drawup.toFixed(2)}% | Pos: ${activePositions.length}`);

                // 1. Проверка просадки (Убыток)
                if (drawdown >= MAX_DRAWDOWN_PCT) {
                    await this.stop(`Drawdown limit reached! ${drawdown.toFixed(2)}% >= ${MAX_DRAWDOWN_PCT}%`);
                    return;
                }

                // 2. ✅ Проверка профита (Победа)
                if (drawup >= MAX_DRAWUP_PCT) {
                    await this.stop(`🎯 Profit target reached! +${drawup.toFixed(2)}% >= +${MAX_DRAWUP_PCT}%`);
                    
                    // Опционально: если цель выполнена, мы можем удалить файл стейта,
                    // чтобы при следующем запуске бот начал "новую жизнь" (с чистого листа).
                    try {
                        if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
                        console.log(`   🗑️ State file cleared for a fresh start next time.`);
                    } catch (e) {}
                    
                    return;
                }

                // Нормализация свечей
                let rawCandles: any[] = Array.isArray(candlesRes.data) ? candlesRes.data : (candlesRes.data.candles || []);
                let candles: Candle[] = rawCandles.map((c: any) => ({
                    time: Number(c.timestamp) > 1e10 ? Math.floor(Number(c.timestamp)/1000) : Number(c.timestamp),
                    open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close)
                })).sort((a,b) => a.time - b.time);

                if (candles.length < 25) {
                    console.log(`   ⚠️ Not enough candles (${candles.length}). Waiting...`);
                    await new Promise(r => setTimeout(r, LOOP_INTERVAL));
                    continue;
                }

                // --- ИНДИКАТОРЫ ---
                const closes = candles.map(c => c.close);
                const ema9 = calcEma(closes, 9);
                const ema21 = calcEma(closes, 21);
                const rsi = calcRsi(closes, 14);
                const bb = calcBollinger(closes, 20);

                const currentRsi = rsi[rsi.length - 1];
                const e9 = ema9[ema9.length - 1];
                const e21 = ema21[ema21.length - 1];

                // --- LLM АНАЛИЗ ---
                const signal = await this.getLlmSignal(
                    candles.slice(-10), currentRsi, e9, e21, bb, activePositions
                );
                
                // --- ИСПОЛНЕНИЕ СИГНАЛА ---
                if (signal.action === "HOLD" || signal.confidence < 60) {
                    console.log(`   ⏸️ Holding. Reason: ${signal.reason}`);
                } else {
                    await this.handleExecution(signal.action, activePositions);
                }

            } catch (e: any) {
                console.error(`   ❌ Loop Error: ${e.message}`);
            }
            
            await new Promise(r => setTimeout(r, LOOP_INTERVAL));
        }
    }


    // ─── 5. LLM ЛОГИКА (ЧЕРЕЗ OLLAMA Llama 3.2) ─────────────────────────────────
    private async getLlmSignal(
        recentCandles: Candle[], rsi: number, ema9: number, ema21: number, bb: any, positions: any[]
    ) {
        const posSummary = positions.length === 0 
            ? "NONE" 
            : positions.map(p => `${p.side === 1 || p.side === 'Buy' ? 'LONG' : 'SHORT'} ${p.quantity} @ ${p.openPrice || p.entryPrice} (PnL: $${p.pnl})`).join("; ");

        // Llama 3.2 любит четкие системные промпты
        const systemPrompt = `You are a quantitative trading AI. You analyze market data and output strict JSON only.
No markdown, no conversation, no explanations outside of the JSON object.
Output format: {"action": "BUY"|"SELL"|"HOLD", "confidence": 0-100, "reason": "short explanation"}

Rules:
1. If you hold a LONG position and trend reverses (EMA9 < EMA21 or RSI > 70), action="SELL" to flip.
2. If you hold a SHORT position and trend reverses (EMA9 > EMA21 or RSI < 30), action="BUY" to flip.
3. If NO positions: BUY on strong uptrend (EMA9 > EMA21) or oversold (RSI < 30). SELL on strong downtrend or overbought (RSI > 70).
4. If MAX POSITIONS reached and trend continues, action="HOLD".
5. Preserve capital. If mixed signals, action="HOLD".`;

        const userPrompt = `
Analyze this data for ${SYMBOL}.
Current Price: BID=${this.prices.bid}, ASK=${this.prices.ask}
Indicators: RSI(14)=${rsi.toFixed(2)}, EMA(9)=${ema9.toFixed(5)}, EMA(21)=${ema21.toFixed(5)}
Bollinger: Upper=${bb?.upper.toFixed(5)}, Lower=${bb?.lower.toFixed(5)}
Recent Closes: ${recentCandles.map(c => c.close.toFixed(5)).join(', ')}

CURRENT OPEN POSITIONS: [${posSummary}]
MAX ALLOWED POSITIONS: ${MAX_POSITIONS}

What is your trading decision?`;

        try {
            // ✅ ВЫЗОВ OLLAMA API
            const response = await axios.post(OLLAMA_URL, {
                model: OLLAMA_MODEL,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                stream: false,
                format: "json", // 🔥 КИЛЛЕР-ФИЧА: Заставляет Llama 3.2 выдать валидный JSON
                options: {
                    temperature: 0.1, // Низкая температура для логичных и детерминированных решений
                    num_predict: 150
                }
            });

            // Ответ Ollama лежит в message.content
            const text = response.data.message?.content || "{}";
            const result = JSON.parse(text.trim());
            
            console.log(`   🧠 Llama 3.2 Decision: ${result.action} (${result.confidence}%) - ${result.reason}`);
            
            // Защита от галлюцинаций модели: если экшен не распознан, делаем HOLD
            if (!["BUY", "SELL", "HOLD"].includes(result.action)) {
                result.action = "HOLD";
            }
            
            return result;
        } catch (e: any) {
            console.error(`   ❌ Ollama Error: ${e.message}`);
            return { action: "HOLD", confidence: 0, reason: "Error reaching local LLM" };
        }
    }

    // ─── 6. УМНОЕ ИСПОЛНЕНИЕ (Закрытие + Открытие) ──────────────────────────
    private async handleExecution(desiredAction: string, activePositions: any[]) {
        const sideInt = desiredAction === "BUY" ? 1 : 2;
        const oppositeSideInt = desiredAction === "BUY" ? 2 : 1;

        // 1. Ищем позиции, открытые ПРОТИВ нового сигнала (нужно их закрыть)
        const positionsToClose = activePositions.filter(p => {
            const pSide = typeof p.side === 'number' ? p.side : (p.side === 'Buy' ? 1 : 2);
            return pSide === oppositeSideInt;
        });

        for (const pos of positionsToClose) {
            console.log(`   🔄 FLIP: Closing contrary position ${pos.id || pos.positionId}...`);
            try {
                await axios.post(`${API_BASE}/api/position/close`, {
                    accountId: this.accountId,
                    positionId: pos.id || pos.positionId,
                    symbol: SYMBOL
                }, {
                    headers: { Authorization: `Bearer ${this.jwt}` }
                });
            } catch (e: any) {
                console.error(`   ❌ Failed to close position: ${e.message}`);
            }
        }

        // 2. Проверяем, не превысили ли мы лимит позиций в ОДНОМ направлении
        const currentSameSideCount = activePositions.length - positionsToClose.length;
        if (currentSameSideCount >= MAX_POSITIONS) {
            console.log(`   ⏸️ Already hold max positions (${MAX_POSITIONS}) in ${desiredAction} direction.`);
            return;
        }

        // 3. Открываем новую позицию
        try {
            await axios.post(`${API_BASE}/api/order`, {
                accountId: this.accountId,
                symbol: SYMBOL,
                side: sideInt,
                orderType: 1, // Market
                quantity: QUANTITY,
                timeInForce: "GTC"
            }, {
                headers: { Authorization: `Bearer ${this.jwt}` }
            });
            console.log(`   ✅ EXECUTED: ${desiredAction} ${QUANTITY} ${SYMBOL}`);
        } catch (e: any) {
            console.error(`   ❌ Order Failed: ${e.response?.data || e.message}`);
        }
    }
}

// ─── ЗАПУСК ─────────────────────────────────────────────────────────────────
const agent = new QBigAgent();
agent.start();

process.on('SIGINT', async () => {
    await agent.stop("Received SIGINT (Ctrl+C)");
});
process.on('SIGTERM', async () => {
    await agent.stop("Received SIGTERM (Docker stop)");
});