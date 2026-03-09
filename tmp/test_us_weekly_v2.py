
import yfinance as yf
from datetime import datetime, timedelta

def test_ticker_weekly(ticker_str):
    interval = "1wk"
    
    # Simulate server.py logic
    start = (datetime.now() - timedelta(days=730)).strftime("%Y-%m-%d")
    end = datetime.now().strftime("%Y-%m-%d")
    
    print(f"Testing {ticker_str} with interval {interval} from {start} to {end}")
    
    try:
        t = yf.Ticker(ticker_str)
        end_dt = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        df = t.history(start=start, end=end_dt, interval=interval, auto_adjust=True)
        
        print(f"[{ticker_str}] Dataframe size: {len(df)}")
        if not df.empty:
            print(f"Last date: {df.index[-1]}")
        else:
            print(f"[{ticker_str}] DATAFRAME IS EMPTY!")
            
    except Exception as e:
        print(f"Error for {ticker_str}: {e}")

if __name__ == "__main__":
    test_ticker_weekly("BRK-B")
    test_ticker_weekly("AAPL")
    test_ticker_weekly("TSLA")
    test_ticker_weekly("NVDA")
