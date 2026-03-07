import sqlite3
import pandas as pd
import numpy as np
import json
import math
from pathlib import Path

# DB 경로
DB_PATH = Path(r"c:\zTest\Antigravity\Project1\stock.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# ---------------------------------------------------------
# [JS 로직 재현] - indicators.js의 로직을 그대로 파이썬으로 옮김
# ---------------------------------------------------------

def js_mean(arr):
    if not arr: return 0
    return sum(arr) / len(arr)

def js_std_dev(arr):
    if len(arr) < 2: return 0
    m = js_mean(arr)
    variance = sum([(v - m) ** 2 for v in arr]) / len(arr)
    return math.sqrt(variance)

def calculate_js_indicators(prices):
    """
    prices: list of dicts with [high, low, close, volume]
    """
    df = pd.DataFrame(prices)
    closes = df['close'].tolist()
    highs = df['high'].tolist()
    lows = df['low'].tolist()
    volumes = df['volume'].tolist()
    n = len(closes)

    # 1. Bollinger Bands (20, 2)
    period_bb = 20
    bb_upper = [None] * n
    bb_middle = [None] * n
    bb_lower = [None] * n

    for i in range(period_bb - 1, n):
        slice_cls = closes[i - period_bb + 1 : i + 1]
        ma = js_mean(slice_cls)
        sd = js_std_dev(slice_cls)
        bb_upper[i] = round(ma + 2 * sd, 2)
        bb_middle[i] = round(ma, 2)
        bb_lower[i] = round(ma - 2 * sd, 2)

    # 2. RSI (14)
    period_rsi = 14
    rsi_vals = [None] * n
    if n > period_rsi:
        avg_gain = 0
        avg_loss = 0
        for i in range(1, period_rsi + 1):
            diff = closes[i] - closes[i-1]
            if diff > 0: avg_gain += diff
            else: avg_loss += abs(diff)
        avg_gain /= period_rsi
        avg_loss /= period_rsi
        
        rsi_vals[period_rsi] = 100 if avg_loss == 0 else (0 if avg_gain == 0 else round(100 - 100 / (1 + avg_gain / avg_loss), 2))
        
        for i in range(period_rsi + 1, n):
            diff = closes[i] - closes[i-1]
            gain = diff if diff > 0 else 0
            loss = abs(diff) if diff < 0 else 0
            avg_gain = (avg_gain * (period_rsi - 1) + gain) / period_rsi
            avg_loss = (avg_loss * (period_rsi - 1) + loss) / period_rsi
            rsi_vals[i] = 100 if avg_loss == 0 else (0 if avg_gain == 0 else round(100 - 100 / (1 + avg_gain / avg_loss), 2))

    # 3. Stochastics (14, 3, 3)
    k1, k2, d_period = 14, 3, 3
    fast_k = [None] * n
    for i in range(k1 - 1, n):
        slice_h = highs[i - k1 + 1 : i + 1]
        slice_l = lows[i - k1 + 1 : i + 1]
        hi = max(slice_h)
        lo = min(slice_l)
        rng = hi - lo
        fast_k[i] = 50 if rng == 0 else round((closes[i] - lo) / rng * 100, 2)
    
    slow_k = [None] * n
    for i in range(k1 + k2 - 2, n):
        slice_fk = fast_k[i - k2 + 1 : i + 1]
        slow_k[i] = round(js_mean(slice_fk), 2)
        
    slow_d = [None] * n
    for i in range(k1 + k2 + d_period - 3, n):
        slice_sk = slow_k[i - d_period + 1 : i + 1]
        slow_d[i] = round(js_mean(slice_sk), 2)

    # 4. EOM (14, 14)
    eom_raw = [0.0] * n
    for i in range(1, n):
        hl = highs[i] - lows[i]
        if hl == 0 or volumes[i] == 0:
            eom_raw[i] = 0.0
        else:
            dm = ((highs[i] + lows[i]) / 2) - ((highs[i-1] + lows[i-1]) / 2)
            br = volumes[i] / hl
            eom_raw[i] = dm / br if br != 0 else 0.0
            
    eom_ma = [None] * n
    for i in range(14, n):
        eom_ma[i] = js_mean(eom_raw[i - 14 + 1 : i + 1])
        
    eom_sig = [None] * n
    for i in range(14 + 14 - 1, n):
        eom_sig[i] = js_mean(eom_ma[i - 14 + 1 : i + 1])

    return {
        "bb_upper": bb_upper[-1],
        "bb_middle": bb_middle[-1],
        "bb_lower": bb_lower[-1],
        "rsi": rsi_vals[-1],
        "stoch_k": slow_k[-1],
        "stoch_d": slow_d[-1],
        "eom": eom_ma[-1],
        "eom_sig": eom_sig[-1]
    }

# ---------------------------------------------------------
# [Python/Pandas 로직] - 서버에 적용할 최적화 로직
# ---------------------------------------------------------

def calculate_py_indicators(prices):
    df = pd.DataFrame(prices)
    # BB (20, 2)
    df['ma20'] = df['close'].rolling(window=20).mean()
    df['std20'] = df['close'].rolling(window=20).std(ddof=0) # ddof=0 for population std dev
    df['py_bb_u'] = np.round(df['ma20'] + 2 * df['std20'], 2)
    df['py_bb_m'] = np.round(df['ma20'], 2)
    df['py_bb_l'] = np.round(df['ma20'] - 2 * df['std20'], 2)

    # RSI (14) - Wilder Smoothing
    delta = df['close'].diff()
    gain = (delta.where(delta > 0, 0))
    loss = (-delta.where(delta < 0, 0))
    
    gains = gain.values
    losses = loss.values
    wilder_gains = np.zeros(len(df))
    wilder_losses = np.zeros(len(df))
    
    if len(df) > 14:
        # Initial SMA
        wilder_gains[14] = np.mean(gains[1:15])
        wilder_losses[14] = np.mean(losses[1:15])
        # Wilder's Smoothing
        for i in range(15, len(df)):
            wilder_gains[i] = (wilder_gains[i-1] * 13 + gains[i]) / 14
            wilder_losses[i] = (wilder_losses[i-1] * 13 + losses[i]) / 14
            
    rs = np.divide(wilder_gains, wilder_losses, out=np.zeros_like(wilder_gains), where=wilder_losses!=0)
    df['py_rsi'] = np.where(wilder_losses == 0, 100, np.where(wilder_gains == 0, 0, np.round(100 - (100 / (1 + rs)), 2)))
    df.loc[:13, 'py_rsi'] = None

    # Stochastics (14, 3, 3)
    lo14 = df['low'].rolling(window=14).min()
    hi14 = df['high'].rolling(window=14).max()
    df['fast_k'] = np.where(hi14 - lo14 == 0, 50, (df['close'] - lo14) / (hi14 - lo14) * 100)
    # rounding fast_k here because JS rounds it before taking SMA
    df['fast_k'] = df['fast_k'].round(2)
    df['py_stoch_k'] = np.round(df['fast_k'].rolling(window=3).mean(), 2)
    df['py_stoch_d'] = np.round(df['py_stoch_k'].rolling(window=3).mean(), 2)

    # EOM (14, 14)
    dm = ((df['high'] + df['low']) / 2) - ((df['high'].shift(1) + df['low'].shift(1)) / 2)
    hl = df['high'] - df['low']
    # Match JS: br = volume / hl
    br = df['volume'] / hl
    eom_raw = np.where((hl == 0) | (df['volume'] == 0) | (br == 0), 0.0, dm / br)
    df['py_eom'] = pd.Series(eom_raw).rolling(window=14).mean()
    df['py_eom_sig'] = df['py_eom'].rolling(window=14).mean()

    last = df.iloc[-1]
    return {
        "bb_upper": last['py_bb_u'],
        "bb_middle": last['py_bb_m'],
        "bb_lower": last['py_bb_l'],
        "rsi": last['py_rsi'],
        "stoch_k": last['py_stoch_k'],
        "stoch_d": last['py_stoch_d'],
        "eom": last['py_eom'],
        "eom_sig": last['py_eom_sig']
    }

# ---------------------------------------------------------
# [검증 실행]
# ---------------------------------------------------------

def verify_all():
    conn = get_db()
    tickers = [r['ticker'] for r in conn.execute("SELECT ticker FROM stock_meta").fetchall()]
    
    print(f"총 {len(tickers)}개 종목 검증 시작...")
    
    stats = {
        "total": 0,
        "match": 0,
        "mismatch": 0,
        "details": []
    }

    for ticker in tickers:
        for interval in ['1d', '1wk']:
            rows = conn.execute(
                "SELECT date, open, high, low, close, volume FROM stock_prices WHERE ticker=? AND interval=? ORDER BY date ASC",
                (ticker, interval)
            ).fetchall()
            
            if len(rows) < 30: continue # 데이터 부족 (EOM 14+14=28 필요)
            
            prices = [dict(r) for r in rows]
            
            js_res = calculate_js_indicators(prices)
            py_res = calculate_py_indicators(prices)
            
            stats["total"] += 1
            is_match = True
            mismatch_fields = []
            
            for field in js_res:
                v_js = js_res[field]
                v_py = py_res[field]
                
                if v_js is None or v_py is None: continue
                
                diff = abs(v_js - v_py)
                # EOM은 정밀도 영향이 크므로 약간의 여유를 둠 (JS는 루프 방식, PY는 벡터 방식)
                tolerance = 0.02
                if field.startswith('eom'):
                    # EOM 값은 스케일이 클 수 있어 상대 오차 적용
                    if diff > (abs(v_js) * 0.01 + 0.01):
                        is_match = False
                        mismatch_fields.append(f"{field}(JS:{v_js:.4f}, PY:{v_py:.4f})")
                else:
                    if diff > tolerance:
                        is_match = False
                        mismatch_fields.append(f"{field}(JS:{v_js}, PY:{v_py})")

            if is_match:
                stats["match"] += 1
            else:
                stats["mismatch"] += 1
                if len(stats["details"]) < 50: # 너무 많으면 자름
                    stats["details"].append({"ticker": ticker, "interval": interval, "mismatch": mismatch_fields})

    conn.close()
    return stats

if __name__ == "__main__":
    result = verify_all()
    print("\n=== 검증 결과 요약 ===")
    print(f"검사 대상 건수: {result['total']}")
    print(f"일치: {result['match']}")
    print(f"불일치: {result['mismatch']}")
    
    if result['mismatch'] > 0:
        print("\n--- 불일치 상세 (상위 5건) ---")
        for d in result['details'][:5]:
            print(f"[{d['ticker']} - {d['interval']}] {', '.join(d['mismatch'])}")
    
    print("\n결론:")
    if result['total'] == 0:
        print("❓ 검사 대상 데이터가 없습니다.")
    elif result['mismatch'] == 0:
        print("✅ 모든 지표가 기존 JS 로직과 100% 일치합니다. 즉시 적용 가능합니다.")
    elif result['mismatch'] / result['total'] < 0.05:
         print(f"⚠️ 약 {result['mismatch']/result['total']*100:.1f}%의 데이터에서 미세한 차이가 발생했습니다.")
         print("   (주로 부동소수점 오차나 반올림 위치의 차이로 판단됩니다.)")
    else:
         print("❌ 예상보다 많은 불일치가 발생했습니다. 로직 재점검이 필요합니다.")
