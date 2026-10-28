# Market Ticker (v1, Yahoo Finance)

The first version of the Market Ticker Chrome extension: a draggable floating widget with live NSE/BSE prices that refresh every 30 seconds, plus TradingView sparklines on tap.

> **Superseded.** The current extension lives in [Market-Trading-Widget](https://github.com/JyotbirLamba13/Market-Trading-Widget) and uses TradingView's scanner for prices.

## What it does

- Floating, draggable price widget on any page
- Index/pinned and watchlist panels you can toggle
- Sparkline chart when you tap a symbol
- Dark and light themes

## Run it locally

1. Clone the repo.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the repo folder.

## How it is built

Plain JavaScript, Manifest V3. Prices come from the Yahoo Finance chart API (`query1.finance.yahoo.com`); sparklines use TradingView's embeddable mini chart. Settings are kept in `chrome.storage`.
