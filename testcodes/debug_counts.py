import sqlite3
conn = sqlite3.connect("stock.db")
res = conn.execute("""
    SELECT interval, count(distinct ticker) 
    FROM stock_prices 
    GROUP BY interval
""").fetchall()
print("Interval counts:")
for row in res:
    print(f"Interval {row[0]}: {row[1]} tickers")

# Check how many would pass the >30 candles threshold
res2 = conn.execute("""
    SELECT interval, count(*) FROM (
        SELECT ticker, interval, count(*) as cnt 
        FROM stock_prices 
        GROUP BY ticker, interval
        HAVING cnt >= 30
    ) GROUP BY interval
""").fetchall()
print("\nTickers with >= 30 candles:")
total = 0
for row in res2:
    print(f"Interval {row[0]}: {row[1]} tickers")
    total += row[1]
print(f"Total passing threshold: {total}")

conn.close()
