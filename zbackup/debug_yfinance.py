import yfinance as yf
from datetime import datetime, timedelta

def check(ticker):
    print(f"Checking {ticker}...")
    t = yf.Ticker(ticker)
    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    df = t.history(start=start, end=end)
    print(f"History for {ticker}:")
    print(df)
    print(f"Info for {ticker}:")
    print(t.info)

check("005380.KS")
check("TSLA")
