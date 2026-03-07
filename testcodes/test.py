import sqlite3
import pprint
conn = sqlite3.connect('stock.db')
c = conn.cursor()
c.execute("SELECT * FROM stock_correlations WHERE target_code = 'GOOG'")
pprint.pprint(c.fetchall())
conn.close()
