"""
server.py — FastAPI 백엔드 (yfinance + SQLite)

구조:
  - SQLite DB: stock_prices / stock_meta / stock_fundamentals
  - 조회 로직:
      DB에 오늘 날짜 있음 → DB만 읽어서 반환
      DB에 오늘 날짜 없음 → yfinance로 마지막날짜 포함~오늘 조회 → DB 저장 → DB 읽어서 반환
  - 새로고침: 등록 종목 전체 순차 배치 (0.5초 딜레이)
  - 정적 파일: index.html / css / js 서빙 (포트 8000)
"""

import sqlite3
import time
import threading
import traceback
import uuid
import json
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Optional, Any
from zoneinfo import ZoneInfo

import yfinance as yf
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

# ── 경로 설정 ──────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
DB_PATH  = BASE_DIR / "stock.db"

# ── FastAPI 앱 ─────────────────────────────────────────────
app = FastAPI(title="BB Monitor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── 타임존 ─────────────────────────────────────────────────
TZ_KST = ZoneInfo("Asia/Seoul")
TZ_EST = ZoneInfo("America/New_York")

# ── 새로고침 진행 상태 (전역) ──────────────────────────────
refresh_status = {
    "running": False,
    "total": 0,
    "done": 0,
    "errors": [],
    "last_finished": None,
}
refresh_lock = threading.Lock()


# ══════════════════════════════════════════════════════════
#  DB 초기화
# ══════════════════════════════════════════════════════════
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = get_db()
    c = conn.cursor()

    # 가격 테이블 (일봉/주봉 분리)
    c.execute("""
        CREATE TABLE IF NOT EXISTS stock_prices (
            ticker   TEXT NOT NULL,
            date     TEXT NOT NULL,
            open     REAL,
            high     REAL,
            low      REAL,
            close    REAL NOT NULL,
            volume   REAL,
            interval TEXT NOT NULL DEFAULT '1d',
            PRIMARY KEY (ticker, date, interval)
        )
    """)
    # 기존 DB에 컬럼이 없으면 추가 (마이그레이션)
    for col in ['open', 'high', 'low', 'volume']:
        try:
            c.execute(f'ALTER TABLE stock_prices ADD COLUMN {col} REAL')
        except Exception:
            pass

    # 종목 메타 (이름/시장/visible)
    c.execute("""
        CREATE TABLE IF NOT EXISTS stock_meta (
            ticker     TEXT PRIMARY KEY,
            name       TEXT,
            currency   TEXT,
            market     TEXT,
            visible    INTEGER DEFAULT 0,
            updated_at TEXT
        )
    """)

    # 펀더멘털
    c.execute("""
        CREATE TABLE IF NOT EXISTS stock_fundamentals (
            ticker         TEXT PRIMARY KEY,
            trailing_pe    REAL,
            forward_pe     REAL,
            pbr            REAL,
            ev_to_ebitda   REAL,
            dividend_yield REAL,
            eps            REAL,
            beta           REAL,
            sector         TEXT,
            fetched_at     TEXT
        )
    """)
    # 기존 DB 마이그레이션 — OHLCV 컬럼
    for col in ['open', 'high', 'low', 'volume']:
        try:
            c.execute(f'ALTER TABLE stock_prices ADD COLUMN {col} REAL')
        except Exception:
            pass
    # 기존 DB 마이그레이션 — sector 컬럼
    try:
        c.execute('ALTER TABLE stock_fundamentals ADD COLUMN sector TEXT')
    except Exception:
        pass

    # ── Genspark Table API 호환: 동적 KV 저장소 ──────────────
    # storage.js 가 tables/{table_name} 으로 호출하는 경로를 처리
    # 각 테이블은 _kv_store 에 JSON blob 으로 저장
    c.execute("""
        CREATE TABLE IF NOT EXISTS _kv_store (
            table_name TEXT NOT NULL,
            row_id     TEXT NOT NULL,
            data       TEXT NOT NULL,
            PRIMARY KEY (table_name, row_id)
        )
    """)

    conn.commit()
    conn.close()
    print("[DB] 초기화 완료:", DB_PATH)


# ══════════════════════════════════════════════════════════
#  Genspark Table API 호환 라우터
#  storage.js 가 사용하는 REST 인터페이스를 그대로 구현:
#    GET    /tables/{name}?limit=500   → { data: [...] }
#    POST   /tables/{name}             → { id, ...fields }
#    PATCH  /tables/{name}/{id}        → { id, ...fields }
#    DELETE /tables/{name}/{id}        → 204
# ══════════════════════════════════════════════════════════

def _kv_get_all(table_name: str, limit: int = 500) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT row_id, data FROM _kv_store WHERE table_name=? ORDER BY rowid LIMIT ?",
        (table_name, limit)
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        try:
            obj = json.loads(r["data"])
            obj["id"] = r["row_id"]
            result.append(obj)
        except Exception:
            pass
    return result


def _kv_get_one(table_name: str, row_id: str) -> Optional[dict]:
    conn = get_db()
    row = conn.execute(
        "SELECT data FROM _kv_store WHERE table_name=? AND row_id=?",
        (table_name, row_id)
    ).fetchone()
    conn.close()
    if not row:
        return None
    obj = json.loads(row["data"])
    obj["id"] = row_id
    return obj


def _kv_insert(table_name: str, data: dict) -> dict:
    row_id = data.pop("id", None) or str(uuid.uuid4())
    data["id"] = row_id
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO _kv_store (table_name, row_id, data) VALUES (?,?,?)",
        (table_name, row_id, json.dumps(data, ensure_ascii=False))
    )
    conn.commit()
    conn.close()
    return data


