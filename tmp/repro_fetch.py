from datetime import datetime, timedelta
import yfinance as yf

def _yf_fetch_history(ticker_str: str, start: str, end: str, interval: str) -> list[dict]:
    try:
        t = yf.Ticker(ticker_str)
        # end는 exclusive이므로 하루 더 추가
        end_dt = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        print(f"Calling t.history(start={start}, end={end_dt}, interval={interval})")
        df = t.history(start=start, end=end_dt, interval=interval, auto_adjust=True)
        if df.empty:
            return []
        df.index = df.index.tz_localize(None) if df.index.tzinfo else df.index
        rows = []
        for idx, row in df.iterrows():
            rows.append({
                "date":   idx.strftime("%Y-%m-%d"),
                "close":  round(float(row["Close"]),  4),
            })
        return rows
    except Exception as e:
        print(f"Error: {e}")
        return []

# Simulate server.py behavior
ticker = "005380.KS"
start = "2026-02-24"
end = "2026-03-03" # get_today_str("KS")
rows = _yf_fetch_history(ticker, start, end, "1d")
print(f"Rows for {ticker}: {len(rows)}")
for r in rows:
    print(r)

ticker = "TSLA"
end = "2026-03-02" # get_today_str("US")
rows = _yf_fetch_history(ticker, start, end, "1d")
print(f"\nRows for {ticker}: {len(rows)}")
for r in rows:
    print(r)
