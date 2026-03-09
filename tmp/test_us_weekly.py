
import yfinance as yf
from datetime import datetime, timedelta

def test_us_weekly():
    ticker_str = "AAPL"
    interval = "1wk"
    candle_count = 52
    
    # Simulate server.py logic
    start = (datetime.now() - timedelta(days=730)).strftime("%Y-%m-%d")
    end = datetime.now().strftime("%Y-%m-%d")
    
    print(f"Testing {ticker_str} with interval {interval} from {start} to {end}")
    
    try:
        t = yf.Ticker(ticker_str)
        end_dt = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        df = t.history(start=start, end=end_dt, interval=interval, auto_adjust=True)
        
        print(f"Dataframe size: {len(df)}")
        if not df.empty:
            print("First 5 rows:")
            print(df.head())
            print("Last 5 rows:")
            print(df.tail())
        else:
            print("DATAFRAME IS EMPTY!")
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_us_weekly()
