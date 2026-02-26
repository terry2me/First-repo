/**
 * api.js — Python FastAPI 백엔드 연동
 *
 * 기존 Yahoo Finance CORS 프록시 방식에서
 * 로컬 Python 서버(yfinance + SQLite) 호출 방식으로 교체.
 *
 * 외부 인터페이스(fetchStock / fetchMultiple / fetchFundamentals / fetchFundamentalsBatch)는
 * 기존과 동일하게 유지 → app.js / analysis.js 변경 없음.
 *
 * 서버 응답 형식:
 *  {
 *    code, market, ticker, name, currency, isUS, interval, candleCount,
 *    currentPrice, prevClose,
 *    todayChange, todayChangePct,
 *    change, changePct,
 *    candles:    [{ date, close }, ...],
 *    allCandles: [{ date, close }, ...],
 *    closes:     [number, ...],
 *    trailingPE, forwardPE, pbr, evToEbitda, dividendYield, eps, beta
 *  }
 */
const API = (() => {

  /* ── 서버 베이스 URL (같은 origin이므로 상대경로 사용) ── */
  const BASE = '';

  /* ── 시장 판별 (app.js / analysis.js 에서 resolveMarkets 사용 중) ── */
  function resolveMarkets(input) {
    const v = input.trim().toUpperCase();
    if (/^\d{1,6}$/.test(v)) {
      const p = v.padStart(6, '0');
      return [{ ticker: `${p}.KS`, market: 'KS' }];
    }
    if (v.endsWith('.KS')) return [{ ticker: v, market: 'KS' }];
    if (v.endsWith('.KQ')) return [{ ticker: v.replace(/\.KQ$/i, '.KS'), market: 'KS' }];
    return [{ ticker: v, market: 'US' }];
  }

  /* ── 코드 → market 추정 ── */
  function _guessMarket(code) {
    const c = code.toUpperCase().replace(/\.(KS|KQ)$/i, '');
    return /^\d+$/.test(c) ? 'KS' : 'US';
  }

  /* ── 단일 종목 조회 ──────────────────────────────────────
   * 기존 fetchStock(input, candleCount, interval, forceMarket) 시그니처 유지
   * ─────────────────────────────────────────────────────── */
  async function fetchStock(input, candleCount, interval = '1d', forceMarket = null, dbOnly = false) {
    const code   = input.trim().toUpperCase().replace(/\.(KS|KQ)$/i, '');
    const market = forceMarket || _guessMarket(code);

    const res = await fetch(`${BASE}/api/stock`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        market,
        interval,
        candle_count: candleCount,
        db_only:      dbOnly,   // true면 yfinance 호출 없이 DB만 읽음
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(`[${input}] 조회 실패: ${err.detail || res.status}`);
    }

    const data = await res.json();
    return _normalize(data);
  }

  /* ── 여러 종목 조회 (새로고침용) ────────────────────────
   * 1. /api/refresh 로 백그라운드 최신화 요청
   * 2. 완료까지 폴링 (0.8초 간격)
   * 3. /api/stocks 로 결과 일괄 수신
   * 4. onProgress 콜백으로 앱에 진행 상황 전달
   * ─────────────────────────────────────────────────────── */
  async function fetchMultiple(stocks, candleCount, interval, onProgress, dbOnly = false) {
    if (!stocks || stocks.length === 0) return [];

    // db_only=true: /api/refresh(yfinance 배치) 건너뛰고 /api/stocks 직접 호출
    // db_only=false: 기존 /api/refresh → 폴링 → /api/stocks 흐름 유지
    if (!dbOnly) {
      /* ① 백그라운드 새로고침 시작 */
      const refreshRes = await fetch(`${BASE}/api/refresh`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stocks:       stocks.map(s => ({ code: s.code, market: s.market || _guessMarket(s.code) })),
          interval,
          candle_count: candleCount,
          db_only:      false,
        }),
      });
      if (!refreshRes.ok) {
        console.warn('[API] refresh 요청 실패:', refreshRes.status);
      }

      /* ② 완료까지 폴링 */
      for (let i = 0; i < 300; i++) {          // 최대 300 × 0.8s = 4분
        await _sleep(800);
        try {
          const st = await fetch(`${BASE}/api/refresh/status`).then(r => r.json());
          if (!st.running) break;
        } catch (_) { /* 폴링 오류는 무시 */ }
      }
    }

    /* ③ 결과 일괄 수신 (/api/stocks) */
    const stocksRes = await fetch(`${BASE}/api/stocks`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stocks:       stocks.map(s => ({ code: s.code, market: s.market || _guessMarket(s.code) })),
        interval,
        candle_count: candleCount,
        db_only:      dbOnly,
      }),
    });

    if (!stocksRes.ok) {
      console.warn('[API] stocks 요청 실패:', stocksRes.status);
      return stocks.map(() => null);
    }

    const { results } = await stocksRes.json();

    /* ④ onProgress 콜백 + 결과 배열 반환 */
    return results.map((r, i) => {
      const s = stocks[i];
      if (r.ok && r.data) {
        const normalized = _normalize(r.data);
        onProgress?.(s.code, normalized, null);
        return normalized;
      } else {
        const err = new Error(r.error || '조회 실패');
        onProgress?.(s.code, null, err);
        return null;
      }
    });
  }

  /* ── 초기 로딩 전용: 개별 /api/stock 병렬 조회 (DB 캐시 최우선) ───────
   * fetchMultiple(새로고침용)과 달리 /api/refresh를 거치지 않아 빠름.
   * DB에 오늘 데이터가 있으면 yfinance 호출 없이 즉시 반환.
   * concurrency: 동시 요청 수 (기본 5) — yfinance 블록 방지용.
   * ────────────────────────────────────────────────────────────────── */
  async function fetchMultipleFast(stocks, candleCount, interval, onProgress, concurrency = 5, dbOnly = false) {
    if (!stocks || stocks.length === 0) return [];

    const results = new Array(stocks.length).fill(null);

    // concurrency 만큼 동시 실행하는 큐
    let idx = 0;
    async function worker() {
      while (idx < stocks.length) {
        const i = idx++;
        const s = stocks[i];
        try {
          const data = await fetchStock(s.code, candleCount, interval, s.market || null, dbOnly);
          results[i] = data;
          onProgress?.(s.code, data, null);
        } catch (e) {
          results[i] = null;
          onProgress?.(s.code, null, e);
        }
      }
    }

    // concurrency 개의 worker를 동시에 실행
    const workers = Array.from({ length: Math.min(concurrency, stocks.length) }, worker);
    await Promise.all(workers);
    return results;
  }

  /* ── 서버 응답 → app.js 호환 형식으로 정규화 ────────────
   * 서버는 { date, close } 형태로 캔들을 전달.
   * app.js / indicators.js 는 candles[i].close 를 사용하므로 호환됨.
   * ─────────────────────────────────────────────────────── */
  function _normalize(d) {
    return {
      code:           d.code,
      market:         d.market,
      ticker:         d.ticker,
      name:           d.name,
      currency:       d.currency,
      isUS:           d.isUS,
      interval:       d.interval,
      candleCount:    d.candleCount,
      currentPrice:   d.currentPrice,
      prevClose:      d.prevClose,
      todayChange:    d.todayChange,
      todayChangePct: d.todayChangePct,
      change:         d.change,
      changePct:      d.changePct,
      candles:        d.candles     || [],
      allCandles:     d.allCandles  || [],
      closes:         d.closes      || [],
      // 펀더멘털
      trailingPE:     d.trailingPE     ?? null,
      forwardPE:      d.forwardPE      ?? null,
      pbr:            d.pbr            ?? null,
      evToEbitda:     d.evToEbitda     ?? null,
      dividendYield:  d.dividendYield  ?? null,
      eps:            d.eps            ?? null,
      beta:           d.beta           ?? null,
      sector:         d.sector         ?? null,
    };
  }

  /* ── 펀더멘털 단일 조회 (하위 호환) ─────────────────────
   * app.js 에서 fetchFundamentals(ticker) 형태로 호출.
   * 서버 응답에 이미 펀더멘털이 포함되어 있으므로
   * fetchStock 결과에서 추출하는 방식으로 처리.
   * ─────────────────────────────────────────────────────── */
  const _EMPTY_FUND = Object.freeze({ trailingPE: null, eps: null, beta: null, _fetchFailed: true });

  async function fetchFundamentals(ticker) {
    const map = await fetchFundamentalsBatch([ticker]);
    return map.get(ticker.toUpperCase()) ?? { ..._EMPTY_FUND };
  }

  async function fetchFundamentalsBatch(tickers) {
    const result = new Map();
    try {
      const res = await fetch(`${BASE}/api/fundamentals`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers }),
      });
      if (!res.ok) throw new Error(`fundamentals HTTP ${res.status}`);
      const { results } = await res.json();

      for (const ticker of tickers) {
        const key  = ticker.toUpperCase();
        const data = results[key];
        if (data && !data._fetchFailed) {
          result.set(key, {
            trailingPE:   data.trailingPE   ?? null,
            forwardPE:    data.forwardPE    ?? null,
            pbr:          data.pbr          ?? null,
            evToEbitda:   data.evToEbitda   ?? null,
            dividendYield:data.dividendYield ?? null,
            eps:          data.eps          ?? null,
            beta:         data.beta         ?? null,
            sector:       data.sector       ?? null,
            _fetchFailed: false,
          });
        } else {
          result.set(key, { ..._EMPTY_FUND });
        }
      }
    } catch (e) {
      console.warn('[API] fetchFundamentalsBatch 오류:', e.message);
      for (const ticker of tickers) {
        result.set(ticker.toUpperCase(), { ..._EMPTY_FUND });
      }
    }
    return result;
  }

  /* ── 유틸 ── */
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  return {
    fetchStock,
    fetchMultiple,
    fetchMultipleFast,
    resolveMarkets,
    fetchFundamentals,
    fetchFundamentalsBatch,
  };
})();
