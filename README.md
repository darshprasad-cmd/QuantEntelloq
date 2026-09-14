# Quant Entelloq

A single-file financial intelligence platform built as a self-contained HTML SPA.

## Features

- **Intelligence Terminal** — Live news feed with Bullish/Bearish/Neutral sentiment classification, Economic Times + global RSS feeds, AI market briefing, sector snapshot, and economic calendar
- **AI Signals** — Quantitative signals powered by AI
- **Macro Intelligence** — Country-level macro indicator grids (US, EU, CN, JP, IN)
- **Research Radar** — arXiv q-fin paper feed with AI summarization
- **Sentiment Lab** — Real-time market sentiment gauge
- **Portfolio Tracker** — Position management and P&L
- **Quant Lab / Backtest** — Strategy backtesting engine
- **Scanner** — Opportunity scanner
- **AI Studio** — Conversational AI for market analysis
- **NewsJudge** → replaced by Intelligence Terminal

## Usage

Open `index.html` directly in any modern browser. No server required.

## Managed AI

Static hosting routes AI Studio, assistants, and agent calls directly to the
shared `groq-proxy.physicsedge.workers.dev` Worker over HTTPS. The owner's
`GROQ_API_KEY` belongs in that Worker's secret settings. No personal key, browser
storage entry, or global fetch rewrite is needed. Serve local previews over HTTP
and configure the Worker's development origin allowlist when testing locally.

Chat uses `openai/gpt-oss-120b`; routine calls use `openai/gpt-oss-20b`. Requests
hide reasoning and reserve at least 2048 completion tokens because GPT-OSS
counts reasoning in the output budget. Existing authenticated backend mode
continues using `/api/ai/stream` and `/api/ai/call`; configure its server secrets
as documented in `backend/README.md` when deploying that mode.

Worker deployment and a configured secret are required for live AI. The local
mocked regressions exercise request routing and response handling without keys.

## Frontend stack

Single-file HTML + CSS + JS (~1.7 MB). Uses:
- TradingView Lightweight Charts v4
- CORS proxy rotation for live RSS feeds
- HTML5 Canvas for sentiment gauge
- Vanilla JS — zero dependencies