def _kv_patch(table_name: str, row_id: str, patch: dict) -> Optional[dict]:
    existing = _kv_get_one(table_name, row_id)
    if existing is None:
        return None
    existing.update(patch)
    existing["id"] = row_id
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO _kv_store (table_name, row_id, data) VALUES (?,?,?)",
        (table_name, row_id, json.dumps(existing, ensure_ascii=False))
    )
    conn.commit()
    conn.close()
    return existing


def _kv_delete(table_name: str, row_id: str) -> bool:
    conn = get_db()
    cur = conn.execute(
        "DELETE FROM _kv_store WHERE table_name=? AND row_id=?",
        (table_name, row_id)
    )
    conn.commit()
    conn.close()
    return cur.rowcount > 0


@app.get("/tables/{table_name}")
async def table_get(table_name: str, limit: int = 500):
    rows = _kv_get_all(table_name, limit)
    return {"data": rows, "total": len(rows)}


@app.post("/tables/{table_name}")
async def table_post(table_name: str, request: Request):
    body = await request.json()
    row  = _kv_insert(table_name, dict(body))
    return row


@app.patch("/tables/{table_name}/{row_id}")
async def table_patch(table_name: str, row_id: str, request: Request):
    body = await request.json()
    row  = _kv_patch(table_name, row_id, dict(body))
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    return row


