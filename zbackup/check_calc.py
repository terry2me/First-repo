import sqlite3
import json
from pathlib import Path

DB_PATH = Path("stock.db")

def check_db():
    if not DB_PATH.exists():
        print("DB file not found")
        return
    
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    
    # 1. Get a sample stock
    meta = conn.execute("SELECT ticker, name FROM stock_meta LIMIT 1").fetchone()
    if not meta:
        print("No stocks in DB")
        return
    
    ticker = meta['ticker']
    name = meta['name']
    print(f"Sample Stock: {name} ({ticker})")
    
    for interval in ['1d', '1wk']:
        print(f"\n--- Interval: {interval} ---")
        prices = conn.execute("SELECT date, close FROM stock_prices WHERE ticker=? AND interval=? ORDER BY date DESC LIMIT 60", (ticker, interval)).fetchall()
        if not prices:
            print(f"No price data for {interval}")
            continue
        
        prices = [dict(p) for p in reversed(prices)]
        cur = prices[-1]['close']
        prev = prices[-2]['close'] if len(prices) >= 2 else cur
        
        today_chg = cur - prev
        today_chg_pct = (today_chg / prev * 100) if prev else 0
        
        candle_count = 52
        period_prices = prices[-candle_count:]
        period_base = period_prices[0]['close']
        period_chg = cur - period_base
        period_chg_pct = (period_chg / period_base * 100) if period_base else 0
        
        print(f"Current Price: {cur}")
        print(f"Today Change: {today_chg:.2f} ({today_chg_pct:.2f}%)")
        print(f"Period Change (52): {period_chg:.2f} ({period_chg_pct:.2f}%)")

    conn.close()

if __name__ == "__main__":
    check_db()
