"""server.py — FastAPI 백엔드 (yfinance + SQLite)

API 구조 (6개):
  POST /api/stock        — 단일 종목: DB 우선, 없으면 yfinance → DB 저장 → 반환
  POST /api/stock/batch  — 배치 조회: DB only, 서버 내부 병렬, yfinance 절대 없음
  GET  /api/config       — 탭 목록 + 설정값 일괄 반환
  POST /api/config       — 탭/설정 변경 upsert (전체 상태 덮어쓰기)
  POST /api/sp500/sync   — GitHub CSV → 티커 파싱 → S&P500 탭 upsert
  GET  /api/health       — 서버 상태

DB 테이블:
  stock_prices      — 주가 (ticker, interval, date, OHLCV)
  stock_meta        — 종목명·통화·섹터
  stock_fundamentals— PE·PBR·EPS·Beta 등
  _kv_store         — 탭(bb_tabs) + 설정(bb_settings) KV 저장소

스케줄러: 매일 04:00 KST 전체 종목 자동 업데이트 (1d + 1wk)
정적 파일: index.html / css / js 서빙 (포트 8000)
"""

import sqlite3
import time
import threading
import traceback
import uuid
import json
import asyncio
import concurrent.futures
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Optional, Any
from zoneinfo import ZoneInfo

import yfinance as yf
import yfinance.exceptions as yf_exc
from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
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

