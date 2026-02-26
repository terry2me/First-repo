/**
 * api.js — Yahoo Finance 통합 조회 (KRX + US)
 *
 * 프록시 전략:
 *  1. allorigins /get?url=  : 서버사이드 호출 → 모바일 UA 문제 없음, 항상 안전
 *  2. corsproxy.io          : 빠른 환경(PC/태블릿)에서 빠름, 헤더 없이 사용(preflight 방지)
 *  3. codetabs              : 추가 fallback 서버사이드 프록시
 *
 * 느린 폰 대응:
 *  - 배치 처리로 동시 요청 수를 줄여 네트워크 포화 방지
 *  - 캐시 TTL 동안 재요청 없음
 *  - Promise.any로 먼저 성공한 응답 채택
 *
 * 등락 계산 원칙:
 *  - 금일 등락  : allCandles.at(-2).close (전일 종가) → currentPrice (현재가)
 *  - 기간 등락  : periodCandles[0].close  (기간 첫날 종가) → currentPrice (현재가)
 *    ※ at(-1) 캔들은 오늘 아직 진행 중인 캔들이므로 전일 종가는 at(-2)
 *    ※ 기간 첫날의 시가(open)가 아닌 종가(close)를 기준으로 "N일 전 종가 대비" 등락을 계산
 */