@app.delete("/tables/{table_name}/{row_id}")
async def table_delete(table_name: str, row_id: str):
    ok = _kv_delete(table_name, row_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Not found")
    return JSONResponse(status_code=200, content={"ok": True})


# ══════════════════════════════════════════════════════════
#  장 마감 여부 판단
# ══════════════════════════════════════════════════════════
def is_market_closed(market: str) -> bool:
    """
    KS: KST 15:30 이후 → 마감
    US: EST 16:00 이후 → 마감
    주말은 항상 마감으로 처리
    """
    if market == "US":
        now = datetime.now(TZ_EST)
        if now.weekday() >= 5:  # 토/일
            return True
        return now.hour > 16 or (now.hour == 16 and now.minute >= 0)
    else:  # KS
        now = datetime.now(TZ_KST)
        if now.weekday() >= 5:
            return True
        return now.hour > 15 or (now.hour == 15 and now.minute >= 30)


def get_last_trading_date(market: str) -> str:
    """
    yfinance 가 확정 캔들을 제공하는 '마지막 거래일' 반환 (YYYY-MM-DD).

    미국(US):
      - 장 마감(EST 16:00) 이후 → 오늘(EST 기준)
      - 장 마감 전(pre-market 포함) → 전 영업일
    한국(KS):
      - 장 마감(KST 15:30) 이후 → 오늘(KST 기준)
      - 장 마감 전 → 전 영업일
    주말은 직전 금요일을 반환.
    """
    if market == "US":
        now = datetime.now(TZ_EST)
        market_closed_today = (
            now.weekday() < 5 and
            (now.hour > 16 or (now.hour == 16 and now.minute >= 0))
        )
    else:
        now = datetime.now(TZ_KST)
        market_closed_today = (
            now.weekday() < 5 and
            (now.hour > 15 or (now.hour == 15 and now.minute >= 30))
        )

    if now.weekday() < 5 and market_closed_today:
        # 오늘 장 마감 → 오늘이 마지막 거래일
        return now.strftime("%Y-%m-%d")

    # 장 마감 전이거나 주말 → 직전 평일(월~금)로 되돌림
    candidate = now - timedelta(days=1)
    while candidate.weekday() >= 5:  # 토(5), 일(6) 건너뜀
        candidate -= timedelta(days=1)
    return candidate.strftime("%Y-%m-%d")


def get_today_str(market: str) -> str:
    """
    시장 기준 '오늘' 날짜 문자열 반환 (YYYY-MM-DD).
    장 마감 여부와 무관하게 현재 날짜만 반환 (fetch 범위 end 용도).
    캐시 히트 판단에는 get_last_trading_date() 를 사용할 것.
    """
    if market == "US":
        return datetime.now(TZ_EST).strftime("%Y-%m-%d")
    return datetime.now(TZ_KST).strftime("%Y-%m-%d")


# ══════════════════════════════════════════════════════════
#  ticker 유틸
# ══════════════════════════════════════════════════════════
def resolve_ticker(code: str, market: str) -> str:
    """코드 + 시장 → yfinance ticker 문자열"""
    if market == "US":
        return code.upper()
    code_clean = code.replace(".KS", "").replace(".KQ", "")
    return f"{code_clean.zfill(6)}.KS"


def resolve_market(code: str) -> str:
    """코드만으로 시장 추정"""
    c = code.upper().replace(".KS", "").replace(".KQ", "")
    if c.isdigit():
        return "KS"
    return "US"


# ══════════════════════════════════════════════════════════
#  yfinance 조회 헬퍼
# ══════════════════════════════════════════════════════════
def _yf_fetch_history(ticker_str: str, start: str, end: str, interval: str) -> list[dict]:
    """
    yfinance history 조회 → [{date, open, high, low, close, volume}, ...] 반환
    start/end: 'YYYY-MM-DD'
    """
    try:
        t = yf.Ticker(ticker_str)
        # end는 exclusive이므로 하루 더 추가
        end_dt = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        df = t.history(start=start, end=end_dt, interval=interval, auto_adjust=True)
        if df.empty:
            return []
        df.index = df.index.tz_localize(None) if df.index.tzinfo else df.index
        rows = []
        for idx, row in df.iterrows():
            rows.append({
                "date":   idx.strftime("%Y-%m-%d"),
                "open":   round(float(row["Open"]),   4),
                "high":   round(float(row["High"]),   4),
                "low":    round(float(row["Low"]),    4),
                "close":  round(float(row["Close"]),  4),
                "volume": float(row.get("Volume", 0) or 0),
            })
        return rows
    except Exception as e:
        print(f"[yfinance] {ticker_str} history 오류: {e}")
        return []


def _yf_fetch_meta(ticker_str: str) -> dict:
    """종목 메타 + 펀더멘털 조회"""
    try:
        t = yf.Ticker(ticker_str)
        info = t.info or {}
        return {
            "name":           info.get("longName") or info.get("shortName") or ticker_str,
            "currency":       info.get("currency", ""),
            "sector":         info.get("sector"),
            "trailing_pe":    info.get("trailingPE"),
            "forward_pe":     info.get("forwardPE"),
            "pbr":            info.get("priceToBook"),
            "ev_to_ebitda":   info.get("enterpriseToEbitda"),
            "dividend_yield": info.get("dividendYield"),
            "eps":            info.get("trailingEps"),
            "beta":           info.get("beta"),
        }
    except Exception as e:
        print(f"[yfinance] {ticker_str} meta 오류: {e}")
        return {}


# ══════════════════════════════════════════════════════════
#  DB 읽기/쓰기 헬퍼
# ══════════════════════════════════════════════════════════
def db_get_last_date(ticker: str, interval: str) -> Optional[str]:
    """DB에서 해당 ticker의 마지막 날짜 반환"""
    conn = get_db()
    row = conn.execute(
        "SELECT MAX(date) as d FROM stock_prices WHERE ticker=? AND interval=?",
        (ticker, interval)
    ).fetchone()
    conn.close()
    return row["d"] if row and row["d"] else None


def db_has_today(ticker: str, interval: str, market: str) -> bool:
    """마지막 거래일 데이터가 DB에 있는지 확인 (시장별 기준 적용)"""
    last_trading = get_last_trading_date(market)
    conn  = get_db()
    row   = conn.execute(
        "SELECT 1 FROM stock_prices WHERE ticker=? AND date=? AND interval=?",
        (ticker, last_trading, interval)
    ).fetchone()
    conn.close()
    return row is not None


def db_upsert_prices(ticker: str, rows: list[dict], interval: str):
    """가격 데이터 upsert (마지막 날짜 포함 덮어쓰기) — OHLCV 전체 저장"""
    if not rows:
        return
    conn = get_db()
    conn.executemany(
        """
        INSERT OR REPLACE INTO stock_prices
            (ticker, date, open, high, low, close, volume, interval)
        VALUES (?,?,?,?,?,?,?,?)
        """,
        [(ticker,
          r["date"],
          r.get("open"),
          r.get("high"),
          r.get("low"),
          r["close"],
          r.get("volume", 0),
          interval) for r in rows]
    )
    conn.commit()
    conn.close()


def db_get_prices(ticker: str, interval: str, limit: int = 600) -> list[dict]:
    """DB에서 가격 조회 (최신순 → limit개 → 날짜순 정렬) — OHLCV 전체 반환"""
    conn = get_db()
    rows = conn.execute(
        """
        SELECT date, open, high, low, close, volume FROM (
            SELECT date, open, high, low, close, volume
            FROM stock_prices
            WHERE ticker=? AND interval=?
            ORDER BY date DESC LIMIT ?
        ) ORDER BY date ASC
        """,
        (ticker, interval, limit)
    ).fetchall()
    conn.close()
    return [
        {
            "date":   r["date"],
            "open":   r["open"],
            "high":   r["high"],
            "low":    r["low"],
            "close":  r["close"],
            "volume": r["volume"],
        }
        for r in rows
    ]


def db_upsert_meta(ticker: str, name: str, currency: str, market: str):
    """메타 upsert (visible은 변경하지 않음)"""
    conn = get_db()
    now  = datetime.now().isoformat()
    conn.execute(
        """
        INSERT INTO stock_meta (ticker, name, currency, market, visible, updated_at)
        VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT(ticker) DO UPDATE SET
            name=excluded.name,
            currency=excluded.currency,
            market=excluded.market,
            updated_at=excluded.updated_at
        """,
        (ticker, name, currency, market, now)
    )
    conn.commit()
    conn.close()


def db_get_meta(ticker: str) -> Optional[dict]:
    conn = get_db()
    row  = conn.execute("SELECT * FROM stock_meta WHERE ticker=?", (ticker,)).fetchone()
    conn.close()
    return dict(row) if row else None


def db_upsert_fundamentals(ticker: str, data: dict):
    """펀더멘털 upsert (sector 포함)"""
    conn = get_db()
    now  = datetime.now().isoformat()
    conn.execute(
        """
        INSERT INTO stock_fundamentals
            (ticker, trailing_pe, forward_pe, pbr, ev_to_ebitda, dividend_yield, eps, beta, sector, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(ticker) DO UPDATE SET
            trailing_pe=excluded.trailing_pe,
            forward_pe=excluded.forward_pe,
            pbr=excluded.pbr,
            ev_to_ebitda=excluded.ev_to_ebitda,
            dividend_yield=excluded.dividend_yield,
            eps=excluded.eps,
            beta=excluded.beta,
            sector=excluded.sector,
            fetched_at=excluded.fetched_at
        """,
        (ticker,
         data.get("trailing_pe"), data.get("forward_pe"),
         data.get("pbr"), data.get("ev_to_ebitda"),
         data.get("dividend_yield"), data.get("eps"), data.get("beta"),
         data.get("sector"),
         now)
    )
    conn.commit()
    conn.close()


def db_get_fundamentals(ticker: str) -> Optional[dict]:
    conn = get_db()
    row  = conn.execute("SELECT * FROM stock_fundamentals WHERE ticker=?", (ticker,)).fetchone()
    conn.close()
    return dict(row) if row else None


# ══════════════════════════════════════════════════════════
#  핵심 조회 로직
# ══════════════════════════════════════════════════════════
def ensure_prices(ticker: str, market: str, interval: str) -> bool:
    """
    DB에 오늘 날짜 있으면 → 그대로
    없으면 → yfinance로 마지막날짜 포함~오늘 조회 → DB 저장
    반환: 성공 여부
    """
    # 오늘 데이터 이미 있으면 패스
    if db_has_today(ticker, interval, market):
        print(f"[cache] {ticker} ({interval}) 오늘 데이터 있음 → DB 사용")
        return True

    # 마지막 저장 날짜 확인
    last_date = db_get_last_date(ticker, interval)

    if last_date:
        # 마지막 날짜 포함해서 오늘까지 조회 (덮어쓰기)
        start = last_date
        print(f"[yfinance] {ticker} ({interval}) {start} ~ 오늘 업데이트")
    else:
        # 최초 조회: 2년치
        start = (datetime.now() - timedelta(days=730)).strftime("%Y-%m-%d")
        print(f"[yfinance] {ticker} ({interval}) 최초 조회 (2년치)")

    today = get_today_str(market)
    rows  = _yf_fetch_history(ticker, start, today, interval)

    if not rows:
        print(f"[yfinance] {ticker} ({interval}) 데이터 없음")
        return False

    db_upsert_prices(ticker, rows, interval)
    print(f"[DB] {ticker} ({interval}) {len(rows)}건 저장")
    return True


def ensure_meta_and_fundamentals(ticker: str, market: str, force: bool = False):
    """
    메타/펀더멘털이 없거나 force=True이면 yfinance에서 조회해서 저장
    펀더멘털은 하루 1회만 갱신
    """
    meta = db_get_meta(ticker)
    fund = db_get_fundamentals(ticker)

    # 펀더멘털 갱신 필요 여부 판단 (마지막 거래일 1회, 단 sector가 없으면 강제 갱신)
    need_fund = force or fund is None
    if fund and fund.get("fetched_at"):
        try:
            fetched = datetime.fromisoformat(fund["fetched_at"])
            last_trading = get_last_trading_date(market)
            fetched_date = fetched.strftime("%Y-%m-%d")
            if fetched_date >= last_trading:
                # sector가 null이면 강제 갱신 (마이그레이션)
                if fund.get("sector") is None and market == "US":
                    need_fund = True
                else:
                    need_fund = False
            else:
                need_fund = True
        except Exception:
            need_fund = True

    if meta is None or need_fund:
        yf_data = _yf_fetch_meta(ticker)
        if yf_data:
            name     = yf_data.get("name", ticker)
            currency = yf_data.get("currency", "")
            db_upsert_meta(ticker, name, currency, market)
            db_upsert_fundamentals(ticker, yf_data)


def build_response(ticker: str, market: str, interval: str, candle_count: int) -> dict:
    """
    DB에서 데이터를 읽어 JS api.js가 기대하는 형식으로 변환
    """
    prices = db_get_prices(ticker, interval, limit=candle_count + 60)
    meta   = db_get_meta(ticker)
    fund   = db_get_fundamentals(ticker)

    if not prices:
        raise HTTPException(status_code=404, detail=f"{ticker} 데이터 없음")

    # 마지막 캔들 = 현재가
    all_closes  = [p["close"] for p in prices]
    cur         = all_closes[-1]
    is_us       = (market == "US")

    # 전일 종가
    prev_close  = all_closes[-2] if len(all_closes) >= 2 else cur

    # 금일 등락
    today_chg     = round(cur - prev_close, 4 if is_us else 0)
    today_chg_pct = round((today_chg / prev_close * 100) if prev_close else 0, 2)

    # 기간 등락 (candle_count 기준)
    period_prices  = prices[-candle_count:] if len(prices) > candle_count else prices
    period_closes  = [p["close"] for p in period_prices]
    period_base    = period_closes[0] if period_closes else cur
    period_chg     = round(cur - period_base, 4 if is_us else 0)
    period_chg_pct = round((period_chg / period_base * 100) if period_base else 0, 2)

    # 캔들 형식 변환 (JS indicators.js / charts.js 호환: OHLCV 전체)
    candles = [
        {
            "date":   p["date"],
            "open":   p["open"]   if p["open"]  is not None else p["close"],
            "high":   p["high"]   if p["high"]  is not None else p["close"],
            "low":    p["low"]    if p["low"]   is not None else p["close"],
            "close":  p["close"],
            "volume": p["volume"] if p["volume"] is not None else 0,
        }
        for p in period_prices
    ]

    # 종목명
    name = (meta or {}).get("name", ticker)

    # 코드 정제
    code = ticker.replace(".KS", "").replace(".KQ", "")
    if not is_us:
        code = code.zfill(6)

    return {
        "code":           code,
        "market":         market,
        "ticker":         ticker,
        "name":           name,
        "currency":       (meta or {}).get("currency", "USD" if is_us else "KRW"),
        "isUS":           is_us,
        "interval":       interval,
        "candleCount":    candle_count,
        "currentPrice":   cur,
        "prevClose":      prev_close,
        "todayChange":    today_chg,
        "todayChangePct": today_chg_pct,
        "change":         period_chg,
        "changePct":      period_chg_pct,
        "candles":        candles,
        "allCandles":     [
            {
                "date":   p["date"],
                "open":   p["open"]   if p["open"]  is not None else p["close"],
                "high":   p["high"]   if p["high"]  is not None else p["close"],
                "low":    p["low"]    if p["low"]   is not None else p["close"],
                "close":  p["close"],
                "volume": p["volume"] if p["volume"] is not None else 0,
            }
            for p in prices
        ],
        "closes":         all_closes,
        # 펀더멘털
        "trailingPE":     (fund or {}).get("trailing_pe"),
        "forwardPE":      (fund or {}).get("forward_pe"),
        "pbr":            (fund or {}).get("pbr"),
        "evToEbitda":     (fund or {}).get("ev_to_ebitda"),
        "dividendYield":  (fund or {}).get("dividend_yield"),
        "eps":            (fund or {}).get("eps"),
        "beta":           (fund or {}).get("beta"),
        "sector":         (fund or {}).get("sector"),
    }


# ══════════════════════════════════════════════════════════
#  API 엔드포인트
# ══════════════════════════════════════════════════════════

# ── 요청 모델 ──────────────────────────────────────────────
class StockRequest(BaseModel):
    code:         str
    market:       Optional[str] = None
    interval:     str = "1d"
    candle_count: int = 52

class RefreshRequest(BaseModel):
    stocks:       list[dict]   # [{ code, market }]
    interval:     str = "1d"
    candle_count: int = 52


# ── 단일 종목 조회 ─────────────────────────────────────────
@app.post("/api/stock")
async def get_stock(req: StockRequest):
    """
    종목 조회:
    1. DB 오늘 데이터 있으면 → DB 반환
    2. 없으면 → yfinance 조회 → DB 저장 → DB 반환
    """
    market = req.market or resolve_market(req.code)
    ticker = resolve_ticker(req.code, market)

    # 가격 확보 (DB 우선, 없으면 yfinance)
    ok = ensure_prices(ticker, market, req.interval)
    if not ok:
        raise HTTPException(status_code=404, detail=f"{ticker} 데이터를 가져올 수 없습니다.")

    # 메타/펀더멘털 확보
    ensure_meta_and_fundamentals(ticker, market)

    return build_response(ticker, market, req.interval, req.candle_count)


# ── 전체 새로고침 (백그라운드) ─────────────────────────────
def _do_refresh(stocks: list[dict], interval: str, candle_count: int):
    """백그라운드에서 순차 실행 (0.5초 딜레이)"""
    global refresh_status

    with refresh_lock:
        refresh_status["running"]  = True
        refresh_status["total"]    = len(stocks)
        refresh_status["done"]     = 0
        refresh_status["errors"]   = []

    for s in stocks:
        market = s.get("market") or resolve_market(s["code"])
        ticker = resolve_ticker(s["code"], market)
        try:
            ensure_prices(ticker, market, interval)
            ensure_meta_and_fundamentals(ticker, market)
            print(f"[refresh] {ticker} 완료")
        except Exception as e:
            err = f"{ticker}: {str(e)}"
            print(f"[refresh] 오류 {err}")
            with refresh_lock:
                refresh_status["errors"].append(err)

        with refresh_lock:
            refresh_status["done"] += 1

        time.sleep(0.5)  # yfinance 블럭 방지

    with refresh_lock:
        refresh_status["running"]       = False
        refresh_status["last_finished"] = datetime.now().isoformat()

    print(f"[refresh] 완료: {len(stocks)}종목")


@app.post("/api/refresh")
async def refresh_all(req: RefreshRequest, background_tasks: BackgroundTasks):
    """등록된 모든 종목 일괄 최신화 (백그라운드)"""
    if refresh_status["running"]:
        return JSONResponse({"ok": False, "msg": "이미 새로고침 중입니다."})

    background_tasks.add_task(_do_refresh, req.stocks, req.interval, req.candle_count)
    return {"ok": True, "total": len(req.stocks)}


@app.get("/api/refresh/status")
async def get_refresh_status():
    """새로고침 진행 상태 조회"""
    return refresh_status


# ── 종목 일괄 조회 (새로고침 후 결과 반환) ────────────────
@app.post("/api/stocks")
async def get_stocks(req: RefreshRequest):
    """
    여러 종목을 한 번에 조회해서 반환
    (refresh 완료 후 JS에서 결과 가져올 때 사용)
    """
    results = []
    for s in req.stocks:
        market = s.get("market") or resolve_market(s["code"])
        ticker = resolve_ticker(s["code"], market)
        try:
            data = build_response(ticker, market, req.interval, req.candle_count)
            results.append({"ok": True, "code": s["code"], "data": data})
        except Exception as e:
            results.append({"ok": False, "code": s["code"], "error": str(e)})
    return {"results": results}


# ── 펀더멘털 배치 조회 ────────────────────────────────────
class FundBatchRequest(BaseModel):
    tickers: list[str]   # ["AAPL", "005930", "MSFT"] 형태

@app.post("/api/fundamentals")
async def get_fundamentals_batch(req: FundBatchRequest):
    """
    app.js _fetchAllFundamentals() 에서 호출.
    ticker 목록을 받아 DB에 있는 펀더멘털 반환.
    DB에 없거나 하루 이상 지난 항목은 yfinance에서 갱신.
    반환: { results: { ticker: { trailingPE, eps, beta, ... } } }
    """
    results = {}
    for raw_ticker in req.tickers:
        code   = raw_ticker.upper().replace(".KS", "").replace(".KQ", "")
        market = resolve_market(raw_ticker)
        ticker = resolve_ticker(code, market)

        # 메타/펀더멘털 확보 (필요시 yfinance 조회)
        ensure_meta_and_fundamentals(ticker, market)

        fund = db_get_fundamentals(ticker)
        if fund:
            results[raw_ticker.upper()] = {
                "trailingPE":   fund.get("trailing_pe"),
                "forwardPE":    fund.get("forward_pe"),
                "pbr":          fund.get("pbr"),
                "evToEbitda":   fund.get("ev_to_ebitda"),
                "dividendYield":fund.get("dividend_yield"),
                "eps":          fund.get("eps"),
                "beta":         fund.get("beta"),
                "sector":       fund.get("sector"),
                "_fetchFailed": False,
            }
        else:
            results[raw_ticker.upper()] = {
                "trailingPE": None, "eps": None, "beta": None,
                "_fetchFailed": True,
            }

    return {"results": results}


# ── 헬스 체크 ──────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"ok": True, "time": datetime.now().isoformat()}


# ══════════════════════════════════════════════════════════
#  S&P 500 종목 수집 → bb_tabs "S&P500" 그룹 UPSERT
# ══════════════════════════════════════════════════════════
SP500_CSV_URL = (
    "https://raw.githubusercontent.com/datasets/"
    "s-and-p-500-companies/main/data/constituents.csv"
)
SP500_TAB_NAME = "S&P500"


def _fetch_sp500_tickers() -> list[dict]:
    """GitHub datahub CSV에서 S&P500 구성종목 가져오기"""
    import requests as _req_lib
    import csv, io
    headers = {"User-Agent": "Mozilla/5.0 (compatible; bb-monitor/1.0)"}
    r = _req_lib.get(SP500_CSV_URL, headers=headers, timeout=15)
    r.raise_for_status()
    reader = csv.DictReader(io.StringIO(r.text))
    return [
        {
            "code":   row["Symbol"].strip(),
            "name":   row["Security"].strip(),
            "market": "US",
            "sector": row.get("GICS Sector", "").strip(),
        }
        for row in reader
        if row.get("Symbol", "").strip()
    ]


@app.post("/api/sp500/sync")
async def sp500_sync():
    """
    S&P500 종목 목록을 수집해 bb_tabs 의 'S&P500' 탭에 UPSERT.
    - 탭이 없으면 생성, 있으면 stocks 갱신.
    - 기존에 있었다가 S&P500에서 빠진 종목은 삭제.
    반환: { added, removed, total, tab_id }
    """
    # ① S&P500 최신 목록 수집
    try:
        sp_stocks = _fetch_sp500_tickers()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"S&P500 데이터 수집 실패: {e}")

    sp_codes = {s["code"] for s in sp_stocks}

    # ② bb_tabs 에서 S&P500 탭 찾기
    existing_tabs = _kv_get_all("bb_tabs")
    sp_tab = next((t for t in existing_tabs if t.get("name") == SP500_TAB_NAME), None)

    if sp_tab:
        # 기존 탭의 stocks 파싱
        try:
            old_stocks = json.loads(sp_tab.get("stocks", "[]"))
        except Exception:
            old_stocks = []
        old_codes = {s["code"] for s in old_stocks}

        added   = sp_codes - old_codes          # 새로 편입
        removed = old_codes - sp_codes          # 제외된 종목

        # 최신 목록으로 교체 (이름/섹터도 갱신)
        _kv_patch("bb_tabs", sp_tab["id"], {
            "stocks": json.dumps(sp_stocks, ensure_ascii=False)
        })
        tab_id = sp_tab["id"]
    else:
        # 탭 신규 생성 — sort_order는 기존 탭 수 뒤에
        max_order = max((t.get("sort_order", 0) for t in existing_tabs), default=-1)
        new_tab = _kv_insert("bb_tabs", {
            "name":       SP500_TAB_NAME,
            "sort_order": max_order + 1,
            "stocks":     json.dumps(sp_stocks, ensure_ascii=False),
        })
        tab_id  = new_tab["id"]
        added   = sp_codes
        removed = set()

    return {
        "ok":      True,
        "tab_id":  tab_id,
        "total":   len(sp_stocks),
        "added":   len(added),
        "removed": len(removed),
        "tickers": [s["code"] for s in sp_stocks],
    }


# ── 정적 파일 서빙 (HTML/CSS/JS) ───────────────────────────
app.mount("/css", StaticFiles(directory=str(BASE_DIR / "css")), name="css")
app.mount("/js",  StaticFiles(directory=str(BASE_DIR / "js")),  name="js")

@app.get("/")
async def root():
    return FileResponse(str(BASE_DIR / "index.html"))

@app.get("/favicon.ico")
async def favicon():
    return JSONResponse(status_code=204, content={})


# ══════════════════════════════════════════════════════════
#  시작
# ══════════════════════════════════════════════════════════
init_db()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
