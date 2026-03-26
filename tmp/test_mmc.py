import yfinance as yf
try:
    data = yf.download("MMC", period="1y", interval="1d")
    print(f"Data for MMC:\n{data.tail()}")
    if data.empty:
        print("MMC data is empty")
except Exception as e:
    print(f"Error fetching MMC: {e}")
