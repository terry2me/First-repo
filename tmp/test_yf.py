import yfinance as yf
from datetime import datetime, timedelta

def test_yf(ticker, interval):
    t = yf.Ticker(ticker)
    now = datetime.now()
    start = (now - timedelta(days=730)).strftime("%Y-%m-%d")
    end = now.strftime("%Y-%m-%d")
    # end exclusive in history(), but server does +1 day. Let's do same.
    end_dt = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")

    print(f"Testing {ticker} ({interval}) {start} to {end_dt}")
    df = t.history(start=start, end=end_dt, interval=interval, auto_adjust=True)
    print(f"Empty: {df.empty}, Rows: {len(df)}")
    if not df.empty:
         print(f"First row: {df.index[0]}")
         print(f"Last row: {df.index[-1]}")

test_yf("AAPL", "1d")
test_yf("AAPL", "1wk")
test_yf("005930.KS", "1wk")
