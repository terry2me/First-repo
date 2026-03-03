import sqlite3

def check_db():
    conn = sqlite3.connect("stock.db")
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    print("Checking stock_meta:")
    rows = c.execute("SELECT * FROM stock_meta WHERE ticker LIKE '%005380%' OR ticker LIKE '%TSLA%'").fetchall()
    for r in rows:
        print(dict(r))
        
    print("\nChecking stock_prices (last 5 for each):")
    rows = c.execute("""
        SELECT * FROM stock_prices 
        WHERE ticker LIKE '%005380%' OR ticker LIKE '%TSLA%'
        ORDER BY ticker, date DESC
    """).fetchall()
    
    current_ticker = None
    count = 0
    for r in rows:
        if r['ticker'] != current_ticker:
            current_ticker = r['ticker']
            count = 0
            print(f"\nTicker: {current_ticker}")
        if count < 5:
            print(dict(r))
            count += 1
            
    conn.close()

check_db()
