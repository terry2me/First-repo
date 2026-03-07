import sqlite3
import pandas as pd

conn = sqlite3.connect('stock.db')
query = """
SELECT ticker, date, close 
FROM stock_prices 
WHERE interval = '1wk' 
ORDER BY date ASC
"""
df = pd.read_sql_query(query, conn)
conn.close()

if not df.empty:
    pivot_df = df.pivot(index='date', columns='ticker', values='close')
    # 가격 자체가 아니라 수익률(상승/하락율)의 변화로 계산
    pct_df = pivot_df.pct_change().dropna(how='all')
    corr_matrix = pct_df.corr(method='pearson')
    print('Pivot shape:', pivot_df.shape)
    print('Pct Change shape:', pct_df.shape)
    print('\nCorrelation Matrix (first 3x3):')
    print(corr_matrix.iloc[:3, :3])
else:
    print('No data found for 1wk interval.')
