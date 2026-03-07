/**
 * indicators.js
 * 볼린저 밴드(Bollinger Bands) 계산 모듈
 * - 기간: 20일 이동평균 (MA20) 기준
 * - 밴드: ±2 표준편차
 */

const Indicators = (() => {

  /**
   * 산술 평균
   */
  function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  /**
   * 표준편차 (모표준편차)
   */
  function stdDev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }

  /**
   * 볼린저 밴드 계산
   * @param {number[]} closes   - 종가 배열
   * @param {number}   period   - 이동평균 기간 (기본 20)
   * @param {number}   mult     - 표준편차 배수 (기본 2)
   * @returns {Array}  [{date, upper, middle, lower}] (length = closes.length)
   *                   period 미달 구간은 null 값으로 채움
   */
  function bollingerBands(closes, period = 20, mult = 2) {
    return closes.map((_, i) => {
      if (i < period - 1) {
        return { upper: null, middle: null, lower: null };
      }
      const slice = closes.slice(i - period + 1, i + 1);
      const ma    = mean(slice);
      const sd    = stdDev(slice);
      return {
        upper:  parseFloat((ma + mult * sd).toFixed(2)),
        middle: parseFloat(ma.toFixed(2)),
        lower:  parseFloat((ma - mult * sd).toFixed(2)),
      };
    });
  }

  /**
   * 최신(마지막) 볼린저 밴드 값 반환
   * @returns {{ upper, middle, lower } | null}
   */
  function latestBB(closes, period = 20, mult = 2) {
    if (closes.length < period) {
      // 데이터 부족 시 가용 데이터로 계산
      if (closes.length < 2) return null;
      const ma = mean(closes);
      const sd = stdDev(closes);
      return {
        upper:  parseFloat((ma + mult * sd).toFixed(2)),
        middle: parseFloat(ma.toFixed(2)),
        lower:  parseFloat((ma - mult * sd).toFixed(2)),
      };
    }
    const bands = bollingerBands(closes, period, mult);
    return bands[bands.length - 1];
  }

  /**
   * BB 위치 비율 계산
   * ratio = (현재가 - 하단) / (상단 - 하단)
   * 0.0 = 하단, 0.5 = 중단, 1.0 = 상단
   * @returns {number} 0.0 ~ 1.0 (클램프 적용)
   */
  function bbRatio(currentPrice, upper, lower) {
    const range = upper - lower;
    if (range <= 0) return 0.5;
    const ratio = (currentPrice - lower) / range;
    return Math.max(0, Math.min(1, parseFloat(ratio.toFixed(4))));
  }

  /**
   * 경고 레벨 판정
   * @returns {{ level: 0|1|2, label: string, stars: string }}
   *   level 0 = 정상 (중단 위)
   *   level 1 = ★  (중단 아래 ~ 하단 30% 이상)
   *   level 2 = ★★ (하단 30% 미만, 매우 근접)
   */
  function alertLevel(currentPrice, upper, middle, lower) {
    const ratio = bbRatio(currentPrice, upper, lower);

    if (ratio >= 0.5) {
      return { level: 0, label: '정상', stars: '', ratio };
    }
    // 중단 아래
    // (currentPrice - lower) / (middle - lower) 로 하단 근접도 계산
    const lowerRange = middle - lower;
    const lowerRatio = lowerRange > 0
      ? (currentPrice - lower) / lowerRange
      : 1;

    if (lowerRatio < 0.25) {
      return { level: 2, label: 'BB하단근접', stars: '★★', ratio };
    }
    if (lowerRatio < 0.55) {
      return { level: 1, label: 'BB하단접근', stars: '★', ratio };
    }
    return { level: 0, label: 'BB중단이하', stars: '', ratio };
  }

  /**
   * 종목 데이터에 BB 분석 결과를 통합하여 반환
   * @param {Object} stockData  - api.js fetchStock 반환값
   * @param {number} period
   * @returns {Object} stockData + { bb, bbBands, alert }
   */
  function analyze(stockData, period = 20) {
    // allCandles/closes = BB 계산용 전체 데이터
    // candles          = 화면 표시용 슬라이스 데이터
    const { closes, candles, allCandles, currentPrice, displayDays } = stockData;

    // ── 전체 데이터로 BB 계산 ──
    const allBands  = bollingerBands(closes, period);
    const latest    = latestBB(closes, period);

    // ── 화면용 캔들에 BB 값 매핑 ──
    // allCandles 기준 인덱스를 맞춰 화면 슬라이스에 붙임
    const totalLen  = (allCandles || candles).length;
    const sliceLen  = candles.length;
    const offset    = totalLen - sliceLen;   // 앞에 잘린 개수

    const candlesWithBB = candles.map((c, i) => {
      const bi = offset + i;               // allBands 내 인덱스
      return {
        ...c,
        bbUpper:  allBands[bi]?.upper  ?? null,
        bbMiddle: allBands[bi]?.middle ?? null,
        bbLower:  allBands[bi]?.lower  ?? null,
      };
    });

    const alert = latest
      ? alertLevel(currentPrice, latest.upper, latest.middle, latest.lower)
      : { level: 0, label: '--', stars: '', ratio: 0.5 };

    return {
      ...stockData,
      bb:           latest,           // 최신 BB 값
      bbRatio:      alert.ratio,      // 0.0~1.0
      alert,                          // 경고 레벨
      candlesWithBB,                  // 차트용 데이터 (화면 N일 + BB 값)
    };
  }

  /* ─────────────────────────────────────────────────────────────
     EOM (Ease of Movement)
     공식:
       Distance Moved = ((H + L) / 2) - ((prevH + prevL) / 2)
       Box Ratio      = Volume / (H - L)       [거래량 / 일중 범위]
       EOM(i)         = Distance Moved / Box Ratio
       Signal         = SMA(EOM, signalPeriod)
     매매신호:
       BUY  : EOM이 0 상향 돌파 또는 Signal 상향 돌파
       SELL : EOM이 0 하향 돌파 또는 Signal 하향 돌파
  ──────────────────────────────────────────────────────────── */
  /**
   * EOM 계산
   * @param {Object[]} candles  - [{high, low, volume}, ...]
   * @param {number}   period   - EOM SMA 평활 기간 (기본 14)
   * @param {number}   signal   - Signal SMA 기간 (기본 14)
   * @returns {Array}  [{eom, signal, crossSignal}]  length = candles.length, 앞부분 null
   */
  function eom(candles, period = 14, signal = 14) {
    const n   = candles.length;
    const raw = new Array(n).fill(null);

    // 1) 원시 EOM 계산 (i>=1 부터)
    for (let i = 1; i < n; i++) {
      const c  = candles[i], p = candles[i - 1];
      const hl = c.high - c.low;
      if (hl === 0 || !c.volume) { raw[i] = 0; continue; }
      const dm = ((c.high + c.low) / 2) - ((p.high + p.low) / 2);
      const br = c.volume / hl;
      raw[i]   = br !== 0 ? dm / br : 0;
    }

    // 2) EOM SMA(period)
    const eomArr = new Array(n).fill(null);
    for (let i = period; i < n; i++) {
      const slice = raw.slice(i - period + 1, i + 1);
      if (slice.some(v => v === null)) continue;
      eomArr[i] = mean(slice);
    }

    // 3) Signal SMA(signal) of EOM
    const sigArr = new Array(n).fill(null);
    for (let i = period + signal - 1; i < n; i++) {
      const slice = eomArr.slice(i - signal + 1, i + 1);
      if (slice.some(v => v === null)) continue;
      sigArr[i] = mean(slice);
    }

    // 4) 매매신호 판정
    const result = [];
    for (let i = 0; i < n; i++) {
      const e = eomArr[i], s = sigArr[i];
      let crossSignal = null;
      if (e !== null && s !== null) {
        const ep = eomArr[i - 1], sp = sigArr[i - 1];
        if (ep !== null && sp !== null) {
          // EOM이 Signal을 상향 돌파 → BUY
          if (ep <= sp && e > s) crossSignal = 'BUY';
          // EOM이 Signal을 하향 돌파 → SELL
          else if (ep >= sp && e < s) crossSignal = 'SELL';
          // EOM이 0선 상향 돌파 → BUY (신호 없으면)
          else if (!crossSignal && eomArr[i-1] !== null && eomArr[i-1] < 0 && e >= 0) crossSignal = 'BUY';
          // EOM이 0선 하향 돌파 → SELL
          else if (!crossSignal && eomArr[i-1] !== null && eomArr[i-1] >= 0 && e < 0) crossSignal = 'SELL';
        }
      }
      result.push({ eom: e, signal: s, crossSignal });
    }
    return result;
  }

  /* ─────────────────────────────────────────────────────────────
     RSI (Relative Strength Index)
     공식: RSI = 100 - (100 / (1 + RS))
           RS  = Avg Gain / Avg Loss  (Wilder Smoothing)
  ──────────────────────────────────────────────────────────── */
  /**
   * RSI 계산
   * @param {number[]} closes
   * @param {number}   period  기본 14
   * @returns {number[]}  length = closes.length, 앞부분 null
   */
  function rsi(closes, period = 14) {
    const n   = closes.length;
    const out = new Array(n).fill(null);
    if (n < period + 1) return out;

    let avgGain = 0, avgLoss = 0;

    // 초기 평균 계산 (단순 평균)
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) avgGain += diff;
      else          avgLoss += Math.abs(diff);
    }
    avgGain /= period;
    avgLoss /= period;

    out[period] = avgLoss === 0 ? 100
                : avgGain === 0 ?   0
                : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));

    // Wilder 평활
    for (let i = period + 1; i < n; i++) {
      const diff = closes[i] - closes[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100
             : avgGain === 0 ?   0
             : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
    }
    return out;
  }

  /* ─────────────────────────────────────────────────────────────
     Stochastic (Slow %K / %D)
     원시 %K = (종가 - n일 최저) / (n일 최고 - n일 최저) × 100
     Slow %K = SMA(원시 %K, slowK2)   ← Slow %K 기간2 (=3 평활)
     Slow %D = SMA(Slow %K, slowD)    ← Slow %D 기간 (=3)
  ──────────────────────────────────────────────────────────── */
  /**
   * Stochastic Slow 계산
   * @param {Object[]} candles  [{high, low, close}, ...]
   * @param {number}   k1       Fast %K 기간 (기본 14)
   * @param {number}   k2       Slow %K 평활 기간 (기본 3)
   * @param {number}   d        Slow %D 기간 (기본 3)
   * @returns {Array}  [{fastK, slowK, slowD}]
   */
  function stochastic(candles, k1 = 14, k2 = 3, d = 3) {
    const n     = candles.length;
    const fastK = new Array(n).fill(null);

    // 원시 Fast %K
    for (let i = k1 - 1; i < n; i++) {
      const slice = candles.slice(i - k1 + 1, i + 1);
      const lo    = Math.min(...slice.map(c => c.low));
      const hi    = Math.max(...slice.map(c => c.high));
      const rng   = hi - lo;
      fastK[i]    = rng === 0 ? 50 : parseFloat(((candles[i].close - lo) / rng * 100).toFixed(2));
    }

    // Slow %K = SMA(fastK, k2)
    const slowK = new Array(n).fill(null);
    for (let i = k1 + k2 - 2; i < n; i++) {
      const slice = fastK.slice(i - k2 + 1, i + 1);
      if (slice.some(v => v === null)) continue;
      slowK[i] = parseFloat(mean(slice).toFixed(2));
    }

    // Slow %D = SMA(slowK, d)
    const slowD = new Array(n).fill(null);
    for (let i = k1 + k2 + d - 3; i < n; i++) {
      const slice = slowK.slice(i - d + 1, i + 1);
      if (slice.some(v => v === null)) continue;
      slowD[i] = parseFloat(mean(slice).toFixed(2));
    }

    return fastK.map((_, i) => ({ fastK: fastK[i], slowK: slowK[i], slowD: slowD[i] }));
  }

  /* ─────────────────────────────────────────────────────────────
     RSI + Stochastic 매매신호 통합 판정
     BUY  조건: RSI < 30 + SlowK < 20 + SlowK > SlowD (상향)
     SELL 조건: RSI > 70 + SlowK > 80 + SlowK < SlowD (하향)
  ──────────────────────────────────────────────────────────── */
  /**
   * RSI + Stochastic 결합 분석
   * @param {number[]} closes
   * @param {Object[]} candles
   * @param {Object}   opts  { rsiPeriod, k1, k2, d, ob, os }
   * @returns {Array}  [{rsi, slowK, slowD, signal}]
   */
  function rsiStoch(closes, candles, opts = {}) {
    const {
      rsiPeriod = 14,
      k1 = 14, k2 = 3, d = 3,
      ob = 80, os = 20,
    } = opts;

    const rsiArr   = rsi(closes, rsiPeriod);
    const stochArr = stochastic(candles, k1, k2, d);
    const n        = closes.length;

    return rsiArr.map((r, i) => {
      const st = stochArr[i];
      let signal = null;
      if (r !== null && st.slowK !== null && st.slowD !== null) {
        const prevSt = i > 0 ? stochArr[i - 1] : null;
        const kCrossUp   = prevSt && prevSt.slowK !== null && prevSt.slowK <= prevSt.slowD && st.slowK > st.slowD;
        const kCrossDown = prevSt && prevSt.slowK !== null && prevSt.slowK >= prevSt.slowD && st.slowK < st.slowD;
        if (r < 50 && st.slowK < os + 10 && kCrossUp)   signal = 'BUY';
        if (r > 50 && st.slowK > ob - 10 && kCrossDown) signal = 'SELL';
      }
      return { rsi: r, slowK: st.slowK, slowD: st.slowD, signal };
    });
  }

  /**
   * analyze() 확장 — BB 외에 EOM / RSI+Stochastic도 함께 계산
   */
  function analyzeAll(stockData, bbPeriod = 20) {
    const base = analyze(stockData, bbPeriod);

    const allC   = stockData.allCandles || stockData.candles;
    const allCls = stockData.closes;
    const total  = allC.length;
    const slice  = stockData.candles.length;
    const offset = total - slice;

    // EOM
    const eomAll = eom(allC, 14, 14);
    // RSI + Stochastic
    const rsStAll = rsiStoch(allCls, allC, { rsiPeriod:14, k1:14, k2:3, d:3, ob:80, os:20 });

    // 화면 슬라이스에 붙이기
    const candlesWithIndicators = base.candlesWithBB.map((c, i) => {
      const bi = offset + i;
      return {
        ...c,
        eom:         eomAll[bi]?.eom         ?? null,
        eomSignal:   eomAll[bi]?.signal      ?? null,
        eomCross:    eomAll[bi]?.crossSignal ?? null,
        rsi:         rsStAll[bi]?.rsi        ?? null,
        slowK:       rsStAll[bi]?.slowK      ?? null,
        slowD:       rsStAll[bi]?.slowD      ?? null,
        rsiStSignal: rsStAll[bi]?.signal     ?? null,
      };
    });

    return { ...base, candlesWithBB: candlesWithIndicators };
  }

  return { bollingerBands, latestBB, bbRatio, alertLevel, analyze, analyzeAll, eom, rsi, stochastic, rsiStoch };
})();