# ── ThreadPoolExecutor (batch 병렬 처리용) ────────────────────────
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=20)


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

    # 가격 테이블
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
    
    # 인덱스 추가 (조회 성능 최적화)
    c.execute("CREATE INDEX IF NOT EXISTS idx_stock_prices_lookup ON stock_prices (ticker, interval, date DESC)")

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

    # 기존 DB 마이그레이션 (필요한 경우에만)
    for col in ['open', 'high', 'low', 'volume']:
        try:
            c.execute(f'ALTER TABLE stock_prices ADD COLUMN {col} REAL')
        except Exception: pass

    try:
        c.execute('ALTER TABLE stock_fundamentals ADD COLUMN sector TEXT')
    except Exception: pass

    # ── KV 저장소 ──
    c.execute("""
        CREATE TABLE IF NOT EXISTS _kv_store (
            table_name TEXT NOT NULL,
            row_id     TEXT NOT NULL,
            data       TEXT NOT NULL,
            PRIMARY KEY (table_name, row_id)
        )
    """)

    # ── 한국 주식 종목명 맵핑 ──
    c.execute("""
        CREATE TABLE IF NOT EXISTS kr_stock_names (
            code TEXT PRIMARY KEY,
            name_kr TEXT NOT NULL
        )
    """)

    # ── 상관관계 테이블 ──
    c.execute("""
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

    conn.commit()
    conn.close()
    print("[DB] 초기화 및 인덱스 최적화 완료")


# ══════════════════════════════════════════════════════════
#  KV 헬퍼 (스케줄러 / sp500/sync 내부 전용)
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

# yfinance에서 실제 사용하는 티커가 표준 코드와 다른 경우 매핑
# BRK.B / BF.B : S&P500 CSV는 점(.) 사용, yfinance는 하이픈(-) 사용
# FI : S&P500 CSV 코드, yfinance에서는 FISV(Fiserv) 로 조회됨
_TICKER_ALIAS: dict[str, str] = {
    "BRK.B": "BRK-B",   # Berkshire Hathaway B
    "BF.B":  "BF-B",    # Brown-Forman B
    "FI":    "FISV",    # Fiserv (S&P CSV 코드 FI → yfinance FISV)
}

def resolve_ticker(code: str, market: str) -> str:
    """코드 + 시장 → yfinance ticker 문자열"""
    if code.upper() == "^KS200":
        return "^KS200"
    if market == "US":
        upper = code.upper()
        return _TICKER_ALIAS.get(upper, upper)
    code_clean = code.replace(".KS", "").replace(".KQ", "")
    # 숫자만 있는 경우 zfill(6), 영숫자 혼합(예: 0126Z0)은 그대로 사용
    if code_clean.isdigit():
        code_clean = code_clean.zfill(6)
    return f"{code_clean}.KS"


def resolve_market(code: str) -> str:
    """코드만으로 시장 추정"""
    c = code.upper().replace(".KS", "").replace(".KQ", "")
    # 순수 숫자 → KS
    if c.isdigit():
        return "KS"
    # 6자리 영숫자 혼합 (예: 0126Z0, 4390Z1 등 한국 특수 코드) → KS
    if len(c) == 6 and c[0].isdigit():
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
                "open":   round(float(row["Open"]),   4),  # type: ignore
                "high":   round(float(row["High"]),   4),  # type: ignore
                "low":    round(float(row["Low"]),    4),  # type: ignore
                "close":  round(float(row["Close"]),  4),  # type: ignore
                "volume": float(row.get("Volume", 0) or 0),
            })
        return rows
    except yf_exc.YFRateLimitError:
        print(f"[yfinance] {ticker_str} Rate Limit 발생")
        return "__RATE_LIMIT__"
    except Exception as e:
        print(f"[yfinance] {ticker_str} history 오류: {e}")
        return []


def _yf_download_batch(tickers: list[str], start: str, end: str, interval: str) -> dict[str, list[dict]]:
    """yfinance.download()를 이용한 다중 종목 일괄 조회"""
    if not tickers:
        return {}
    try:
        ticker_str = " ".join(tickers)
        end_dt = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        
        # threads=True (기본값)로 내부 병렬 처리 활용
        df = yf.download(ticker_str, start=start, end=end_dt, interval=interval, 
                         group_by='ticker', auto_adjust=True, progress=False)
        
        if df.empty:
            return {t: [] for t in tickers}
            
        result = {}
        for ticker in tickers:
            try:
                # 다중 종목인 경우 MultiIndex, 단일 종목인 경우 일반 Index일 수 있음
                if len(tickers) > 1:
                    if ticker not in df.columns.levels[0]:
                        result[ticker] = []
                        continue
                    ticker_df = df[ticker].dropna(subset=['Close'])
                else:
                    ticker_df = df.dropna(subset=['Close'])
                
                rows = []
                ticker_df.index = ticker_df.index.tz_localize(None) if ticker_df.index.tzinfo else ticker_df.index
                for idx, row in ticker_df.iterrows():
                    rows.append({
                        "date":   idx.strftime("%Y-%m-%d"),
                        "open":   round(float(row["Open"]),   4),
                        "high":   round(float(row["High"]),   4),
                        "low":    round(float(row["Low"]),    4),
                        "close":  round(float(row["Close"]),  4),
                        "volume": float(row.get("Volume", 0) or 0),
                    })
                result[ticker] = rows
            except Exception as e:
                print(f"[yfinance] {ticker} 파싱 오류: {e}")
                result[ticker] = []
        return result
    except yf_exc.YFRateLimitError:
        print(f"[yfinance] batch download Rate Limit 발생")
        return {"__fatal__": True}
    except Exception as e:
        print(f"[yfinance] batch download 오류: {e}")
        return {t: [] for t in list(tickers) + ["__fatal__"]}


def _yf_fetch_meta(ticker_str: str) -> dict:
    """종목 메타 + 펀더멘털 조회"""
    try:
        t = yf.Ticker(ticker_str)
        info = t.info or {}
        return {
            "name":           info.get("longName") or info.get("shortName") or "",  # 없으면 빈 문자열
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


def _get_cache_cutoff(market: str, interval: str) -> str:
    """
    interval별 캐시 유효 기준 날짜 반환.

    - 1d  : 마지막 거래일 날짜와 DB 날짜가 정확히 일치해야 HIT
    - 1wk : 시장별 데이터 확정 시점 이전이면 지난주 월요일, 이후면 이번 주 월요일 기준 날짜 반환
    """
    if interval == "1wk":
        now_kst = datetime.now(TZ_KST)
        # 이번 주 월요일 (KST 기준)
        this_monday_kst = now_kst - timedelta(days=now_kst.weekday())
        this_monday_str = this_monday_kst.strftime("%Y-%m-%d")
        last_monday_str = (this_monday_kst - timedelta(days=7)).strftime("%Y-%m-%d")

        if market == "US":
            # 화요일 오전 10시(KST) 전에는 지난주 주봉 데이터를 기준으로 캐시 유지 (미국 월요일 장 마감 대기)
            is_safe = (now_kst.weekday() > 1) or (now_kst.weekday() == 1 and now_kst.hour >= 10)
            return this_monday_str if is_safe else last_monday_str
        else:
            # 한국 시장: 월요일 오후 4시(KST) 전에는 지난주 주봉 데이터를 기준으로 캐시 유지
            is_safe = (now_kst.weekday() > 0) or (now_kst.weekday() == 0 and now_kst.hour >= 16)
            return this_monday_str if is_safe else last_monday_str

    # 일봉(1d) 및 기타: 마지막 거래일 기준
    return get_last_trading_date(market)


def db_has_today(ticker: str, interval: str, market: str) -> bool:
    """캔들 interval별 캐시 유효 여부 확인.

    - 1d  : DB에 마지막 거래일 날짜 행이 있으면 HIT
    - 1wk : DB에 이번 주 월요일 이후 데이터가 있으면 HIT
              (주봉은 그 주 시작일 기록이므로 정확한 날짜 매칭 불필요)
    """
    cutoff = _get_cache_cutoff(market, interval)
    conn   = get_db()
    if interval == "1wk":
        # 이번 주 월요일 이후 날짜가 존재하면 HIT
        row = conn.execute(
            "SELECT 1 FROM stock_prices WHERE ticker=? AND date>=? AND interval=?",
            (ticker, cutoff, interval)
        ).fetchone()
    else:
        # 일봉: 마지막 거래일과 정확히 일치
        row = conn.execute(
            "SELECT 1 FROM stock_prices WHERE ticker=? AND date=? AND interval=?",
            (ticker, cutoff, interval)
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


def db_get_kr_name(code: str) -> Optional[str]:
    conn = get_db()
    c = code.upper().replace(".KS", "").replace(".KQ", "")
    row = conn.execute("SELECT name_kr FROM kr_stock_names WHERE code=?", (c,)).fetchone()
    conn.close()
    return row["name_kr"] if row else None


# ══════════════════════════════════════════════════════════
#  핵심 조회 로직
# ══════════════════════════════════════════════════════════
def ensure_prices(ticker: str, market: str, interval: str, force: bool = False) -> bool:
    """
    force=False(기본): DB에 오늘 날짜 있으면 캐시 사용
    force=True(새로고침): 캐시 무시, DB 마지막 날짜부터 yfinance 재조회 → 덮어쓰기
    반환: 성공 여부
    """
    # 주봉 예외 처리: 데이터 확정 전(미국 화요일 10시 KST, 한국 월요일 16시 KST)에는 
    # 강제 새로고침(force=True)일지라도 기존 데이터가 있으면 무리하게 fetch하지 않음 (실패 방지)
    if interval == "1wk" and force and db_has_today(ticker, interval, market):
        now_kst = datetime.now(TZ_KST)
        if market == "US":
            is_safe = (now_kst.weekday() > 1) or (now_kst.weekday() == 1 and now_kst.hour >= 10)
        else:
            is_safe = (now_kst.weekday() > 0) or (now_kst.weekday() == 0 and now_kst.hour >= 16)
        
        if not is_safe:
            print(f"[skip] {ticker} ({interval}) 아직 주봉 생성 전 → 기존 데이터 유지")
            return True

    if not force and db_has_today(ticker, interval, market):
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

    if rows == "__RATE_LIMIT__":
        return "__RATE_LIMIT__"

    if not rows:
        print(f"[yfinance] {ticker} ({interval}) 데이터 없음")
        return False

    db_upsert_prices(ticker, rows, interval)
    print(f"[DB] {ticker} ({interval}) {len(rows)}건 저장")
    return True


def ensure_prices_batch(stocks_info: list[dict], interval: str, force: bool = False) -> dict[str, bool]:
    """yf.download를 이용한 다중 종목 가격 업데이트"""
    results = {}
    to_fetch = []
    
    # 캐시 확인 및 대상 선정
    now_kst = datetime.now(TZ_KST)
    for s in stocks_info:
        ticker = s['ticker']
        market = s['market']

        # 주봉 예외 처리: 데이터 확정 전에는 강제 새로고침이라도 기존 데이터가 있으면 유지
        if interval == "1wk" and force and db_has_today(ticker, interval, market):
            if market == "US":
                is_safe = (now_kst.weekday() > 1) or (now_kst.weekday() == 1 and now_kst.hour >= 10)
            else:
                is_safe = (now_kst.weekday() > 0) or (now_kst.weekday() == 0 and now_kst.hour >= 16)
            
            if not is_safe:
                results[ticker] = True
                continue

        if not force and db_has_today(ticker, interval, market):
            results[ticker] = True
        else:
            to_fetch.append(s)
            
    if not to_fetch:
        return results

    # 가장 오래된 시작 날짜 찾기 (배치 조회를 위해 통합)
    earliest_start = None
    tickers_to_fetch = [s['ticker'] for s in to_fetch]
    
    for s in to_fetch:
        ld = db_get_last_date(s['ticker'], interval)
        if ld:
            cur_start = ld
        else:
            cur_start = (datetime.now() - timedelta(days=730)).strftime("%Y-%m-%d")
        
        if earliest_start is None or cur_start < earliest_start:
            earliest_start = cur_start

    # 일괄 다운로드
    market = to_fetch[0]['market'] # 대부분 한 탭은 같은 시장임
    today = get_today_str(market)
    print(f"[yfinance] batch download {len(tickers_to_fetch)}종목: {earliest_start} ~ {today}")
    
    all_data = _yf_download_batch(tickers_to_fetch, earliest_start, today, interval)
    
    # DB 저장
    is_fatal = all_data.get("__fatal__", False)
    if is_fatal:
        results["__fatal__"] = True

    for ticker, rows in all_data.items():
        if ticker == "__fatal__": continue
        if rows:
            db_upsert_prices(ticker, rows, interval)
            results[ticker] = True
        elif not is_fatal:
            # 다운로드 실패 시 개별 재시도 (이미 Rate Limit 상태면 생략)
            print(f"[yfinance] {ticker} 배치 실패 -> 개별 재시도")
            retry_res = ensure_prices(ticker, market, interval, force=True)
            if retry_res == "__RATE_LIMIT__":
                results["__fatal__"] = True
                results[ticker] = False
            else:
                results[ticker] = retry_res
        else:
            results[ticker] = False
            
    return results


def ensure_meta_and_fundamentals(ticker: str, market: str, force: bool = False):
    """
    메타/펀더멘털이 없거나 force=True이면 yfinance에서 조회해서 저장.
    펀더멘털은 마지막 거래일 기준 1회만 갱신.

    yfinance 조회 실패(rate-limit 등) 시에도 빈 sentinel 레코드를 저장해
    다음 요청에서 반복 호출되지 않도록 방지.
    sentinel: fetched_at = None → 다음 거래일이 오면 재시도.
    """
    meta = db_get_meta(ticker)
    fund = db_get_fundamentals(ticker)

    # 펀더멘털 갱신 필요 여부 판단 (이번 달 기준 1회 캐싱 - 펀더멘털은 자주 변하지 않음)
    need_fund = force or fund is None
    if fund and fund.get("fetched_at"):
        try:
            fetched = datetime.fromisoformat(fund["fetched_at"])
            now_dt = datetime.now()
            # 오늘 날짜면 갱신하지 않음 (일간 캐시)
            if fetched.date() == now_dt.date():
                need_fund = False
            else:
                need_fund = True
        except Exception:
            need_fund = True
    elif fund and fund.get("fetched_at") is None:
        need_fund = True

    # name이 비어있거나 ticker/숫자코드 그대로인 경우 → 이전 조회 실패 → 무조건 재시도
    _bad_name = lambda n: not n or n == ticker or n.replace(".KS","").replace(".KQ","") == n and n.isdigit()
    if meta is not None and _bad_name((meta.get("name") or "").strip()):
        need_fund = True

    if meta is None or need_fund:
        print(f"[yfinance] {ticker} meta 조회")
        yf_data = _yf_fetch_meta(ticker)
        if yf_data:
            name     = yf_data.get("name", "").strip()
            currency = yf_data.get("currency", "")
            if name:  # yfinance에서 이름을 가져온 경우에만 저장
                db_upsert_meta(ticker, name, currency, market)
            else:
                print(f"[yfinance] {ticker} name 없음 → 기존 값 유지")
            db_upsert_fundamentals(ticker, yf_data)
            print(f"[DB] {ticker} meta/fund 저장 완료")
        else:
            # yfinance 실패 시 sentinel 저장 → 이 요청 안에서 반복 호출 차단
            # fetched_at=현재시각으로 저장 → 다음 거래일 전까지 재시도 안 함
            print(f"[yfinance] {ticker} meta 조회 실패 → sentinel 저장 (재시도 억제)")
            if meta is None:
                db_upsert_meta(ticker, "", "USD" if market == "US" else "KRW", market)
            if fund is None:
                db_upsert_fundamentals(ticker, {})  # 빈 값, fetched_at=now → 오늘은 재시도 안 함


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
    period_prices  = prices[-candle_count:] if len(prices) > candle_count else prices  # type: ignore
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

    if not is_us:
        # 한국 주식이면 DB에서 한글명 찾아서 덮어쓰기
        kr_name = db_get_kr_name(ticker)
        if kr_name:
            name = kr_name

    # 코드 정제
    code = ticker.replace(".KS", "").replace(".KQ", "")
    if not is_us:
        code = code.zfill(6)

    res = {
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

    # 상관관계 데이터 조회 후 병합
    try:
        conn = get_db()
        c = conn.cursor()
        c.execute("SELECT * FROM stock_correlations WHERE target_code=?", (code,))
        row = c.fetchone()
        
        def get_meta_name(cc):
            # 1. kr_stock_names에서 한글명 시도 (6자리 패딩)
            cc_6 = cc.zfill(6) if cc.isdigit() else cc
            c_exe = conn.execute("SELECT name_kr FROM kr_stock_names WHERE code=?", (cc_6,)).fetchone()
            if c_exe: return c_exe[0]

            # 2. stock_meta에서 영문명 또는 기타 명칭 시도
            # (한국 종목은 .KS/.KQ 접미사 시도, 미국 종목은 그대로)
            if cc.isdigit() or (len(cc) == 6 and any(c.isalpha() for c in cc)):
                m_exe = conn.execute("SELECT name FROM stock_meta WHERE ticker=? OR ticker=?", (cc+".KS", cc+".KQ")).fetchone()
                if m_exe: return m_exe[0]
            
            m_exe = conn.execute("SELECT name FROM stock_meta WHERE ticker=?", (cc,)).fetchone()
            if m_exe: return m_exe[0]
            
            return cc
            
        if row:
            res["correlations"] = {
                "pos": {"code": row["pos_code"], "name": get_meta_name(row["pos_code"]), "val": row["pos_val"]},
                "neu": {"code": row["neu_code"], "name": get_meta_name(row["neu_code"]), "val": row["neu_val"]},
                "neg": {"code": row["neg_code"], "name": get_meta_name(row["neg_code"]), "val": row["neg_val"]}
            }
        conn.close()
    except Exception:
        pass

    return res


# ══════════════════════════════════════════════════════════
#  API 엔드포인트
# ══════════════════════════════════════════════════════════

# ── 요청 모델 ──────────────────────────────────────────────
class StockRequest(BaseModel):
    code:         str
    market:       Optional[str] = None
    interval:     str = "1d"
    candle_count: int = 52


class BatchRequest(BaseModel):
    stocks:       list[dict]   # [{ code, market }]
    interval:     str = "1d"
    candle_count: int = 52


# ── 단일 종목 조회 ──────────────────────────────────────────
# DB 우선, 없으면 yfinance → DB 저장 → 반환
# 검색(B), 리스트 클릭(F), 일봉/주봉 미리보기(D/E) 모두 이 엔드포인트
@app.post("/api/stock")
async def get_stock(req: StockRequest):
    market = req.market or resolve_market(req.code)
    ticker = resolve_ticker(req.code, market)
    ok = ensure_prices(ticker, market, req.interval)
    if not ok:
        raise HTTPException(status_code=404, detail=f"{ticker} 데이터를 가져올 수 없습니다.")
    ensure_meta_and_fundamentals(ticker, market)
    return build_response(ticker, market, req.interval, req.candle_count)


# ── 배치 조회 (DB only, 서버 내부 병렬) ─────────────────────
# 초기 접속(A), 일봉/주봉 리스트 갱신(D/E) 에서 사용
# yfinance 절대 호출 안 함 — 데이터 없는 종목은 null 반환
@app.post("/api/stock/batch")
async def get_stock_batch(req: BatchRequest):
    def _fetch_one(s: dict) -> dict:
        code   = s.get("code", "")
        market = s.get("market") or resolve_market(code)
        ticker = resolve_ticker(code, market)
        try:
            prices = db_get_prices(ticker, req.interval, limit=req.candle_count + 60)
            if not prices:
                return {"code": code, "data": None}
            data = build_response(ticker, market, req.interval, req.candle_count)
            return {"code": code, "data": data}
        except Exception as e:
            return {"code": code, "data": None, "error": str(e)}

    loop    = asyncio.get_event_loop()
    futures = [loop.run_in_executor(_executor, _fetch_one, s) for s in req.stocks]
    results = await asyncio.gather(*futures)
    return {"results": list(results)}


# ── 탭 새로고침 (yfinance 포함, 순차) ─────────────────────────
# 새로고침 버튼 — 현재 탭 종목만 대상
# DB 우선, 없으면 yfinance → DB 저장 → 반환
# 순차 실행 + 0.5s 딜레이로 yfinance rate-limit 방지
@app.post("/api/stock/refresh")
async def refresh_tab_stocks(req: BatchRequest):
    # 1. 티커 및 시장 정보 전처리
    stocks_info = []
    for s in req.stocks:
        code = s.get("code", "")
        market = s.get("market") or resolve_market(code)
        ticker = resolve_ticker(code, market)
        stocks_info.append({"code": code, "market": market, "ticker": ticker})

    # 2. 가격 통합 조회 및 저장 (일봉 -> 주봉 순차 처리)
    loop = asyncio.get_event_loop()
    
    # 일봉 데이터를 먼저 가져옴
    res_1d = await loop.run_in_executor(
        _executor, ensure_prices_batch, stocks_info, "1d", True
    )
    # 주봉 데이터를 이어서 순차적으로 가져옴
    res_1wk = await loop.run_in_executor(
        _executor, ensure_prices_batch, stocks_info, "1wk", True
    )

    # 응답 판단용 매핑 (요청받은 인터벌 기준)
    price_results = res_1d if req.interval == "1d" else res_1wk

    # 3. 메타/펀더멘털 및 응답 생성 (여전히 종목당 meta 조회 필요하므로 병렬 처리)
    def _finalize_one(s_info: dict) -> dict:
        ticker = s_info['ticker']
        code = s_info['code']
        market = s_info['market']
        try:
            is_fatal = price_results.get("__fatal__", False)
            if not price_results.get(ticker):
                return {"code": code, "data": None, "error": "가격 데이터 없음", "fatal": is_fatal}
                
            # 메타/펀더멘털은 일간 캐시가 적용되어 있어 날이 바뀌지 않았으면 DB 조회만 함
            ensure_meta_and_fundamentals(ticker, market)
            
            data = build_response(ticker, market, req.interval, req.candle_count)
            return {"code": code, "data": data}
        except Exception as e:
            return {"code": code, "data": None, "error": str(e), "fatal": False}

    futures = [loop.run_in_executor(_executor, _finalize_one, s) for s in stocks_info]
    results = await asyncio.gather(*futures)
    return {"results": list(results)}


# ══════════════════════════════════════════════════════════
#  /api/config — 탭 + 설정 전담 (GET: 읽기, POST: 쓰기)
# ══════════════════════════════════════════════════════════

@app.get("/api/config")
async def config_get():
    """탭 목록 + 설정값 일괄 반환."""
    tab_rows = _kv_get_all("bb_tabs")
    tabs = sorted(
        [
            {
                "uid":        r["id"],
                "name":       r.get("name", "기본"),
                "sort_order": r.get("sort_order", 0),
                "stocks":     json.loads(r["stocks"]) if isinstance(r.get("stocks"), str)
                              else (r.get("stocks") or []),
                "column_widths": r.get("column_widths", {}),
            }
            for r in tab_rows
        ],
        key=lambda t: t["sort_order"]
    )
    if not tabs:
        row = _kv_insert("bb_tabs", {"name": "기본", "sort_order": 0, "stocks": "[]"})
        tabs = [{"uid": row["id"], "name": "기본", "sort_order": 0, "stocks": []}]

    setting_rows = _kv_get_all("bb_settings")
    settings: dict = {}
    for r in setting_rows:
        k = r.get("key")
        if k and k != r.get("id"):
            settings[k] = r.get("value", "")

    return {"tabs": tabs, "settings": settings}


class ConfigRequest(BaseModel):
    tabs:     Optional[list[dict]] = None
    settings: Optional[dict]       = None


@app.post("/api/config")
async def config_post(req: ConfigRequest):
    """탭/설정 upsert. tabs: 전체 교체, settings: 키별 upsert."""
    if req.tabs is not None:
        for r in _kv_get_all("bb_tabs"):
            _kv_delete("bb_tabs", r["id"])
        for tab in (req.tabs or []):
            _kv_insert("bb_tabs", {
                "id":         tab.get("uid") or str(uuid.uuid4()),
                "name":       tab.get("name", "기본"),
                "sort_order": tab.get("sort_order", 0),
                "stocks":     json.dumps(tab.get("stocks", []), ensure_ascii=False),
                "column_widths": tab.get("column_widths", {}),
            })

    if req.settings is not None:
        setting_rows = _kv_get_all("bb_settings")
        key_to_id = {
            r.get("key"): r["id"]
            for r in setting_rows
            if r.get("key") and r.get("key") != r.get("id")
        }
        for k, v in (req.settings or {}).items():
            if k in key_to_id:
                _kv_patch("bb_settings", key_to_id[k], {"value": str(v)})
            else:
                _kv_insert("bb_settings", {"key": k, "value": str(v)})

    return {"ok": True}


# ── 헬스 체크 ─────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {
        "ok": True, 
        "time": datetime.now().isoformat(),
    }


# ══════════════════════════════════════════════════════════
#  S&P 500 종목 수집 → bb_tabs "S&P500" 그룹 UPSERT
# ══════════════════════════════════════════════════════════
SP500_CSV_URL = (
    "https://raw.githubusercontent.com/datasets/"
    "s-and-p-500-companies/main/data/constituents.csv"
)
SP500_TAB_NAME = "S&P500"


def _fetch_sp500_tickers() -> list[dict]:
    """GitHub datahub CSV에서 S&P500 구성종목 가져오기.
    S&P500 CSV는 BRK.B / BF.B 처럼 점(.)을 사용하지만,
    yfinance 및 내부 DB는 하이픈(-)을 사용하므로 변환한다.
    """
    import requests as _req_lib
    import csv, io
    headers = {"User-Agent": "Mozilla/5.0 (compatible; bb-monitor/1.0)"}
    r = _req_lib.get(SP500_CSV_URL, headers=headers, timeout=15)
    r.raise_for_status()
    reader = csv.DictReader(io.StringIO(r.text))
    result = []
    for row in reader:
        raw_code = row.get("Symbol", "").strip()
        if not raw_code:
            continue
        # 점(.) → 하이픈(-) 변환 (BRK.B → BRK-B, BF.B → BF-B 등)
        code = raw_code.replace(".", "-")
        result.append({
            "code":   code,
            "name":   row["Security"].strip(),
            "market": "US",
            "sector": row.get("GICS Sector", "").strip(),
        })
    return result


def _fetch_nasdaq100_tickers() -> list[dict]:
    """Wikipedia에서 Nasdaq 100 구성종목 가져오기."""
    import requests as _req_lib
    from bs4 import BeautifulSoup
    headers = {"User-Agent": "Mozilla/5.0"}
    r = _req_lib.get("https://en.wikipedia.org/wiki/Nasdaq-100", headers=headers, timeout=15)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, 'html.parser')
    table = soup.find('table', {'id': 'constituents'})
    result = []
    if table:
        rows = table.find_all('tr')
        for row in rows[1:]:
            cols = row.find_all('td')
            if len(cols) >= 2:
                code = cols[0].text.strip()
                name = cols[1].text.strip()
                if code:
                    result.append({"code": code, "name": name, "market": "US", "sector": ""})
    return result


def _fetch_kospi200_tickers() -> list[dict]:
    """Wikipedia에서 KOSPI 200 구성종목 가져오기."""
    import requests as _req_lib
    from bs4 import BeautifulSoup
    headers = {"User-Agent": "Mozilla/5.0"}
    r = _req_lib.get("https://ko.wikipedia.org/wiki/%EC%BD%94%EC%8A%A4%ED%94%BC_200", headers=headers, timeout=15)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, 'html.parser')
    tables = soup.find_all('table', {'class': 'wikitable'})
    result = []
    for table in tables:
        rows = table.find_all('tr')
        if len(rows) > 100:  # KOSPI 200 테이블은 항목이 많음
            for row in rows[1:]:
                cols = row.find_all('td')
                if len(cols) >= 2:
                    name = cols[0].text.strip()
                    code = cols[1].text.strip()
                    if code:
                        if not code.endswith(".KS"):
                            code += ".KS"
                        result.append({"code": code, "name": name, "market": "KS", "sector": ""})
            break
    return result


def _sync_index(tab_name: str, fetch_func) -> dict:
    """일반화된 인덱스 동기화 헬퍼 함수"""
    try:
        stocks = fetch_func()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"{tab_name} 데이터 수집 실패: {e}")

    codes = {s["code"] for s in stocks}
    existing_tabs = _kv_get_all("bb_tabs")
    tab = next((t for t in existing_tabs if t.get("name") == tab_name), None)

    if tab:
        try:
            old_stocks = json.loads(tab.get("stocks", "[]"))
        except Exception:
            old_stocks = []
        old_codes = {s["code"] for s in old_stocks}

        added   = codes - old_codes
        removed = old_codes - codes

        _kv_patch("bb_tabs", tab["id"], {
            "stocks": json.dumps(stocks, ensure_ascii=False)
        })
        tab_id = tab["id"]
    else:
        max_order = max((t.get("sort_order", 0) for t in existing_tabs), default=-1)
        new_tab = _kv_insert("bb_tabs", {
            "name":       tab_name,
            "sort_order": max_order + 1,
            "stocks":     json.dumps(stocks, ensure_ascii=False),
        })
        tab_id  = new_tab["id"]
        added   = codes
        removed = set()

    return {
        "ok":      True,
        "tab_id":  tab_id,
        "total":   len(stocks),
        "added":   len(added),
        "removed": len(removed),
        "tickers": [s["code"] for s in stocks],
    }


@app.post("/api/sp500/sync")
async def sp500_sync():
    return _sync_index("S&P500", _fetch_sp500_tickers)


@app.post("/api/nasdaq100/sync")
async def nasdaq100_sync():
    return _sync_index("Nasdaq", _fetch_nasdaq100_tickers)


@app.post("/api/kospi200/sync")
async def kospi200_sync():
    return _sync_index("코스피", _fetch_kospi200_tickers)

@app.post("/api/correlations/sync")
async def correlations_sync():
    def _run_correlations():
        import subprocess
        # 비동기 상황에서 스레딩/프로세스 블락이 생길 수 있으므로 스크립트 실행으로 위임
        try:
            # 경로 교정: testcodes/calculate_correlations.py 사용
            script_path = BASE_DIR / "testcodes" / "calculate_correlations.py"
            subprocess.run(["python", str(script_path)], check=True)
            return True
        except subprocess.CalledProcessError:
            return False
            
    loop = asyncio.get_event_loop()
    success = await loop.run_in_executor(_executor, _run_correlations)
    
    if success:
        return {"ok": True, "message": "Correlations updated"}
    else:
        raise HTTPException(status_code=500, detail="Failed to calculate correlations")



@app.get("/api/time")
async def get_server_time():
    """서버 기준 시장 마감 여부 및 마지막 거래일 정보 반환"""
    us_last = get_last_trading_date("US")
    ks_last = get_last_trading_date("KS")
    us_closed = is_market_closed("US")
    ks_closed = is_market_closed("KS")
    
    return {
        "ok": True,
        "now_kst": datetime.now(TZ_KST).isoformat(),
        "markets": {
            "US": {"last_trading_date": us_last, "is_closed": us_closed},
            "KS": {"last_trading_date": ks_last, "is_closed": ks_closed}
        }
    }

# ── 정적 파일 서빙 (HTML/CSS/JS) ───────────────────────────
app.mount("/common", StaticFiles(directory=str(BASE_DIR / "common")), name="common")
app.mount("/watchlist", StaticFiles(directory=str(BASE_DIR / "watchlist"), html=True), name="watchlist")
app.mount("/backtest", StaticFiles(directory=str(BASE_DIR / "backtest"), html=True), name="backtest")
app.mount("/discovery", StaticFiles(directory=str(BASE_DIR / "discovery"), html=True), name="discovery")
app.mount("/filter", StaticFiles(directory=str(BASE_DIR / "filter"), html=True), name="filter")
app.mount("/Indexsimulation", StaticFiles(directory=str(BASE_DIR / "Indexsimulation"), html=True), name="simulation")

@app.get("/")
async def root():
    return FileResponse(str(BASE_DIR / "index.html"))

@app.get("/watchlist.html")
async def watchlist():
    return FileResponse(str(BASE_DIR / "watchlist" / "index.html"))

@app.get("/favicon.ico")
async def favicon():
    return Response(status_code=204)


# ══════════════════════════════════════════════════════════
#  시작
# ══════════════════════════════════════════════════════════
init_db()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=True)
