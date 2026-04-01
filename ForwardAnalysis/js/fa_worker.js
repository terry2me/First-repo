/**
 * sim_worker.js - 지표 시뮬레이션 벡터 연산을 위한 백그라운드 워커
 */

// 🚀 워커 내부 메모리 재사용 (Out of Memory 방지)
let multi, sumPnl, sigs;
function _allocateEngineBuffers(n) {
  if (!multi || multi.length !== n) {
    multi = new Float32Array(n);
    sumPnl = new Float32Array(n);
    sigs = new Uint32Array(n);
  }
}

self.onmessage = function(e) {
  const { codes, watchData, packed, simParams } = e.data;
  const bests = {};

  for (const code of codes) {
    const data = watchData[code];
    if (data && data.candlesWithBB && data.candlesWithBB.length > 0) {
      const best = _runVectorizedSimulation(data, packed, simParams);
      if (best) {
        bests[code] = best;
      } else {
        bests[code] = { pnl: -Infinity, idx: -1 };
      }
    } else {
      bests[code] = { pnl: -Infinity, idx: -1 };
    }
  }

  self.postMessage({ bests });
};

/** 🚀 벡터 엔진 (Worker 버전: SimState 대신 simParams 사용) */
function _runVectorizedSimulation(data, packed, simParams) {
  if (!data || !data.candlesWithBB) return null;
  const candles = data.candlesWithBB;
  const T = candles.length;
  const n = packed.count;
  const startDate = new Date(candles[T-1]?.date ?? new Date());
  startDate.setMonth(startDate.getMonth() - simParams.simPeriodMonths);

  let startIdx = 0;
  for (let i = 0; i < T; i++) {
    if (new Date(candles[i]?.date ?? 0) >= startDate) { startIdx = i; break; }
  }

  // 🚀 가격 데이터 전처리 (객체 속성을 미리 Float32Array 로 변환하여 루프 내부 캐시히트 100% 극대화)
  const closeP = new Float32Array(T), midP = new Float32Array(T), upP = new Float32Array(T);
  const bPriceArr = new Float32Array(T), sPriceArr = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const c = candles[t];
    const cp = c?.close ?? 0;
    closeP[t] = cp;
    midP[t] = c?.bbMiddle ?? 0;
    upP[t] = c?.bbUpper ?? 0;
    bPriceArr[t] = c?.[simParams.bbBuyPriceType] ?? cp;
    sPriceArr[t] = c?.[simParams.bbSellPriceType] ?? cp;
  }

  // 지표 배열
  const bbLD = new Uint8Array(T), bbLU = new Uint8Array(T), bbMD = new Uint8Array(T), bbMU = new Uint8Array(T);
  const rB = new Uint8Array(T), sB = new Uint8Array(T), eB = new Uint8Array(T), maB = new Uint8Array(T), mfB = new Uint8Array(T);
  const rS = new Uint8Array(T), sS = new Uint8Array(T), eS = new Uint8Array(T), maS = new Uint8Array(T), mfS = new Uint8Array(T);

  for (let t = 1; t < T; t++) {
    const c = candles[t], p = candles[t-1];
    const buyP = c?.[simParams.bbBuyPriceType] ?? c?.close ?? 0;
    const pBuyP = p?.[simParams.bbBuyPriceType] ?? p?.close ?? 0;
    if (p?.bbLower != null && c?.bbLower != null) {
      if (pBuyP > p.bbLower && buyP <= c.bbLower) bbLD[t] = 1;
      if (pBuyP < p.bbLower && buyP >= c.bbLower) bbLU[t] = 1;
    }
    if (p?.bbMiddle != null && c?.bbMiddle != null) {
      if (pBuyP > p.bbMiddle && buyP <= c.bbMiddle) bbMD[t] = 1;
      if (pBuyP < p.bbMiddle && buyP >= c.bbMiddle) bbMU[t] = 1;
    }
    if (c?.rsiSignal === 'BUY') rB[t] = 1; if (c?.rsiSignal === 'SELL') rS[t] = 1;
    if (c?.stochSignal === 'BUY') sB[t] = 1; if (c?.stochSignal === 'SELL') sS[t] = 1;
    if (c?.eomCross === 'BUY') eB[t] = 1; if (c?.eomCross === 'SELL') eS[t] = 1;
    if (c?.macdCross === 'BUY') maB[t] = 1; if (c?.macdCross === 'SELL') maS[t] = 1;
    if (c?.mfiSignal === 'BUY') mfB[t] = 1; if (c?.mfiSignal === 'SELL') mfS[t] = 1;
  }

  // 🚀 비트 오프셋 정의 (sim_app.js와 동일)
  const B = {
    LD: 1<<0, LU: 1<<1, MD: 1<<2, MU: 1<<3,
    RSI: 1<<4, ST: 1<<5, EOM: 1<<6, MACD: 1<<7, MFI: 1<<8,
    RSIS: 1<<9, STS: 1<<10, EOMS: 1<<11, MACDS: 1<<12, MFIS: 1<<13
  };

  const sigMask = [null, new Uint32Array(T), new Uint32Array(T), new Uint32Array(T)];
  for (let sw = 1; sw <= 3; sw++) {
    for (let t = 0; t < T; t++) {
      let m = 0;
      for (let k = 0; k < sw; k++) {
        const idx = t - k; if (idx < 0) break;
        if (bbLD[idx]) m |= B.LD; if (bbLU[idx]) m |= B.LU;
        if (bbMD[idx]) m |= B.MD; if (bbMU[idx]) m |= B.MU;
        if (rB[idx]) m |= B.RSI; if (sB[idx]) m |= B.ST;
        if (eB[idx]) m |= B.EOM; if (maB[idx]) m |= B.MACD;
        if (mfB[idx]) m |= B.MFI;
      }
      // 탈출 비트는 윈도우 무관 (당일 발생 여부만 중요)
      if (rS[t]) m |= B.RSIS; if (sS[t]) m |= B.STS;
      if (eS[t]) m |= B.EOMS; if (maS[t]) m |= B.MACDS;
      if (mfS[t]) m |= B.MFIS;
      sigMask[sw][t] = m;
    }
  }

  // 🚀 OOM 방지: 워커 메모리 재사용 (최종 결과 저장용만)
  _allocateEngineBuffers(n);
  multi.fill(1.0);
  sumPnl.fill(0);
  sigs.fill(0);

  let maxP = -Infinity, maxI = -1;

  // 🚀 이중 루프 순서 역전 (콤보 c 바깥쪽, 시간 t 안쪽)
  // 1. 메모리 Fetch 최소화: packed 배열 조회를 조합당 1회로 압축 (n * T 회 -> n회)
  // 2. 캐시 최적화: holding, bIdx 등 상태 변수들을 CPU Register(로컬 변수)로 사용
  // 3. 분기 예측 극대화: bbS 같은 조건이 루프 도는 내내 불변이므로 Branch Prediction 성공률 100%
  for (let c = 0; c < n; c++) {
    const swC = packed.sw[c];
    const btC = packed.bt[c], stC = packed.st[c];
    const bbS = packed.bbS[c], bbM = packed.bbM[c], sBBC = packed.sBB[c];
    const reqM = packed.reqM[c], optM = packed.optM[c], optA = packed.optA[c], sellMC = packed.sellM[c];
    const sigArray = sigMask[swC];

    let holding = 0, bIdx = -1, mLevelC = 0, multiC = 1.0, sumPnlC = 0, sigsC = 0, bPrice = 0;

    for (let t = startIdx; t < T; t++) {
      const s = sigArray[t];
      
      if (holding === 0) {
        // 🚀 가장 빠른 예외 처리 1순위: 필수조건이 하나라도 어긋나면 계산 없이 통과 (95% 이상의 불필요한 연산 스킵)
        if ((s & reqM) !== reqM) continue;

        const bbOk = (s & bbM) > 0;
        
        let entry = false;
        if (bbS === 1) { // BB 필수
          if (bbOk) {
            if (optA) { if (s & optM) entry = true; }
            else entry = true;
          }
        } else if (bbS === 2) { // BB 선택
          if (bbOk || (s & optM)) entry = true;
        } else { // BB Off
          if (optA) { if (s & optM) entry = true; }
          else entry = true;
        }

        if (entry) {
          const buyT = (btC === 0 ? t : t + 1);
          if (buyT < T) {
            const bp = bPriceArr[buyT];
            if (bp > 0) {
              holding = 1; bIdx = buyT; mLevelC = 0; bPrice = bp;
              t = buyT; // 🚀 매수한 날짜로 점프 (루프 끝에서 ++ 되므로 다음날부터 체크)
            }
          }
        }
      } else {
        if (t <= bIdx) continue;
        let exit = false;
        
        const midB = midP[t], upB = upP[t];

        if (sBBC && midB !== 0) {
          const cPrice = closeP[t];
          if (mLevelC < 1 && cPrice > midB) mLevelC = 1;
          if (mLevelC < 2 && upB !== 0 && cPrice > upB) mLevelC = 2;
          const maji = (mLevelC === 2 ? upB : (mLevelC === 1 ? midB : 0));
          if (maji !== 0 && sPriceArr[t] < maji) exit = true;
        }
        // 지표 매도 체크 (Bitwise OR)
        if (!exit && (s & sellMC)) exit = true;

        if (exit || t === T - 1) {
          const eIdx = (stC === 0 || t === T - 1 ? t : t + 1);
          const finalE = Math.min(T - 1, Math.max(bIdx + 1, eIdx));
          const eP = sPriceArr[finalE];
          const pnl = (eP - bPrice) / bPrice;
          multiC *= (1 + pnl); sumPnlC += pnl; sigsC++; 
          holding = 0;
          t = finalE; // 🚀 매도한 날짜로 점프
        }
      }
    }

    // 결과 저장 및 최적화 점수 동시 계산 (O(N) 루프 1회 절약)
    multi[c] = multiC; sumPnl[c] = sumPnlC; sigs[c] = sigsC;
    const finalPnl = (simParams.pnlType === 'simple' ? sumPnlC : (multiC - 1)) * 100;
    if (sigsC > 0 && !isNaN(finalPnl) && isFinite(finalPnl) && finalPnl > maxP) {
      maxP = finalPnl; maxI = c;
    }
  }

  return { idx: maxI, pnl: maxP };
}
