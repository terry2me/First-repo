import sqlite3
import pandas as pd
from pathlib import Path

# DB 경로
DB_PATH = Path(__file__).parent / "stock.db"

def calculate_correlations():
    try:
        conn = sqlite3.connect(DB_PATH)
        query = """
        SELECT ticker, date, close 
        FROM stock_prices 
        WHERE interval = '1d' 
        ORDER BY date ASC
        """
        df = pd.read_sql_query(query, conn)
        
        if df.empty:
            print("[Correlation] No data for 1d interval.")
            conn.close()
            return
            
        pivot_df = df.pivot(index='date', columns='ticker', values='close')
        pct_df = pivot_df.pct_change().dropna(how='all')
        corr_matrix = pct_df.corr(method='pearson')
        
        updates = []
        for ticker in corr_matrix.columns:
            # Drop self correlation
            series = corr_matrix[ticker].drop(ticker).dropna()
            if series.empty: continue
            
            # Pos (highest positive)
            pos_ticker = series.idxmax()
            pos_val = series.max()
            
            # Neg (lowest negative)
            neg_ticker = series.idxmin()
            neg_val = series.min()
            
            # Neu (closest to 0)
            neu_ticker = series.abs().idxmin()
            neu_val = series[neu_ticker]
            
            # Strip suffixes for DB
            target_code = ticker.replace('.KS', '').replace('.KQ', '')
            if target_code.isdigit(): target_code = target_code.zfill(6)
            
            pos_code = pos_ticker.replace('.KS', '').replace('.KQ', '')
            if pos_code.isdigit(): pos_code = pos_code.zfill(6)
            
            neg_code = neg_ticker.replace('.KS', '').replace('.KQ', '')
            if neg_code.isdigit(): neg_code = neg_code.zfill(6)
            
            neu_code = neu_ticker.replace('.KS', '').replace('.KQ', '')
            if neu_code.isdigit(): neu_code = neu_code.zfill(6)
            
            updates.append((
                target_code,
                pos_code, float(pos_val),
                neu_code, float(neu_val),
                neg_code, float(neg_val)
            ))
            
        # Update DB
        if updates:
            conn.execute("""
            CREATE TABLE IF NOT EXISTS stock_correlations (
                target_code TEXT PRIMARY KEY,
                pos_code    TEXT,
                pos_val     REAL,
                neu_code    TEXT,
                neu_val     REAL,
                neg_code    TEXT,
                neg_val     REAL,
                updated_at  TEXT
            )
            """)
            
            import datetime
            now = datetime.datetime.now().isoformat()
            
            upsert_query = """
            INSERT INTO stock_correlations 
                (target_code, pos_code, pos_val, neu_code, neu_val, neg_code, neg_val, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(target_code) DO UPDATE SET
                pos_code=excluded.pos_code, pos_val=excluded.pos_val,
                neu_code=excluded.neu_code, neu_val=excluded.neu_val,
                neg_code=excluded.neg_code, neg_val=excluded.neg_val,
                updated_at=excluded.updated_at
            """
            rows_with_date = [u + (now,) for u in updates]
            conn.executemany(upsert_query, rows_with_date)
            conn.commit()
            print(f"[Correlation] Updated {len(updates)} tickers successfully.")
            
        conn.close()
    except Exception as e:
        print(f"[Correlation] Error computing correlations: {e}")

if __name__ == "__main__":
    calculate_correlations()