const API = (() => {

  const PROXY_ALLORIGINS = 'https://api.allorigins.win/get?url=';
  const PROXY_CORSPROXY  = 'https://corsproxy.io/?';
  const PROXY_CODETABS   = 'https://api.codetabs.com/v1/proxy?quest=';

  const YF_HOSTS = [
    'https://query1.finance.yahoo.com',
    'https://query2.finance.yahoo.com',
  ];
  const YF_PATH = '/v8/finance/chart/';

  /* ── 시장 후보 판별 ── */
  function resolveMarkets(input) {
    const v = input.trim().toUpperCase();
    if (/^\d{1,6}$/.test(v)) {
      const p = v.padStart(6, '0');
      return [{ ticker:`${p}.KS`, market:'KS' }];  // KQ 없이 KS 단일 후보
    }
    if (v.endsWith('.KS')) return [{ ticker:v, market:'KS' }];
    if (v.endsWith('.KQ')) return [{ ticker:v.replace(/\.KQ$/i, '.KS'), market:'KS' }];  // KQ 입력도 KS로 변환
    return [{ ticker:v, market:'US' }];
  }

  /* ── Unix 기간 범위 ── */
  function getUnixRange(count, interval) {
    const now  = Math.floor(Date.now() / 1000);
    const dpp  = interval === '1wk' ? 7 : 1.5;
    // candleCount보다 여유있게 더 많이 요청 (BB 계산용 + 필터링 여유)
    const days = Math.ceil(count * 3 * dpp) + 30;
    return { period1: now - days * 86400, period2: now + 86400 };
  }

  /* ── ticker 조립 ── */
  function buildTicker(code, market) {
    if (market === 'US') return code.toUpperCase();
    return `${code}.KS`;  // KR 종목은 모두 .KS
  }

  /* ── AbortController 타임아웃 fetch ── */
  function _timedFetch(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => { ctrl.abort(); reject(new Error('timeout')); }, timeoutMs);
      fetch(url, { signal: ctrl.signal })
        .then(r  => { clearTimeout(tid); resolve(r); })
        .catch(e => { clearTimeout(tid); reject(e); });
    });
  }

  /* ── 응답 심볼 검증: 요청 ticker와 응답 meta.symbol 일치 확인 ──
   * Yahoo Finance 프록시가 캐시된 다른 종목 응답을 반환하는 경우 방지
   * ticker: '005930.KS', '000660.KQ', 'AAPL' 등
   * meta.symbol: 응답 내 실제 심볼 (e.g. '005930.KS', 'AAPL')
   */
  function _validateSymbol(j, ticker) {
    const result = j?.chart?.result?.[0];
    if (!result) throw new Error('no_data');
    // KQ/KS 구분 없이 순수 코드 비교 (Yahoo가 .KQ로 응답해도 허용)
    const normalize = s => s.toUpperCase().replace(/\.(KS|KQ)$/i, '');
    const respSymbol = normalize(result.meta?.symbol || '');
    const reqSymbol  = normalize(ticker);
    if (respSymbol && respSymbol !== reqSymbol) {
      throw new Error(`symbol_mismatch:${respSymbol}≠${reqSymbol}`);
    }
    return j;
  }

  /* ── allorigins /get 방식 ── */
  function _fetchAllorigins(yUrl, ticker, timeoutMs) {
    const pUrl = PROXY_ALLORIGINS + encodeURIComponent(yUrl);
    return _timedFetch(pUrl, timeoutMs)
      .then(async res => {
        if (!res.ok) throw new Error(`allorigins HTTP ${res.status}`);
        const wrapper = await res.json();
        if (!wrapper?.contents) throw new Error('allorigins empty');
        let j;
        try { j = JSON.parse(wrapper.contents); } catch { throw new Error('allorigins parse'); }
        return _validateSymbol(j, ticker);
      });
  }

  /* ── corsproxy.io 방식 — 커스텀 헤더 없이 사용해야 preflight 없음 ── */
  function _fetchCorsproxy(yUrl, ticker, timeoutMs) {
    const pUrl = PROXY_CORSPROXY + encodeURIComponent(yUrl);
    return _timedFetch(pUrl, timeoutMs)
      .then(async res => {
        if (!res.ok) throw new Error(`corsproxy HTTP ${res.status}`);
        const j = await res.json();
        return _validateSymbol(j, ticker);
      });
  }

  /* ── codetabs 서버사이드 프록시 ── */
  function _fetchCodetabs(yUrl, ticker, timeoutMs) {
    const pUrl = PROXY_CODETABS + encodeURIComponent(yUrl);
    return _timedFetch(pUrl, timeoutMs)
      .then(async res => {
        if (!res.ok) throw new Error(`codetabs HTTP ${res.status}`);
        const j = await res.json();
        return _validateSymbol(j, ticker);
      });
  }

  /* ── 핵심: ticker × Yahoo 호스트 × 프록시 동시 경주 (캐시 없음) ──
   *  2개 Yahoo 호스트 × 3개 프록시 = 6개 태스크를 Promise.any로 경쟁
   *  _validateSymbol 실패 응답은 자동 제외, 검증 통과한 첫 번째 응답 채택
   */
  async function _raceAll(candidates, interval, candleCount) {
    const { period1, period2 } = getUnixRange(candleCount, interval);

    for (const { ticker, market } of candidates) {
      const tasks = [];
      for (const host of YF_HOSTS) {
        const yUrl = `${host}${YF_PATH}${encodeURIComponent(ticker)}` +
                     `?interval=${interval}&period1=${period1}&period2=${period2}&events=history`;

        tasks.push(
          _fetchAllorigins(yUrl, ticker, 12_000)
            .then(json => ({ json, ticker, market }))
        );
        tasks.push(
          _fetchCorsproxy(yUrl, ticker, 6_000)
            .then(json => ({ json, ticker, market }))
        );
        tasks.push(
          _fetchCodetabs(yUrl, ticker, 10_000)
            .then(json => ({ json, ticker, market }))
        );
      }

      try {
        return await Promise.any(tasks);
      } catch {
        continue;
      }
    }

    throw new Error('모든 시장 후보 조회 실패');
  }

  /* ── 응답 파싱 ── */
  function _parse(result, inputCode, market, candleCount, interval) {
    const meta = result.meta || {};
    const ts   = result.timestamp || [];
    const q    = result.indicators?.quote?.[0] || {};

    // 유효한 캔들만 추출 (open·close 모두 있어야 함)
    const allCandles = ts.map((t, i) => ({
      date:   _fmtDate(t),
      open:   q.open?.[i]   ?? null,
      high:   q.high?.[i]   ?? null,
      low:    q.low?.[i]    ?? null,
      close:  q.close?.[i]  ?? null,
      volume: q.volume?.[i] ?? 0,
    })).filter(c => c.open != null && c.close != null);

    const allCloses = allCandles.map(c => c.close);

    // 현재가: Yahoo meta의 실시간 가격 우선, 없으면 마지막 캔들 종가
    const metaPrice   = meta.regularMarketPrice ?? null;
    const lastClose   = allCloses.at(-1) ?? null;
    const cur         = metaPrice ?? lastClose ?? 0;
    const isUS = market === 'US';
    const code = isUS
      ? (meta.symbol || inputCode).toUpperCase().replace(/\.(KS|KQ)$/i, '')
      : inputCode.replace(/\.(KS|KQ)$/i, '').padStart(6, '0');

    // ── 데이터 오염 검증 ───────────────────────────────────────────
    // Yahoo Finance 프록시가 meta(현재가)와 OHLCV(캔들)가 서로 다른 종목인 경우 감지
    //
    // 판단 기준:
    //  meta.regularMarketPrice(실시간)와 allCloses.at(-1)(마지막 캔들) 비율이 2.5배 초과
    //  → meta는 000660 현재가(~210,000), candles는 다른종목(~730,000) → ratio ≈ 3.5배 → 감지
    //  ※ 주가 급등/분할 등으로 장기 캔들과 현재가 차이가 클 수 있으므로 median 비교는 하지 않음
    //    (SNDK 같이 인수합병 후 가격이 급변하는 종목 오탐 방지)
    if (metaPrice != null && lastClose != null && metaPrice > 0 && lastClose > 0) {
      const ratio1 = Math.max(metaPrice, lastClose) / Math.min(metaPrice, lastClose);
      if (ratio1 > 2.5) {
        throw new Error(`data_mismatch: metaPrice=${metaPrice}, lastClose=${lastClose.toFixed(0)} (${inputCode})`);
      }
    }

    // ── 금일 등락 계산 ─────────────────────────────────────────────
    //
    // allCandles.at(-1) = 오늘 진행 중인 캔들 (close ≒ 현재가)
    // allCandles.at(-2) = 어제(전일) 완성된 캔들 → close = 전일 종가
    //
    // 전일 종가 = allCandles.at(-2).close
    // 금일 등락(절대) = 현재가 - 전일 종가
    // 금일 등락(%)    = (현재가 - 전일 종가) / 전일 종가 × 100
    //
    // fallback: 캔들이 1개뿐이면 meta 필드 사용
    const prevDayCandle = allCandles.length >= 2 ? allCandles.at(-2) : null;
    const prevClose = prevDayCandle?.close
                   ?? meta.regularMarketPreviousClose
                   ?? meta.chartPreviousClose
                   ?? meta.previousClose
                   ?? 0;

    const todayChg    = prevClose ? (cur - prevClose) : 0;
    const todayChgPct = prevClose ? (todayChg / prevClose * 100) : 0;

    // ── 기간 등락 계산 ─────────────────────────────────────────────
    //
    // 선택 기간(candleCount)에 해당하는 캔들을 잘라냄
    // periodCandles[0].close = 기간 첫날의 종가 (= N일/N주 전 종가)
    // 기간 등락(절대) = 현재가 - 기간 첫날 종가
    // 기간 등락(%)    = (현재가 - 기간 첫날 종가) / 기간 첫날 종가 × 100
    //
    // ※ open이 아닌 close 사용: "N일 전 종가 대비 현재 등락"이 직관적으로 정확
    const periodCandles = allCandles.length > candleCount
      ? allCandles.slice(-candleCount)
      : allCandles;

    const periodBase   = periodCandles[0]?.close ?? cur;
    const periodChg    = periodBase ? (cur - periodBase) : 0;
    const periodChgPct = periodBase ? (periodChg / periodBase * 100) : 0;

    // name 정제: Yahoo Finance가 "086520.KS,0P0000AYIC,1314577" 처럼
    // 복수 심볼을 longName에 넣는 경우가 있으므로 콤마 앞 첫 번째 값만 사용
    const rawName = meta.longName || meta.shortName || meta.symbol || code;
    const cleanName = rawName.includes(',') ? rawName.split(',')[0].trim() : rawName;

    return {
      code, market,
      ticker:         buildTicker(code, market),
      name:           cleanName,
      currency:       meta.currency || (isUS ? 'USD' : 'KRW'),
      isUS, interval, candleCount,
      currentPrice:   cur,
      prevClose,
      // 금일 등락 (전일 종가 → 현재가)
      todayChange:    parseFloat(todayChg.toFixed(isUS ? 2 : 0)),
      todayChangePct: parseFloat(todayChgPct.toFixed(2)),
      // 기간 등락 (기간 첫날 종가 → 현재가)
      change:         parseFloat(periodChg.toFixed(isUS ? 2 : 0)),
      changePct:      parseFloat(periodChgPct.toFixed(2)),
      candles:        periodCandles,
      allCandles,
      closes:         allCloses,
    };
  }

  function _fmtDate(ts) {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  /* ── 공개: 단일 종목 조회 ── */
  async function fetchStock(input, candleCount, interval = '1d', forceMarket = null) {
    const trimmed = input.trim().toUpperCase().replace(/\.(KS|KQ)$/i, '');
    let candidates;
    if (forceMarket) {
      const code = /^\d{1,6}$/.test(trimmed) ? trimmed.padStart(6, '0') : trimmed;
      candidates = [{ ticker: buildTicker(code, forceMarket), market: forceMarket }];
    } else {
      candidates = resolveMarkets(trimmed);
    }

    const MAX_RETRY = 2;
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        const { json, market } = await _raceAll(candidates, interval, candleCount);
        return _parse(json.chart.result[0], trimmed, market, candleCount, interval);
      } catch (e) {
        const msg = e instanceof AggregateError
          ? e.errors.map(x => x.message).slice(0, 4).join(' / ')
          : e.message;

        // 데이터 오염 감지 (metaPrice vs lastClose 불일치 / 심볼 불일치) → 재시도
        const isDataError = msg.includes('data_mismatch') || msg.includes('symbol_mismatch');
        if (isDataError && attempt < MAX_RETRY) {
          console.warn(`[${input}] 데이터 오염 감지(${msg.slice(0,80)}), 재시도 ${attempt + 1}/${MAX_RETRY}`);
          continue;
        }

        throw new Error(`[${input}] 조회 실패: ${msg}`);
      }
    }
  }

  /* ── 공개: 여러 종목 조회 (배치 처리로 느린 폰 대응) ── */
  async function fetchMultiple(stocks, candleCount, interval, onProgress) {
    const BATCH = 3;
    const results = [];
    for (let i = 0; i < stocks.length; i += BATCH) {
      const batch = stocks.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async s => {
        try {
          const r = await fetchStock(s.code, candleCount, interval, s.market || null);
          onProgress?.(s.code, r, null);
          return r;
        } catch (e) {
          onProgress?.(s.code, null, e);
          return null;
        }
      }));
      results.push(...batchResults);
    }
    return results;
  }

  /* ═══════════════════════════════════════════════════════════════
     펀더멘털 — Google Sheets Finance API (US + KR 모두 지원)
     - CORS 허용 ✅ (Apps Script 웹앱 — 익명 허용)
     - 제한 없음 (Google 계정 할당량 이내)
     - 캐시 정책: 영구 보존 (세션 내 만료 없음)
     - 제공 필드: pe → trailingPE, eps, beta
     - US 종목: 'AAPL' 형태 그대로 호출
     - KR 종목: '005930.KS' → '005930' 순수 숫자로 변환 후 호출
                beta = null (Google Finance 미제공)
     - 응답 형태: { ok, input, processed, data: { name, price, pe, eps, beta, yield } }
     ═══════════════════════════════════════════════════════════════ */

  const _EMPTY_FUND = Object.freeze({ trailingPE: null, eps: null, beta: null });

  /* ── KR 접미사 제거 → Apps Script 파라미터용 ── */
  function _toApiParam(ticker) {
    return ticker.replace(/\.(KS|KQ)$/i, '');
  }

  /* ── Google Sheets 응답 → 표준 펀더멘털 객체 변환 ── */
  function _normGSheet(d) {
    const n = v => {
      if (v == null || v === '' || v === 'N/A') return null;
      const f = parseFloat(v);
      return isFinite(f) ? f : null;
    };
    return { trailingPE: n(d.pe), eps: n(d.eps), beta: n(d.beta) };
  }

  /* ── 배치 호출: tickers 배열 → { ticker → {data|error} } Map 반환 ──
   *
   * Apps Script 배포 URL에 ?tickers=A,B,C,... 로 최대 BATCH_SIZE개 전송.
   * Apps Script 내부에서 GOOGLEFINANCE 수식을 2D 배치로 계산 후 반환.
   * flush/sleep(3s)가 1회만 실행되므로 단일 순차 대비 획기적으로 빠름.
   *
   * timeoutMs : Apps Script 실행시간(flush 3s 포함) 감안해 15s 이상 권장
   */
  async function _fetchGSheetFundBatch(tickers, timeoutMs = 20_000) {
    const apiUrl = (typeof CONFIG !== 'undefined' && CONFIG.GSHEET_FUND_API)
                   ? CONFIG.GSHEET_FUND_API : '';
    if (!apiUrl) throw new Error('GSHEET_FUND_API 미설정');

    // Apps Script CDN 캐시 무효화용 타임스탬프
    const params = tickers.map(_toApiParam).join(',');
    const url = `${apiUrl}?tickers=${encodeURIComponent(params)}&_t=${Date.now()}`;

    const res = await _timedFetch(url, timeoutMs);
    if (!res.ok) throw new Error(`GSheet API HTTP ${res.status}`);
    const j = await res.json();
    if (!j.ok) throw new Error(`GSheet API 오류: ${j.error || '알 수 없음'}`);

    // 배치 응답: { ok, results: [{input, processed, data|error}, ...] }
    // 단일 응답(하위 호환): { ok, input, processed, data }
    const resultMap = new Map(); // key: 원본 ticker (대문자) → value: { data } | { error }

    if (Array.isArray(j.results)) {
      j.results.forEach((r, i) => {
        const origTicker = tickers[i].toUpperCase();
        resultMap.set(origTicker, r.error ? { error: r.error } : { data: r.data });
      });
    } else if (j.data) {
      // 단일 응답 fallback
      resultMap.set(tickers[0].toUpperCase(), { data: j.data });
    }

    return resultMap;
  }

  /* ── 공개: 배치 펀더멘털 조회 ──────────────────────────────────────
   *
   * tickers: string[]  예) ['AAPL', 'MSFT', '005930.KS']
   * 반환:    Map<ticker, { trailingPE, eps, beta, _fetchFailed }>
   *
   * 내부적으로 BATCH_SIZE(10)개씩 나눠 순차 호출.
   * 각 배치는 Apps Script 1회 호출로 처리됨.
   */
  const FUND_BATCH_SIZE = 10;

  async function fetchFundamentalsBatch(tickers) {
    const result = new Map();
    const chunks = [];
    for (let i = 0; i < tickers.length; i += FUND_BATCH_SIZE) {
      chunks.push(tickers.slice(i, i + FUND_BATCH_SIZE));
    }

    for (const chunk of chunks) {
      try {
        const batchMap = await _fetchGSheetFundBatch(chunk, 25_000);
        for (const ticker of chunk) {
          const key  = ticker.toUpperCase();
          const item = batchMap.get(key);
          if (!item || item.error || !item.data) {
            result.set(key, { ..._EMPTY_FUND, _fetchFailed: true });
          } else {
            const fd = _normGSheet(item.data);
            const hasValue = Object.values(fd).some(v => v != null);
            result.set(key, hasValue
              ? { ...fd, _fetchFailed: false }
              : { ..._EMPTY_FUND, _fetchFailed: true }
            );
          }
        }
      } catch (e) {
        // 청크 전체 실패 시 해당 종목 모두 실패 처리
        console.warn(`[펀더멘털 배치] 청크 실패 (${chunk.join(',').slice(0,40)}...):`, e.message);
        for (const ticker of chunk) {
          result.set(ticker.toUpperCase(), { ..._EMPTY_FUND, _fetchFailed: true });
        }
      }
    }
    return result;
  }

  /* ── 공개: 단일 펀더멘털 조회 (하위 호환 — fetchFundamentalsBatch 래퍼) ── */
  async function fetchFundamentals(ticker) {
    const map = await fetchFundamentalsBatch([ticker]);
    return map.get(ticker.toUpperCase()) ?? { ..._EMPTY_FUND, _fetchFailed: true };
  }

  return { fetchStock, fetchMultiple, resolveMarkets, fetchFundamentals, fetchFundamentalsBatch };
})();
