#🤖 Q-big-One AI Trading Agent
An autonomous quantitative trading agent designed to run inside the Q-big-One Prop Trading ecosystem.
This agent leverages a hybrid approach: fast mathematical indicators (EMA, RSI, Bollinger Bands) computed locally, combined with the reasoning power of Large Language Models (Local Llama 3.2 via Ollama or Cloud-based Claude 3/GPT-4).
The agent is designed to autonomously "mine Alpha" by passing prop firm challenges. It connects to the B-Book sandbox, manages risk, and trades 24/7.

#✨ Features
Anonymous Web3-style Auth: Zero friction. The agent automatically mints an anonymous JWT and "claims" a free $10k funded account from the exchange pool.
LLM-Driven Decisions: Feeds live market data, technical indicators, and open positions state into an LLM (Ollama/Anthropic) to make logical trade decisions (BUY, SELL, HOLD, or FLIP).
Risk Engine (Kill Switch): Built-in hard limits for Max Drawdown and Max Concurrent Positions. If the agent exceeds the drawdown threshold (e.g., 5%), it gracefully stops and releases the account back to the pool.
State Persistence: Remembers its High Water Mark (Peak Balance) between Docker restarts to ensure accurate trailing drawdown calculations.
100% Free to Run: Fully supports local Llama 3.2 models via Ollama. No API costs.

#⚙️ Architecture & Data Flow
Auth & Claim: The agent hits /api/auth/anonymous to get a JWT, then scans the public /api/accounts pool. It claims the first available empty account.
WebSocket Stream: Connects to the Core Engine WS to receive sub-millisecond price updates.
Event Loop (Every X seconds):
Fetches the latest M1 candles (REST API).
Computes EMA(9), EMA(21), RSI(14), and Bollinger Bands.
Fetches current account equity and open positions.
Checks the Kill Switch (Drawdown Guard).
Sends a JSON prompt to the LLM containing the market snapshot.
Execution: Parses the LLM's JSON response. If the trend reverses, the agent automatically executes a FLIP (closes contrary positions before opening new ones via /api/order).

#🚀 How to Run
You can run the agent locally for development or inside a Docker container alongside the core engine.
Prerequisites
Node.js 18+ or Docker
Running instance of Q-big-One Core Engine
Ollama running locally (if using local LLMs)

#Option 1: Local Development (Node.js)
Perfect for testing strategies on your laptop while connecting to a remote (or local) Q-big-One server.
1) Clone and install dependencies:

git clone https://github.com/mibii/Q-big-One-AI-Trading-Agent

cd Q-big-One-AI-Trading-Agent

npm install

2) Create a .env file:
Create a .env file in the root of the agent directory. 

API_BASE=https://qbig.one
WS_URL=wss://qbig.one/ws

Trading Settings
SYMBOL=BTCUSDT
QUANTITY=0.01
LOOP_INTERVAL=30
MAX_DRAWDOWN_PCT=5.0
MAX_POSITIONS=2

LLM Settings (Ollama Llama 3.2 example)
OLLAMA_URL=http://127.0.0.1:11434/api/chat
OLLAMA_MODEL=llama3.2

LLM Settings (Anthropic Claude example - uncomment to use)
// ANTHROPIC_API_KEY=sk-ant-api03...
3. Run the agent:

npm run dev


#Option 2: Production (Docker Compose)
Ideal for running a fleet of agents 24/7 on the same server as your Q-big-One Core Engine. This method provides ultra-low latency (<1ms) because it communicates entirely within the internal Docker network.
1. Add the service to your main docker-compose.yml:

 --- AI AGENT (BTC) ---
  ai_agent_btc:
    build:
      context: ./qbig-ai-agent
    container_name: qbig_agent_btc
    restart: unless-stopped
    depends_on:
      - backend
      - gateway
    networks:
      - trading-net
    environment:
      # Internal Docker network routing (No SSL overhead)
      - API_BASE=http://gateway:80
      - WS_URL=ws://gateway:80/ws
      
      # Trading Settings
      - SYMBOL=BTCUSDT
      - QUANTITY=0.01
      - LOOP_INTERVAL=30
      - MAX_POSITIONS=2
      - MAX_DRAWDOWN_PCT=5.0
      
      # Local LLM Routing (Use host.docker.internal to reach Ollama on host)
      - OLLAMA_URL=http://host.docker.internal:11434/api/chat
      - OLLAMA_MODEL=llama3.2
      - TRADER_ID=AI_BOT_BTCUSDT # Unique ID to persist state
    volumes:
      - ./agent_data:/app/data # State persistence (Peak Balance)
2. Build and start:

docker-compose up -d --build ai_agent_btc
3. View live logs:
code
Bash
docker logs -f qbig_agent_btc

#🧠 Customizing the LLM Strategy
The core decision-making logic resides in src/index.ts inside the getLlmSignal method.
You can modify the systemPrompt to change the agent's personality and risk appetite:
code
TypeScript
const systemPrompt = `You are a quantitative trading AI...
Rules:
1. ...
2. ...
Output format: {"action": "BUY"|"SELL"|"HOLD", "confidence": 0-100, "reason": "..."}`;
Note: Llama 3.2 strongly respects the format: "json" API parameter, which guarantees parseable outputs.
⚖️ License
MIT License. 