import yfinance as yf

def check(ticker):
    print(f"Checking {ticker}...")
    t = yf.Ticker(ticker)
    df = t.history(period="1mo")
    print(f"History for {ticker}:")
    print(df.tail())

check("005380.KS")
check("TSLA")
