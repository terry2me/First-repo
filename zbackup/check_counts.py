import sqlite3
conn = sqlite3.connect("stock.db")
count = conn.execute("SELECT count(*) FROM stock_meta").fetchone()[0]
print(f"Total Tickers in stock_meta: {count}")

# Also check for S&P500 or other index synced tabs in _kv_store
kv_tabs = conn.execute("SELECT row_id, data FROM _kv_store WHERE table_name='bb_tabs'").fetchall()
for tid, data in kv_tabs:
    import json
    d = json.loads(data)
    name = d.get('name')
    stocks = d.get('stocks', [])
    if isinstance(stocks, str): stocks = json.loads(stocks)
    print(f"Tab '{name}' has {len(stocks)} stocks.")

conn.close()
