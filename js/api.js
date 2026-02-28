/**
 * api.js — FastAPI 백엔드 연동
 *
 * 읽기 흐름
 *   접속        → GET /api/config + POST /api/stock/batch (2회)
 *   검색·클릭   → POST /api/stock (1회)
 *   일봉/주봉   → POST /api/stock (미리보기 1회) + POST /api/stock/batch (리스트)
 *
 * 쓰기 흐름
 *   탭/설정/종목 변경 → POST /api/config (1회, 항상)
 *   S&P500 동기화    → POST /api/sp500/sync (1회)
 *
 * yfinance 호출
 *   POST /api/stock 에서만 발생 (DB에 없을 때)
 *   POST /api/stock/batch 는 절대 호출 안 함
 */
const API = (() => {

  /* ── 서버 베이스 URL (같은 origin, 상대경로) ── */
  const BASE = '';

  /* ── 시장 판별 헬퍼 ── */
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

  function _guessMarket(code) {
    const c = code.toUpperCase().replace(/\.(KS|KQ)$/i, '');
    return /^\d+$/.test(c) ? 'KS' : 'US';
  }

  /* ══════════════════════════════════════════════
     1. POST /api/stock — 단일 종목 조회
        DB 우선, 없으면 yfinance → DB 저장 → 반환
        검색(B), 행 클릭(F), 일봉/주봉 미리보기(D/E) 공통
  ══════════════════════════════════════════════ */
  async function fetchStock(input, candleCount, interval = '1d', forceMarket = null) {
    const code   = input.trim().toUpperCase().replace(/\.(KS|KQ)$/i, '');
    const market = forceMarket || _guessMarket(code);

    const res = await fetch(`${BASE}/api/stock`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, market, interval, candle_count: candleCount }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(`[${input}] 조회 실패: ${err.detail || res.status}`);
    }

    return _normalize(await res.json());
  }

  /* ══════════════════════════════════════════════
     2. POST /api/stock/batch — 배치 조회 (DB only)
        초기 접속(A), 일봉/주봉 리스트 갱신(D/E)
        yfinance 절대 호출 안 함 — 없는 종목은 null
        onProgress(code, data|null, error|null) 콜백
  ══════════════════════════════════════════════ */
  async function fetchBatch(stocks, candleCount, interval, onProgress) {
    if (!stocks || stocks.length === 0) return [];

    const body = {
      stocks:       stocks.map(s => ({ code: s.code, market: s.market || _guessMarket(s.code) })),
      interval,
      candle_count: candleCount,
    };

    let results;
    try {
      const res = await fetch(`${BASE}/api/stock/batch`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ({ results } = await res.json());
    } catch (e) {
      console.warn('[API] fetchBatch 실패:', e.message);
      stocks.forEach(s => onProgress?.(s.code, null, e));
      return stocks.map(() => null);
    }

    return results.map((r, i) => {
      const s = stocks[i];
      if (r.data) {
        const normalized = _normalize(r.data);
        onProgress?.(s.code, normalized, null);
        return normalized;
      } else {
        const err = new Error(r.error || '데이터 없음');
        onProgress?.(s.code, null, err);
        return null;
      }
    });
  }

  /* ══════════════════════════════════════════════
     3. GET /api/config — 탭 + 설정 일괄 읽기
  ══════════════════════════════════════════════ */
  async function fetchConfig() {
    const res = await fetch(`${BASE}/api/config`);
    if (!res.ok) throw new Error(`/api/config GET 실패: ${res.status}`);
    return res.json();   // { tabs: [...], settings: {...} }
  }

  /* ══════════════════════════════════════════════
     4. POST /api/config — 탭/설정 upsert
        tabs: 전체 배열 교체 (null이면 변경 안 함)
        settings: 키별 upsert (null이면 변경 안 함)
  ══════════════════════════════════════════════ */
  async function saveConfig(tabs, settings) {
    const body = {};
    if (tabs     !== undefined) body.tabs     = tabs;
    if (settings !== undefined) body.settings = settings;

    const res = await fetch(`${BASE}/api/config`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`/api/config POST 실패: ${res.status}`);
    return res.json();
  }

  /* ══════════════════════════════════════════════
     하위 호환 — app.js 에서 아직 사용 중인 함수들
  ══════════════════════════════════════════════ */

  /**
   * fetchMultipleFast — fetchBatch 래퍼 (하위 호환)
   * concurrency 파라미터는 서버 측 병렬 처리로 이관했으므로 무시.
   * dbOnly 파라미터도 제거 (batch는 항상 DB only).
   */
  async function fetchMultipleFast(stocks, candleCount, interval, onProgress) {
    return fetchBatch(stocks, candleCount, interval, onProgress);
  }

  /**
   * fetchRefresh — 새로고침 버튼(G)용
   * POST /api/stock/refresh : 현재 탭 종목, yfinance 포함, 서버 순차 실행
   * onProgress(code, data|null, error|null) 콜백
   */
  async function fetchRefresh(stocks, candleCount, interval, onProgress) {
    if (!stocks || stocks.length === 0) return [];

    const results = [];
    for (let i = 0; i < stocks.length; i++) {
      const s = stocks[i];
      const body = {
        stocks:       [{ code: s.code, market: s.market || _guessMarket(s.code) }],
        interval,
        candle_count: candleCount,
      };

      try {
        const res = await fetch(`${BASE}/api/stock/refresh`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const { results: batchResults } = await res.json();
        const r = batchResults[0]; // Since we sent only 1 stock
        
        if (r && r.data) {
          const normalized = _normalize(r.data);
          onProgress?.(s.code, normalized, null);
          results.push(normalized);
        } else {
          const err = new Error(r?.error || '데이터 없음');
          onProgress?.(s.code, null, err);
          results.push(null);
        }
      } catch (e) {
        console.warn(`[API] fetchRefresh 실패 (${s.code}):`, e.message);
        onProgress?.(s.code, null, e);
        results.push(null);
      }
    }
    return results;
  }

  /**
   * fetchMultiple — fetchRefresh 래퍼 (하위 호환)
   */
  async function fetchMultiple(stocks, candleCount, interval, onProgress) {
    return fetchRefresh(stocks, candleCount, interval, onProgress);
  }

  /* ── 펀더멘털 (하위 호환 shim — fetchStock 응답에 포함됨) ── */
  const _EMPTY_FUND = Object.freeze({
    trailingPE: null, forwardPE: null, pbr: null,
    evToEbitda: null, dividendYield: null,
    eps: null, beta: null, sector: null, _fetchFailed: true,
  });

  async function fetchFundamentals(ticker) {
    const map = await fetchFundamentalsBatch([ticker]);
    return map.get(ticker.toUpperCase()) ?? { ..._EMPTY_FUND };
  }

  async function fetchFundamentalsBatch(tickers) {
    // 펀더멘털은 /api/stock 응답에 이미 포함 — 별도 배치 엔드포인트 없음
    // 빈 Map 반환 (app.js의 _fetchAllFundamentals가 이 결과를 무시하도록 처리됨)
    const result = new Map();
    for (const t of tickers) result.set(t.toUpperCase(), { ..._EMPTY_FUND });
    return result;
  }

  /* ── 응답 정규화 ── */
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

  /* ── 유틸 ── */
  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  return {
    fetchStock,
    fetchBatch,
    fetchRefresh,
    fetchConfig,
    saveConfig,
    // 하위 호환
    fetchMultiple,
    fetchMultipleFast,
    resolveMarkets,
    fetchFundamentals,
    fetchFundamentalsBatch,
  };
})();
