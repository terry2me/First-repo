import yfinance as yf
from datetime import datetime, timedelta

t = yf.Ticker("AAPL")
start = "2026-03-02"
end_dt = "2026-03-10"
df = t.history(start=start, end=end_dt, interval="1wk", auto_adjust=True)
print(f"AAPL Weekly {start} to {end_dt}: Empty={df.empty}, Rows={len(df)}")
if not df.empty:
    print(df.index)
