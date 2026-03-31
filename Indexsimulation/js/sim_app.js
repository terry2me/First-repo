/**
 * app.js — 볼린저 밴드 주식 모니터 메인 로직
 * 기능: 일봉/주봉 토글, 탭 관리, 종목 드래그 정렬,
 *       탭 드래그 정렬, 우측 행 클릭 → 좌측 미리보기, Toast 알림
 *
 * 등락 표시 원칙:
 *  - 금일 등락  : 전일 종가(at(-2).close) → 현재가   [todayChange / todayChangePct]
 *  - 기간 등락  : 기간 첫날 종가(.close)  → 현재가   [change / changePct]
 */

/* ══════════════════════════════════════════════
   전역 상태
══════════════════════════════════════════════ */
const SimState = {
  candleCount: 250,    // 시뮬레이션을 위해 더 많은 데이터(1년치) 기본 로드
  previewInterval: '1d',
  listInterval: '1d',
  previewData: null,
  previewCode: null,
  watchData: {},
  fundamentals: {},
  sortCol: null,
  sortDir: 'asc',
  checkedCodes: new Set(),
  bbFilterActive: true,
  bbFilterThreshold: 0,
  eomFilterActive: true,
  eomPeriod: 14,    // EOM SMA 기간 (표준: 14)
  eomSignal: 14,    // EOM Signal SMA 기간 (표준: 14)
  rsiFilterActive: true,
  stochFilterActive: true,
  // RSI 파라미터
  rsiPeriod: 14,
  rsiOB: 70,    // RSI 전용 과매수 (표준: 70)
  rsiOS: 30,    // RSI 전용 과매도 (표준: 30)
  // Stochastic 파라미터
  stochK: 14,
  stochSK: 3,
  stochSD: 3,
  // Stochastic 전용 기준선
  stochOB: 80,  // Stochastic 전용 과매수 (표준: 80)
  stochOS: 20,  // Stochastic 전용 과매도 (표준: 20)
  // 시뮬레이션 파라미터
  simPeriodMonths: 6,
  simHoldingDays: 5,
  simTargetProfit: 5,
  simSignalWindow: 3,   // EOM/RSI 시그널 유효 윈도우 (일)
  simBuyTiming: 'today',
  simSellTiming: 'today',
  bbBase: 'lower',
  bbBuyPriceType: 'close',
  bbSellPriceType: 'close',
  bbCrossDown: true,
  bbCrossUp: false,
  // 매도 상세 제어
  holdDaysActive: false,
  targetProfitActive: false,
  bbTrackingSellActive: true,
  // 🚀 매도(탈출) 전용 상태 추가
  sellRSIActive: true,
  sellSTOCHActive: true,
  sellEOMActive: true,
  sellMACDActive: true,
  sellMFIActive: true,
  simResults: {}, // code -> { success, total, winRate, pnl, trades }
  simStarted: false, // 시뮬레이션 시작 여부
  todayMode: false,  // 🚀 '오늘' 탐색 모드 여부
  pnlType: 'simple', // 🚀 수익률 계산 방식: simple(단리), compound(복리)
  simDirty: false,   // 파라미터 변경 후 재실행 필요 여부
  selectedTradeIndex: -1, // 선택된 시뮬레이션 거래 인덱스
  historyActive: false,    // 이력 영역 활성화 여부 (키보드 네비게이션용)
  selectedCodes: [],    // 🚀 신규: Ctrl+클릭으로 선택/박제된 종목 코드 (순서 유지)
  bbReq: 'opt',
  rsiReq: 'opt',
  stochReq: 'opt',
  eomReq: 'opt',
  macdFilterActive: true,
  macdReq: 'opt',
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  mfiFilterActive: true,
  mfiReq: 'opt',
  mfiPeriod: 14,
  mfiOB: 80,
  mfiOS: 20,
};

/* ══════════════════════════════════════════════
   펀더멘털 헬퍼 (캐시/TTL 없음 — 항상 실제 조회)
══════════════════════════════════════════════ */
async function _saveFundamentalToServer(code, data) {
  const hasValue = data.trailingPE != null || data.eps != null || data.beta != null;
  if (!hasValue) return;
  try {
    await Storage.saveFundamental(code, {
      trailingPE: data.trailingPE,
      eps: data.eps,
      beta: data.beta,
      fetchedAt: Date.now(),
      fetchFailed: false,
    });
  } catch (e) {
    console.warn(`[펀더멘털 서버 저장 실패] ${code}:`, e.message);
  }
}

/* ══════════════════════════════════════════════
   유틸리티
══════════════════════════════════════════════ */
const fmt = n => Number(n).toLocaleString('ko-KR');
const fmtPct = n => (n >= 0 ? '+' : '') + Math.trunc(n) + '%';

function fmtPrice(price, isUS) {
  if (isUS) return '$' + Number(price).toFixed(2);
  return fmt(Math.round(price)) + '원';
}

/** 🚀 지표 파라미터 추출 헬퍼 */
function _getIndicatorOpts() {
  return {
    rsiPeriod: SimState.rsiPeriod || 14,
    rsiOB: SimState.rsiOB || 70,
    rsiOS: SimState.rsiOS || 30,
    eomPeriod: SimState.eomPeriod || 14,
    eomSignal: SimState.eomSignal || 14,
    k1: SimState.stochK || 14,
    k2: SimState.stochSK || 3,
    d: SimState.stochSD || 3,
    ob: SimState.stochOB || 80,
    os: SimState.stochOS || 20,
    macdFast: SimState.macdFast || 12,
    macdSlow: SimState.macdSlow || 26,
    macdSignal: SimState.macdSignal || 9,
    mfiPeriod: SimState.mfiPeriod || 14,
    mfiOB: SimState.mfiOB || 80,
    mfiOS: SimState.mfiOS || 20
  };
}

/* ── 펀더멘털 값 포매터 ── */
// 배당률·성장률·PER·PBR 등 단순 소수값
function fmtFundPct(v) {
  if (v == null) return '';
  return (v * 100).toFixed(2) + '%';
}
function fmtFundNum(v, digits = 2) {
  if (v == null) return '';
  return Number(v).toFixed(digits);
}

function fmtChg(n, isUS) {
  const sign = n >= 0 ? '+' : '';
  if (isUS) return sign + Number(n).toFixed(2);
  return sign + fmt(Math.round(n));
}

function marketLabel(market) { return ''; }

function setLastUpdated() {
  // lastUpdated 요소가 없으면(제거됨) 아무것도 안 함
  const el = document.getElementById('lastUpdated');
  if (!el) return;
  const d = new Date();
  const pad = v => String(v).padStart(2, '0');
  el.textContent =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ══════════════════════════════════════════════
   시뮬레이션 상세 로그 렌더링 (Traceability)
══════════════════════════════════════════════ */
function renderSimLog(code) {
  const logPanel = document.getElementById('simLogPanel');
  const logContent = document.getElementById('simLogContent');
  if (!logPanel || !logContent) return;

  const result = SimState.simResults[code];
  if (!result || !result.trades || result.trades.length === 0) {
    logPanel.style.display = 'none';
    return;
  }

  logPanel.style.display = 'block';

  let html = `
    <table class="sim-log-table">
      <thead>
        <tr>
          <th>매수일</th>
          <th>매수가</th>
          <th>매도일</th>
          <th>매도가</th>
          <th style="text-align:right;">수익률</th>
        </tr>
      </thead>
      <tbody>
  `;

  const isUS = SimState.watchData[code]?.isUS;

  result.trades.forEach(t => {
    const pnlCls = t.pnl >= 0 ? 'up' : 'down';
    html += `
      <tr>
        <td class="log-date">${t.buyDate}</td>
        <td>${fmtPrice(t.buyPrice, isUS)}</td>
        <td class="log-date">${t.exitDate}</td>
        <td>${fmtPrice(t.exitPrice, isUS)}</td>
        <td class="log-pnl ${pnlCls}" style="text-align:right; font-weight:600;">
          ${fmtPct(t.pnl)}
        </td>
      </tr>
    `;
  });

  html += '</tbody></table>';
  logContent.innerHTML = html;
}

/* ══════════════════════════════════════════════
   전역 로딩
══════════════════════════════════════════════ */
function showGlobalLoading(show) {
  const el = document.getElementById('globalLoading');
  if (el) el.style.display = show ? 'flex' : 'none';
}

/* ══════════════════════════════════════════════
   Toast
══════════════════════════════════════════════ */
function showToast(msg, type = 'info') {
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  const icons = {
    info: 'fa-info-circle', warn: 'fa-exclamation-triangle',
    error: 'fa-times-circle', success: 'fa-check-circle'
  };

  let content = `<i class="fas ${icons[type] || icons.info}"></i><span>${msg}</span>`;
  content += `<i class="fas fa-times toast-close" style="margin-left:auto; cursor:pointer; opacity:0.6;" onclick="this.parentElement.remove()"></i>`;

  t.innerHTML = content;
  c.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('toast-show')));

  if (type === 'success' || type === 'info') {
    setTimeout(() => {
      if (t.parentElement) {
        t.classList.remove('toast-show');
        setTimeout(() => t.remove(), 300);
      }
    }, 3000);
  }
}

async function _markSimDirty(keepOptResults = false) {
  if (!SimState.simStarted) return;
  if (!keepOptResults) SimState.optResults = {};

  const yieldTo = () => new Promise(r => {
    if (typeof MessageChannel !== 'undefined') {
      const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(null);
    } else setTimeout(r, 0);
  });

  const codes = Object.keys(SimState.watchData);
  let processed = 0;

  for (const code of codes) {
    const opt = SimState.optResults[code];
    if (opt) {
      // 최적화된 종목은 저장된 '전용 공식'으로 재계산 (현재 전역 SimState 설정 무시)
      const backup = { ...SimState };
      Object.assign(SimState, opt);
      // 고정값 강제 (최적화 당시 기준 유지)
      SimState.holdDaysActive = false; SimState.targetProfitActive = false; SimState.bbFilterThreshold = 0;
      SimState.simResults[code] = _calculateTotalSim(SimState.watchData[code]);
      Object.assign(SimState, backup);
    } else {
      // 일반 종목은 현재 UI(전역 SimState) 설정대로 계산
      SimState.simResults[code] = _calculateTotalSim(SimState.watchData[code]);
    }

    processed++;
    if (processed % 30 === 0) {
      await yieldTo();
      renderList(); // 중간 중간 업데이트하여 진행 상황 노출
    }
  }

  renderList();
  if (SimState.previewCode) showStockPreview(SimState.previewCode);

  if (SimState.simDirty) return;
  SimState.simDirty = true;
  const btn = document.getElementById('btnRunSim');
  if (btn) {
    btn.style.background = '#7c2d12';
    btn.innerHTML = '다시 실행';
  }
}

function _clearSimDirty() {
  SimState.simDirty = false;
  const btn = document.getElementById('btnRunSim');
  if (btn) {
    btn.style.background = '';
    btn.innerHTML = '시작';
  }
}

function* generateCombos() {
  const signalWindows = [1, 2, 3];
  const buyTimes = ['today', 'next'];
  const sellTimes = ['today', 'next'];
  const bbBases = ['lower', 'middle'];
  const bbDirs = [{down:true, up:false}, {down:false, up:true}, {down:true, up:true}];
  const states = ['off', 'req', 'opt'];
  const bools = [true, false];
  
  for (let sw of signalWindows) {
    for (let bt of buyTimes) {
      for (let st of sellTimes) {
        for (let bbS of states) {
          const bases = bbS === 'off' ? [bbBases[0]] : bbBases;
          const dirs = bbS === 'off' ? [bbDirs[0]] : bbDirs;
          for (let base of bases) {
            for (let dir of dirs) {
              for (let rsiS of states) {
                for (let stochS of states) {
                  for (let eomS of states) {
                    for (let macdS of states) {
                      for (let mfiS of states) {
                        if (bbS === 'off' && rsiS === 'off' && stochS === 'off' && eomS === 'off' && macdS === 'off' && mfiS === 'off') continue;
                        
                        // 🚀 모든 매도 조건 조합 탐색 (2^6 = 64개)
                        for (let sBB of bools) {
                          for (let sRSI of bools) {
                            for (let sST of bools) {
                              for (let sEOM of bools) {
                                for (let sMACD of bools) {
                                  for (let sMFI of bools) {
                                    yield {
                                      simSignalWindow: sw,
                                      simBuyTiming: bt, simSellTiming: st,
                                      bbFilterActive: bbS !== 'off', bbReq: bbS === 'off' ? 'req' : bbS,
                                      bbBase: base, bbCrossDown: dir.down, bbCrossUp: dir.up,
                                      rsiFilterActive: rsiS !== 'off', rsiReq: rsiS === 'off' ? 'req' : rsiS,
                                      stochFilterActive: stochS !== 'off', stochReq: stochS === 'off' ? 'req' : stochS,
                                      eomFilterActive: eomS !== 'off', eomReq: eomS === 'off' ? 'req' : eomS,
                                      macdFilterActive: macdS !== 'off', macdReq: macdS === 'off' ? 'req' : macdS,
                                      mfiFilterActive: mfiS !== 'off', mfiReq: mfiS === 'off' ? 'req' : mfiS,
                                      bbTrackingSellActive: sBB, sellRSIActive: sRSI, sellSTOCHActive: sST, sellEOMActive: sEOM,
                                      sellMACDActive: sMACD, sellMFIActive: sMFI
                                    };
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

function _packScenarios() {
  const combos = [...generateCombos()];
  const n = combos.length;
  
  // 🚀 비트 오프셋 정의
  const B = {
    LD: 1<<0, LU: 1<<1, MD: 1<<2, MU: 1<<3, // BB 세부 (0~3)
    RSI: 1<<4, ST: 1<<5, EOM: 1<<6, MACD: 1<<7, MFI: 1<<8, // 지표 진입 (4~8)
    RSIS: 1<<9, STS: 1<<10, EOMS: 1<<11, MACDS: 1<<12, MFIS: 1<<13 // 지표 탈출 (9~13)
  };

  const packed = {
    count: n,
    combos: combos, // 🚀 메인 스레드에서 참조할 원본 데이터
    sw: new Uint8Array(n), bt: new Uint8Array(n), st: new Uint8Array(n),
    bbS: new Uint8Array(n), sBB: new Uint8Array(n),
    reqM: new Uint32Array(n), // 필수 지표 마스크 (BB 제외)
    optM: new Uint32Array(n), // 선택 지표 마스크 (BB 제외)
    bbM:  new Uint16Array(n), // 해당 전략의 BB 유효 비트들 (LD, LU, MD, MU)
    sellM: new Uint32Array(n), // 기술 지표 매도 마스크
    optA: new Uint8Array(n)   // 선택 조건 활성화 여부 (0/1)
  };

  combos.forEach((c, i) => {
    packed.sw[i] = c.simSignalWindow;
    packed.bt[i] = (c.simBuyTiming === 'today' ? 0 : 1);
    packed.st[i] = (c.simSellTiming === 'today' ? 0 : 1);
    packed.bbS[i] = c.bbFilterActive ? (c.bbReq === 'req' ? 1 : 2) : 0;
    packed.sBB[i] = c.bbTrackingSellActive ? 1 : 0;

    // BB 마스크 구성
    let bm = 0;
    if (c.bbBase === 'lower') {
      if (c.bbCrossDown) bm |= B.LD;
      if (c.bbCrossUp) bm |= B.LU;
    } else {
      if (c.bbCrossDown) bm |= B.MD;
      if (c.bbCrossUp) bm |= B.MU;
    }
    packed.bbM[i] = bm;

    // 지표 마스크 구성
    let rm = 0, om = 0, sm = 0;
    // RSI
    if (c.rsiFilterActive) { if (c.rsiReq === 'req') rm |= B.RSI; else om |= B.RSI; }
    if (c.sellRSIActive) sm |= B.RSIS;
    // ST
    if (c.stochFilterActive) { if (c.stochReq === 'req') rm |= B.ST; else om |= B.ST; }
    if (c.sellSTOCHActive) sm |= B.STS;
    // EOM
    if (c.eomFilterActive) { if (c.eomReq === 'req') rm |= B.EOM; else om |= B.EOM; }
    if (c.sellEOMActive) sm |= B.EOMS;
    // MACD
    if (c.macdFilterActive) { if (c.macdReq === 'req') rm |= B.MACD; else om |= B.MACD; }
    if (c.sellMACDActive) sm |= B.MACDS;
    // MFI
    if (c.mfiFilterActive) { if (c.mfiReq === 'req') rm |= B.MFI; else om |= B.MFI; }
    if (c.sellMFIActive) sm |= B.MFIS;

    packed.reqM[i] = rm;
    packed.optM[i] = om;
    packed.sellM[i] = sm;
    packed.optA[i] = (om > 0) ? 1 : 0;
  });
  return packed;
}

/** 🚀 Web Worker를 이용한 병렬 최적화 엔진 */
async function _runOptimizationParallel(codes, packed, onProgress) {
  // 물리 프로세서 수 - 1개만큼 워커 생성 (최대 14개)
  const numWorkers = Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 1, 14));
  const chunks = Array.from({ length: numWorkers }, () => []);
  codes.forEach((code, i) => chunks[i % numWorkers].push(code));

  const simParams = {
    simPeriodMonths: SimState.simPeriodMonths,
    bbBuyPriceType: SimState.bbBuyPriceType,
    bbSellPriceType: SimState.bbSellPriceType,
    pnlType: SimState.pnlType
  };

  let totalDone = 0;
  const workerPromises = chunks.map((chunk, i) => {
    if (chunk.length === 0) return Promise.resolve({});
    return new Promise((resolve) => {
      const worker = new Worker('js/sim_worker.js');
      
      // 해당 워커가 담당할 종목 데이터만 추출하여 전송 (메모리 절약)
      const chunkData = {};
      chunk.forEach(c => {
        if (SimState.watchData[c]) {
          chunkData[c] = { candlesWithBB: SimState.watchData[c].candlesWithBB };
        }
      });

      worker.onmessage = (e) => {
        totalDone += chunk.length;
        if (onProgress) onProgress(totalDone);
        worker.terminate();
        resolve(e.data.bests);
      };

      worker.onerror = (err) => {
        console.error(`Worker ${i} error:`, err);
        worker.terminate();
        resolve({});
      };

      // 워커 전송 시 combos 배열 제외 (메모리 폭증 방지)
      const { combos, ...workerPacked } = packed;

      worker.postMessage({
        codes: chunk,
        watchData: chunkData,
        packed: workerPacked,
        simParams: simParams
      });
    });
  });

  const resultsArray = await Promise.all(workerPromises);
  const combinedBests = {};
  resultsArray.forEach(res => Object.assign(combinedBests, res));
  return combinedBests;
}

async function runOptimization(codes) {
  const btn = document.getElementById('btnOptimize');
  if (!btn || codes.length === 0) return;
  btn.disabled = true;
  document.getElementById('btnRunSim').disabled = true;
  document.getElementById('btnTodayScan').disabled = true;
  
  SimState.simStarted = true; // 🚀 시뮬레이션 시작 플래그 활성화 (리스트 렌더링용)
  
  // 🚀 [Auto-Loader] 데이터가 없는 종목 식별 및 일괄 보충
  const missing = codes.filter(c => {
    const d = SimState.watchData[c];
    return !d || !d.candlesWithBB || d.candlesWithBB.length === 0;
  });
  if (missing.length > 0) {
    btn.textContent = `데이터 수집 (${missing.length})...`;
    try {
      const stocksToFetch = missing.map(c => ({ code: c }));
      await API.fetchBatch(stocksToFetch, SimState.candleCount, SimState.listInterval, (code, res) => {
        if (res) {
          SimState.watchData[code] = Indicators.analyzeAll(res, 20, _getIndicatorOpts());
        }
      });
    } catch (e) {
      console.warn('데이터 수집 중 오류:', e);
    }
  }

  const originalState = { ...SimState };
  SimState.holdDaysActive = false; SimState.targetProfitActive = false; SimState.bbFilterThreshold = 0;
  SimState.optResults = {};
  const packed = _packScenarios();
  const bests = {};
  codes.forEach(c => { bests[c] = { pnl: -Infinity, idx: -1 }; });
  const yieldTo = () => new Promise(r => {
    if (typeof MessageChannel !== 'undefined') {
      const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(null);
    } else setTimeout(r, 0);
  });

  // 🚀 [병렬화 적용] 물리 코어를 활용하여 수만 개의 시나리오를 병렬 탐색
  btn.textContent = `탐색 중 (Worker)...`;
  const parallelBests = await _runOptimizationParallel(codes, packed, (doneCount) => {
    const pct = Math.floor((doneCount / codes.length) * 50); // 0~50% 구간 표시
    btn.textContent = `${pct}%`;
    btn.style.background = `linear-gradient(90deg, #9333ea ${pct}%, #7e22ce ${pct}%)`;
  });
  
  // 결과 병합
  Object.assign(bests, parallelBests);

  let done = 0; // 후처리용 카운터 초기화
  Object.assign(SimState, originalState);
  let found = false;

  // 🚀 [후처리 비동기화] 진행율 50% -> 100% 구간 처리
  for (const code of codes) {
    try {
      const b = bests[code];
      if (b && b.idx !== -1) {
        found = true;
        // 🚀 1단계: 벡터 엔진이 찾은 최적 콤보를 복사
        const rawCombo = { ...packed.combos[b.idx] };

        // 🚀 2단계: 실제 매매 이력 생성으로 검증
        const backup = { ...SimState };
        Object.assign(SimState, rawCombo);
        SimState.holdDaysActive = false; SimState.targetProfitActive = false; SimState.bbFilterThreshold = 0;
        const detailResult = _calculateTotalSim(SimState.watchData[code]);
        Object.assign(SimState, backup);

        // 🚀 3단계: 한 번도 발동하지 않은 지표 제거 (노이즈 정리)
        const cleanCombo = { ...rawCombo };
        if (detailResult && detailResult.trades && detailResult.trades.length > 0) {
          // 실제 청산 사유 수집
          const exitReasons = new Set(detailResult.trades.map(t => t.exitReason).filter(Boolean));
          // 실제 진입 사유 수집
          const entryParts = new Set(
            detailResult.trades
              .map(t => t.reason || '')
              .flatMap(r => r.replace('(In)', '').replace('(대기)', '').split('+'))
              .filter(Boolean)
          );

          // 지표 정제
          if (cleanCombo.sellRSIActive && !exitReasons.has('RSI매도')) cleanCombo.sellRSIActive = false;
          if (cleanCombo.sellSTOCHActive && !exitReasons.has('ST매도')) cleanCombo.sellSTOCHActive = false;
          if (cleanCombo.sellEOMActive && !exitReasons.has('EOM매도')) cleanCombo.sellEOMActive = false;
          if (cleanCombo.sellMACDActive && !exitReasons.has('MACD매도')) cleanCombo.sellMACDActive = false;
          if (cleanCombo.sellMFIActive && !exitReasons.has('MFI매도')) cleanCombo.sellMFIActive = false;
          if (cleanCombo.bbTrackingSellActive && !exitReasons.has('상단이탈') && !exitReasons.has('중단이탈')) {
            cleanCombo.bbTrackingSellActive = false;
          }

          if (cleanCombo.rsiFilterActive && cleanCombo.rsiReq === 'opt' && !entryParts.has('RSI')) cleanCombo.rsiFilterActive = false;
          if (cleanCombo.stochFilterActive && cleanCombo.stochReq === 'opt' && !entryParts.has('ST')) cleanCombo.stochFilterActive = false;
          if (cleanCombo.eomFilterActive && cleanCombo.eomReq === 'opt' && !entryParts.has('EOM')) cleanCombo.eomFilterActive = false;
          if (cleanCombo.macdFilterActive && cleanCombo.macdReq === 'opt' && !entryParts.has('MACD')) cleanCombo.macdFilterActive = false;
          if (cleanCombo.mfiFilterActive && cleanCombo.mfiReq === 'opt' && !entryParts.has('MFI')) cleanCombo.mfiFilterActive = false;
          if (cleanCombo.bbFilterActive && cleanCombo.bbReq === 'opt' && !entryParts.has('BB')) cleanCombo.bbFilterActive = false;
        }

        // 🚀 4단계: 최종 저장
        SimState.optResults[code] = cleanCombo;
        SimState.simResults[code] = detailResult;
      }
    } catch (e) {
      console.warn(`[검증 오류] ${code}:`, e);
    }
    
    // 🚀 매 5종목마다 진행율 업데이트 (50% -> 100%)
    done++;
    if (done % 5 === 0 || done === codes.length) {
        const pct = 50 + Math.floor((done / codes.length) * 50);
        btn.textContent = `검증 중... ${pct}%`;
        btn.style.background = `linear-gradient(90deg, #9333ea ${pct}%, #7e22ce ${pct}%)`;
        await yieldTo();
    }
  }
  if (found) {
    const firstCode = codes.find(c => bests[c].idx !== -1);
    const best = SimState.optResults[firstCode]; // 🚀 정제된 콤보 사용
    Object.assign(SimState, best);
    SimState.holdDaysActive = false; SimState.targetProfitActive = false; SimState.bbFilterThreshold = 0;
    syncUIToState(best); 
    
    // 🚀 [최적화] 이미 위에서 모든 종목의 simResults를 계산했으므로 
    // 중복 연산을 수행하는 _markSimDirty를 호출하지 않고 직접 상태 업데이트
    SimState.simDirty = false;
    const sBtn = document.getElementById('btnRunSim');
    if (sBtn) { sBtn.style.background = ''; sBtn.innerHTML = '시작'; }
    
    renderList(); 
    showStockPreview(firstCode);
    showToast(`총 ${codes.length}개 종목 최적조건 탐색 완료!`, 'success');
  } else {
    showToast('유효한 전략이 없습니다.', 'error');
  }
  btn.textContent = '최적조건'; btn.style.background = ''; btn.disabled = false;
  _updateRunButtonsState();
}

function syncUIToState(combo) {
  const byId = (id, val) => { const e = document.getElementById(id); if (e) e.value = val; };
  const checkById = (id, val) => { const e = document.getElementById(id); if (e) e.checked = val; };
  
  byId('simSignalWindow', combo.simSignalWindow);
  
  document.getElementsByName('simBuyTiming').forEach(r => r.checked = (r.value === combo.simBuyTiming));
  document.getElementsByName('simSellTiming').forEach(r => r.checked = (r.value === combo.simSellTiming));
  document.getElementsByName('pnlType').forEach(r => r.checked = (r.value === SimState.pnlType));
  document.getElementsByName('bbBase').forEach(r => r.checked = (r.value === combo.bbBase));
  
  checkById('checkBBFilter', combo.bbFilterActive);
  document.getElementsByName('bbReq').forEach(r => r.checked = (r.value === combo.bbReq));
  checkById('checkBBCrossDown', combo.bbCrossDown);
  checkById('checkBBCrossUp', combo.bbCrossUp);
  
  checkById('checkRsiFilter', combo.rsiFilterActive);
  document.getElementsByName('rsiReq').forEach(r => r.checked = (r.value === combo.rsiReq));
  
  checkById('checkStochFilter', combo.stochFilterActive);
  document.getElementsByName('stochReq').forEach(r => r.checked = (r.value === combo.stochReq));
  
  checkById('checkEomFilter', combo.eomFilterActive);
  document.getElementsByName('eomReq').forEach(r => r.checked = (r.value === combo.eomReq));
  
  checkById('checkMacdFilter', combo.macdFilterActive);
  document.getElementsByName('macdReq').forEach(r => r.checked = (r.value === combo.macdReq));
  byId('inputMacdFast', combo.macdFast || 12);
  byId('inputMacdSlow', combo.macdSlow || 26);
  byId('inputMacdSignal', combo.macdSignal || 9);

  checkById('checkMfiFilter', combo.mfiFilterActive);
  document.getElementsByName('mfiReq').forEach(r => r.checked = (r.value === combo.mfiReq));
  byId('inputMfiPeriod', combo.mfiPeriod || 14);
  byId('inputMfiOB', combo.mfiOB || 80);
  byId('inputMfiOS', combo.mfiOS || 20);

  checkById('checkSellBB', combo.bbTrackingSellActive);
  checkById('checkSellRSI', combo.sellRSIActive);
  checkById('checkSellSTOCH', combo.sellSTOCHActive);
  checkById('checkSellEOM', combo.sellEOMActive);
  checkById('checkSellMACD', combo.sellMACDActive);
  checkById('checkSellMFI', combo.sellMFIActive);
  
  checkById('checkHoldDays', false);
  checkById('checkTargetProfit', false);
  byId('inputBBThreshold', 0);
}

/* ══════════════════════════════════════════════
   기본값 초기화 모듈
══════════════════════════════════════════════ */
function resetFiltersToDefault() {
  SimState.optResults = {}; // 🚀 초기화 시 개별 최적화 메모리도 싹 날림

  const defaultCombo = {
    simSignalWindow: 1,
    simBuyTiming: 'today',
    simSellTiming: 'today',
    bbBuyPriceType: 'close',
    bbSellPriceType: 'close',
    bbFilterActive: true,
    bbReq: 'opt',
    bbBase: 'lower',
    bbCrossDown: true,
    bbCrossUp: true,
    rsiFilterActive: true,
    rsiReq: 'opt',
    stochFilterActive: true,
    stochReq: 'opt',
    eomFilterActive: true,
    eomReq: 'opt',
    macdFilterActive: true,
    macdReq: 'opt',
    mfiFilterActive: true,
    mfiReq: 'opt',
    bbTrackingSellActive: true,
    sellRSIActive: true,
    sellSTOCHActive: true,
    sellEOMActive: true,
    sellMACDActive: true,
    sellMFIActive: true
  };

  Object.assign(SimState, defaultCombo);
  SimState.holdDaysActive = false;
  SimState.targetProfitActive = false;
  SimState.bbFilterThreshold = 0;
  
  // 기간(6M) UI 복구 추가
  SimState.simPeriodMonths = 6;
  SimState.candleCount = Math.ceil(SimState.simPeriodMonths * 21) + 60;

  syncUIToState(defaultCombo);

  document.getElementsByName('bbBuyPriceType').forEach(r => r.checked = (r.value === defaultCombo.bbBuyPriceType));
  document.getElementsByName('bbSellPriceType').forEach(r => r.checked = (r.value === defaultCombo.bbSellPriceType));
  
  const byId = (id, val) => { const e = document.getElementById(id); if (e) e.value = val; };
  byId('simHoldingDays', 5);
  byId('simTargetProfit', 5);
  byId('simPeriodMonths', 6);

  _updateRunButtonsState();
  
  SimState.simDirty = true;
  const btn = document.getElementById('btnRunSim');
  if (btn) {
    btn.style.background = '#7c2d12';
    btn.style.boxShadow = 'none';
    btn.innerHTML = '다시 실행';
  }
}

/* ══════════════════════════════════════════════
   헤더 컨트롤 초기화
══════════════════════════════════════════════ */
function initHeaderControls() {
  SimState.previewInterval = '1d';
  SimState.listInterval = '1d';
  SimState.candleCount = 252; // 약 1년치

  // 조건 초기화 버튼 바인딩
  const btnReset = document.getElementById('btnResetFilters');
  if (btnReset) btnReset.addEventListener('click', () => {
    resetFiltersToDefault();
    showToast('조건 설정이 초기화되었습니다.', 'success');
  });

  // 최적조건 탐색 버튼 바인딩
  const btnOpt = document.getElementById('btnOptimize');
  if (btnOpt) btnOpt.addEventListener('click', () => {
    const targets = SimState.selectedCodes.length > 0 ? SimState.selectedCodes : getSelectedStocks().map(s => s.code);
    if (targets.length > 0) runOptimization(targets);
  });

  // 시뮬레이션 버튼 바인딩
  const btnRun = document.getElementById('btnRunSim');
  if (btnRun) btnRun.addEventListener('click', () => {
    SimState.todayMode = false;
    SimState.optResults = {}; // 🚀 수동 실행 시 기존 최적화 메모리 리셋
    runSimulation();
  });

  // 오늘 탐색 버튼 바인딩
  const btnToday = document.getElementById('btnTodayScan');
  if (btnToday) btnToday.addEventListener('click', () => {
    SimState.optResults = {}; // 🚀 수동 실행 시 기존 최적화 메모리 리셋
    runTodayScan();
  });

  // 분석기간
  const selPeriod = document.getElementById('simPeriodMonths');
  if (selPeriod) {
    selPeriod.addEventListener('change', () => {
      SimState.simPeriodMonths = parseInt(selPeriod.value);
      SimState.candleCount = Math.ceil(SimState.simPeriodMonths * 21) + 60;
      _markSimDirty();
    });
    SimState.simPeriodMonths = parseInt(selPeriod.value);
  }

  // 보유일
  const inpDays = document.getElementById('simHoldingDays');
  if (inpDays) {
    inpDays.addEventListener('input', () => {
      SimState.simHoldingDays = parseInt(inpDays.value) || 5;
      _markSimDirty();
    });
    const v = parseInt(inpDays.value);
    SimState.simHoldingDays = isNaN(v) ? 5 : v;
  }

  // 목표수익
  const inpProfit = document.getElementById('simTargetProfit');
  if (inpProfit) {
    inpProfit.addEventListener('input', () => {
      const v = parseFloat(inpProfit.value);
      if (!isNaN(v)) {
        SimState.simTargetProfit = v;
        _markSimDirty();
      }
    });
    const v = parseFloat(inpProfit.value);
    SimState.simTargetProfit = isNaN(v) ? 5 : v;
  }

  // 시그널 유효 윈도우
  const inpWin = document.getElementById('simSignalWindow');
  if (inpWin) {
    inpWin.addEventListener('input', () => {
      const v = parseInt(inpWin.value);
      if (!isNaN(v)) {
        SimState.simSignalWindow = v;
        _markSimDirty();
      }
    });
    const v = parseInt(inpWin.value);
    SimState.simSignalWindow = isNaN(v) ? 1 : v;
  }

  // 매수 시점 (당일/익일 라디오)
  const radiosBuyTiming = document.getElementsByName('simBuyTiming');
  radiosBuyTiming.forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) {
        SimState.simBuyTiming = r.value;
        _markSimDirty();
      }
    });
    if (r.checked) SimState.simBuyTiming = r.value;
  });

  // 매도 시점 (당일/익일 라디오)
  const radiosSellTiming = document.getElementsByName('simSellTiming');
  radiosSellTiming.forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) {
        SimState.simSellTiming = r.value;
        _markSimDirty();
      }
    });
    if (r.checked) SimState.simSellTiming = r.value;
  });

  // 수익률 계산 방식 (단리/복리 라디오)
  const radiosPnlType = document.getElementsByName('pnlType');
  radiosPnlType.forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) {
        SimState.pnlType = r.value;
        // 계산 방식 변경은 차트와 리스트에 즉시 반영되어야 함
        renderList();
        if (SimState.previewCode) showStockPreview(SimState.previewCode);
      }
    });
    if (r.checked) SimState.pnlType = r.value;
  });

  // 보유일 사용 여부
  const checkHoldDays = document.getElementById('checkHoldDays');
  if (checkHoldDays) {
    checkHoldDays.addEventListener('change', () => {
      SimState.holdDaysActive = checkHoldDays.checked;
      _markSimDirty();
    });
    SimState.holdDaysActive = checkHoldDays.checked;
  }

  // 익절 사용 여부
  const checkTargetProfit = document.getElementById('checkTargetProfit');
  if (checkTargetProfit) {
    checkTargetProfit.addEventListener('change', () => {
      SimState.targetProfitActive = checkTargetProfit.checked;
      _markSimDirty();
    });
    SimState.targetProfitActive = checkTargetProfit.checked;
  }
}

function getAllStocksFromDB() {
  const tabs = Storage.getTabs();
  const seen = new Set();
  const result = [];
  tabs.forEach(tab => {
    (tab.stocks || []).forEach(stock => {
      if (!seen.has(stock.code)) {
        seen.add(stock.code);
        result.push(stock);
      }
    });
  });
  return result;
}

/**
 * 현재 선택된 그룹에 속한 종목 목록 반환 (시뮬레이션 대상)
 */
function getSelectedStocks() {
  const select = document.getElementById('simGroupSelect');
  if (!select || select.value === 'all') {
    return getAllStocksFromDB();
  }
  const tabId = select.value;
  const tabs = Storage.getTabs();
  const targetTab = tabs.find(t => t.uid === tabId);
  return targetTab ? (targetTab.stocks || []) : [];
}

/**
 * 🚀 필터(BB, EOM, RSI)가 하나도 선택되지 않으면 분석 버튼 비활성화
 */
function _updateRunButtonsState() {
  const btnRun = document.getElementById('btnRunSim');
  const btnToday = document.getElementById('btnTodayScan');
  const btnOpt = document.getElementById('btnOptimize');
  const hasFilter = SimState.bbFilterActive || SimState.eomFilterActive || SimState.rsiFilterActive || SimState.stochFilterActive || SimState.macdFilterActive || SimState.mfiFilterActive;
  
  if (btnOpt) {
    const stocks = getSelectedStocks();
    const canOpt = (SimState.selectedCodes.length > 0) || (stocks && stocks.length > 0);
    btnOpt.disabled = !canOpt;
    btnOpt.style.opacity = canOpt ? '1' : '0.5';
    btnOpt.style.cursor = canOpt ? 'pointer' : 'not-allowed';
  }

  if (btnRun) {
    btnRun.disabled = !hasFilter;
    if (!hasFilter) {
      btnRun.style.opacity = '0.5';
      btnRun.style.cursor = 'not-allowed';
    } else {
      btnRun.style.opacity = '1';
      btnRun.style.cursor = 'pointer';
    }
  }
  if (btnToday) {
    btnToday.disabled = !hasFilter;
    if (!hasFilter) {
      btnToday.style.opacity = '0.5';
      btnToday.style.cursor = 'not-allowed';
    } else {
      btnToday.style.opacity = '1';
      btnToday.style.cursor = 'pointer';
    }
  }
}

function initFilters() {
  const checkBB = document.getElementById('checkBBFilter');
  const inputBB = document.getElementById('inputBBThreshold');
  const checkEom = document.getElementById('checkEomFilter');
  const checkRsi = document.getElementById('checkRsiFilter');

  const chkSellBB = document.getElementById('checkSellBB');
  const chkSellEom = document.getElementById('checkSellEOM');
  const chkSellRsi = document.getElementById('checkSellRSI');
  const chkSellStoch = document.getElementById('checkSellSTOCH');
  const chkSellMacd = document.getElementById('checkSellMACD');
  const chkSellMfi = document.getElementById('checkSellMFI');

  if (checkBB) {
    checkBB.addEventListener('change', () => {
      SimState.bbFilterActive = checkBB.checked;
      if (chkSellBB) {
        chkSellBB.checked = checkBB.checked;
        SimState.bbTrackingSellActive = checkBB.checked;
      }
      _updateRunButtonsState();
      _markSimDirty();
      if (SimState.simStarted) renderList();
    });
    SimState.bbFilterActive = checkBB.checked;
  }
  if (inputBB) {
    inputBB.addEventListener('input', () => {
      const val = parseFloat(inputBB.value);
      if (!isNaN(val)) {
        SimState.bbFilterThreshold = val;
        _markSimDirty();
        if (SimState.simStarted) renderList();
      }
    });
    const initVal = parseFloat(inputBB.value);
    SimState.bbFilterThreshold = isNaN(initVal) ? 0 : initVal; // 하드코딩 제거: UI 기본값(0)을 우선함
  }
  if (checkEom) {
    checkEom.addEventListener('change', () => {
      SimState.eomFilterActive = checkEom.checked;
      if (chkSellEom) {
        chkSellEom.checked = checkEom.checked;
        SimState.sellEOMActive = checkEom.checked;
      }
      _updateRunButtonsState();
      _markSimDirty();
      if (SimState.simStarted) renderList();
    });
    SimState.eomFilterActive = checkEom.checked;
  }

  const inputEomPeriod = document.getElementById('inputEomPeriod');
  if (inputEomPeriod) {
    inputEomPeriod.addEventListener('input', () => {
      SimState.eomPeriod = parseInt(inputEomPeriod.value) || 14;
      _markSimDirty();
    });
    SimState.eomPeriod = parseInt(inputEomPeriod.value) || 14;
  }

  const inputEomSignal = document.getElementById('inputEomSignal');
  if (inputEomSignal) {
    inputEomSignal.addEventListener('input', () => {
      SimState.eomSignal = parseInt(inputEomSignal.value) || 14;
      _markSimDirty();
    });
    SimState.eomSignal = parseInt(inputEomSignal.value) || 14;
  }
  if (checkRsi) {
    checkRsi.addEventListener('change', () => {
      SimState.rsiFilterActive = checkRsi.checked;
      if (chkSellRsi) {
        chkSellRsi.checked = checkRsi.checked;
        SimState.sellRSIActive = checkRsi.checked;
      }
      _updateRunButtonsState();
      _markSimDirty();
      if (SimState.simStarted) renderList();
    });
    SimState.rsiFilterActive = checkRsi.checked;
  }
  
  const inputRsiP = document.getElementById('inputRsiPeriod');
  if (inputRsiP) {
    inputRsiP.addEventListener('input', () => {
      SimState.rsiPeriod = parseInt(inputRsiP.value) || 14;
      _markSimDirty();
    });
    SimState.rsiPeriod = parseInt(inputRsiP.value) || 14;
  }

  const inputRsiOB = document.getElementById('inputRsiOB');
  if (inputRsiOB) {
    inputRsiOB.addEventListener('input', () => {
      SimState.rsiOB = parseInt(inputRsiOB.value) || 70;
      _markSimDirty();
    });
    SimState.rsiOB = parseInt(inputRsiOB.value) || 70;
  }

  const inputRsiOS = document.getElementById('inputRsiOS');
  if (inputRsiOS) {
    inputRsiOS.addEventListener('input', () => {
      SimState.rsiOS = parseInt(inputRsiOS.value) || 30;
      _markSimDirty();
    });
    SimState.rsiOS = parseInt(inputRsiOS.value) || 30;
  }

  // Stochastic 필터 및 파라미터
  const checkStoch = document.getElementById('checkStochFilter');
  if (checkStoch) {
    checkStoch.addEventListener('change', () => {
      SimState.stochFilterActive = checkStoch.checked;
      if (chkSellStoch) {
        chkSellStoch.checked = checkStoch.checked;
        SimState.sellSTOCHActive = checkStoch.checked;
      }
      _updateRunButtonsState();
      _markSimDirty();
      if (SimState.simStarted) renderList();
    });
    SimState.stochFilterActive = checkStoch.checked;
  }

  const inputsStoch = ['inputStochK', 'inputStochSK', 'inputStochSD', 'inputStochOB', 'inputStochOS'];
  const stochPropMap = {
    inputStochK: 'stochK',
    inputStochSK: 'stochSK',
    inputStochSD: 'stochSD',
    inputStochOB: 'stochOB',
    inputStochOS: 'stochOS'
  };

  inputsStoch.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        SimState[stochPropMap[id]] = parseInt(el.value) || 0;
        _markSimDirty();
      });
      SimState[stochPropMap[id]] = parseInt(el.value) || 0;
    }
  });

  const radiosBBBase = document.getElementsByName('bbBase');
  radiosBBBase.forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) {
        SimState.bbBase = r.value;
        _markSimDirty();
      }
    });
    if (r.checked) SimState.bbBase = r.value;
  });

  // BB 매수 가격 기준
  const radiosBBBuyPrice = document.getElementsByName('bbBuyPriceType');
  radiosBBBuyPrice.forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) {
        SimState.bbBuyPriceType = r.value;
        _markSimDirty();
      }
    });
    if (r.checked) SimState.bbBuyPriceType = r.value;
  });

  // BB 매도 가격 기준
  const radiosBBSellPrice = document.getElementsByName('bbSellPriceType');
  radiosBBSellPrice.forEach(r => {
    r.addEventListener('change', () => {
      if (r.checked) {
        SimState.bbSellPriceType = r.value;
        _markSimDirty();
      }
    });
    if (r.checked) SimState.bbSellPriceType = r.value;
  });

  // BB 방향 (이탈/돌파)
  const checkBBCrossDown = document.getElementById('checkBBCrossDown');
  if (checkBBCrossDown) {
    checkBBCrossDown.addEventListener('change', () => {
      SimState.bbCrossDown = checkBBCrossDown.checked;
      _markSimDirty();
    });
    SimState.bbCrossDown = checkBBCrossDown.checked;
  }
  const checkBBCrossUp = document.getElementById('checkBBCrossUp');
  if (checkBBCrossUp) {
    checkBBCrossUp.addEventListener('change', () => {
      SimState.bbCrossUp = checkBBCrossUp.checked;
      _markSimDirty();
    });
    SimState.bbCrossUp = checkBBCrossUp.checked;
  }

  // 매도(탈출) 전용 체크박스 이벤트 리스너
  if (chkSellBB) {
    chkSellBB.addEventListener('change', () => {
      SimState.bbTrackingSellActive = chkSellBB.checked;
      _markSimDirty();
    });
    SimState.bbTrackingSellActive = chkSellBB.checked;
  }
  if (chkSellRsi) {
    chkSellRsi.addEventListener('change', () => {
      SimState.sellRSIActive = chkSellRsi.checked;
      _markSimDirty();
    });
    SimState.sellRSIActive = chkSellRsi.checked;
  }
  if (chkSellStoch) {
    chkSellStoch.addEventListener('change', () => {
      SimState.sellSTOCHActive = chkSellStoch.checked;
      _markSimDirty();
    });
    SimState.sellSTOCHActive = chkSellStoch.checked;
  }
  if (chkSellEom) {
    chkSellEom.addEventListener('change', () => {
      SimState.sellEOMActive = chkSellEom.checked;
      _markSimDirty();
    });
    SimState.sellEOMActive = chkSellEom.checked;
  }
  if (chkSellMacd) {
    chkSellMacd.addEventListener('change', () => {
      SimState.sellMACDActive = chkSellMacd.checked;
      _markSimDirty();
    });
    SimState.sellMACDActive = chkSellMacd.checked;
  }
  if (chkSellMfi) {
    chkSellMfi.addEventListener('change', () => {
      SimState.sellMFIActive = chkSellMfi.checked;
      _markSimDirty();
    });
    SimState.sellMFIActive = chkSellMfi.checked;
  }

  // MACD 필터
  const checkMacd = document.getElementById('checkMacdFilter');
  if (checkMacd) {
    checkMacd.addEventListener('change', () => {
      SimState.macdFilterActive = checkMacd.checked;
      if (chkSellMacd) {
        chkSellMacd.checked = checkMacd.checked;
        SimState.sellMACDActive = checkMacd.checked;
      }
      _updateRunButtonsState();
      _markSimDirty();
      if (SimState.simStarted) renderList();
    });
    SimState.macdFilterActive = checkMacd.checked;
  }
  ['inputMacdFast', 'inputMacdSlow', 'inputMacdSignal'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        const prop = id.replace('input', '').charAt(0).toLowerCase() + id.replace('input', '').slice(1);
        SimState[prop] = parseInt(el.value) || (id === 'inputMacdFast' ? 12 : (id === 'inputMacdSlow' ? 26 : 9));
        _markSimDirty();
      });
      const prop = id.replace('input', '').charAt(0).toLowerCase() + id.replace('input', '').slice(1);
      SimState[prop] = parseInt(el.value) || (id === 'inputMacdFast' ? 12 : (id === 'inputMacdSlow' ? 26 : 9));
    }
  });

  // MFI 필터
  const checkMfi = document.getElementById('checkMfiFilter');
  if (checkMfi) {
    checkMfi.addEventListener('change', () => {
      SimState.mfiFilterActive = checkMfi.checked;
      if (chkSellMfi) {
        chkSellMfi.checked = checkMfi.checked;
        SimState.sellMFIActive = checkMfi.checked;
      }
      _updateRunButtonsState();
      _markSimDirty();
      if (SimState.simStarted) renderList();
    });
    SimState.mfiFilterActive = checkMfi.checked;
  }
  ['inputMfiPeriod', 'inputMfiOB', 'inputMfiOS'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        const prop = id.replace('input', '').charAt(0).toLowerCase() + id.replace('input', '').slice(1);
        SimState[prop] = parseInt(el.value) || (id === 'inputMfiPeriod' ? 14 : (id === 'inputMfiOB' ? 80 : 20));
        _markSimDirty();
      });
      const prop = id.replace('input', '').charAt(0).toLowerCase() + id.replace('input', '').slice(1);
      SimState[prop] = parseInt(el.value) || (id === 'inputMfiPeriod' ? 14 : (id === 'inputMfiOB' ? 80 : 20));
    }
  });

  // 필수/선택 (req/opt) 라디오 이벤트 연동
  const reqMap = {
    bbReq: 'checkBBFilter',
    rsiReq: 'checkRsiFilter',
    stochReq: 'checkStochFilter',
    eomReq: 'checkEomFilter',
    macdReq: 'checkMacdFilter',
    mfiReq: 'checkMfiFilter'
  };

  Object.keys(reqMap).forEach(name => {
    const radios = document.getElementsByName(name);
    const mainCheckId = reqMap[name];
    radios.forEach(r => {
      r.addEventListener('change', () => {
        if (r.checked) {
          SimState[name] = r.value;
          
          const mainCb = document.getElementById(mainCheckId);
          if (mainCb && !mainCb.checked) {
            mainCb.checked = true;
            // 🚀 체크박스 강제 발동: 자동으로 SimState 갱신 및 _markSimDirty()가 호출됨
            mainCb.dispatchEvent(new Event('change'));
          } else {
            // 이미 켜져 있으면 토글 로직에 대한 dirty 갱신만 수행
            _markSimDirty();
          }
        }
      });
      if (r.checked) SimState[name] = r.value;
    });
  });

  // 초기 상태 반영
  _updateRunButtonsState();
}

/* ══════════════════════════════════════════════
   탭 관리
══════════════════════════════════════════════ */


function startTabRename(tabId, labelEl) {
  const input = document.getElementById('tabRenameInput');
  const rect = labelEl.getBoundingClientRect();
  input.value = labelEl.textContent;
  input.style.cssText = `display:block;position:fixed;left:${rect.left}px;top:${rect.top}px;` +
    `width:${Math.max(80, rect.width + 20)}px;z-index:2000;`;
  input.focus(); input.select();
  const finish = async () => {
    const val = input.value.trim();
    if (val) await Storage.renameTab(tabId, val);
    input.style.display = 'none';
    input.removeEventListener('blur', finish);
    input.removeEventListener('keydown', onKey);
    renderTabs();
  };
  const onKey = e => {
    if (e.key === 'Enter') finish();
    if (e.key === 'Escape') { input.style.display = 'none'; renderTabs(); }
  };
  input.addEventListener('blur', finish, { once: true });
  input.addEventListener('keydown', onKey);
}

// function initAddTab() { ... } 제거됨

/* ══════════════════════════════════════════════
   좌단 검색 & 미리보기
══════════════════════════════════════════════ */
// function initSearch() { ... } 제거됨

async function doSearch(input, dbOnly = false) {
  // 로딩 표시 없이 즉시 조회 (B 검색, F 행 클릭, D/E 일봉/주봉 미리보기 공통)
  hideSearchError();
  SimState.selectedTradeIndex = -1; // 종목 변경 시 선택 인덱스 초기화
  SimState.previewCode = input.toUpperCase();
  try {
    const raw = await API.fetchStock(input, SimState.candleCount, SimState.previewInterval);
    const analyzed = Indicators.analyzeAll(raw, 20, _getIndicatorOpts());
    SimState.previewCode = analyzed.code;
    SimState.previewData = analyzed;
    if (Object.prototype.hasOwnProperty.call(SimState.watchData, analyzed.code)) {
      if (SimState.previewInterval === SimState.listInterval) {
        SimState.watchData[analyzed.code] = analyzed;
        _refreshListItem(analyzed.code);
      }
      _fixStockNameIfNeeded(analyzed.code, analyzed.name);
    }
    renderPreview(analyzed);
  } catch (err) {
    SimState.previewCode = null;
    showSearchError(err.message || '데이터를 가져오는 데 실패했습니다.');
  }
}

/* ── 미리보기 렌더링 ── */
/* ══════════════════════════════════════════════
   상관관계 분석
══════════════════════════════════════════════ */

/**
 * 두 종가 배열의 피어슨 상관계수 계산
 * - 날짜 기준 정렬 후 공통 날짜만 사용
 * - 최소 5개 공통 데이터 포인트 필요
 */
function renderCorrSection(correlations) {
  const sec = document.getElementById('corrSection');
  if (!sec) return;

  if (!correlations) {
    sec.style.display = 'none';
    return;
  }

  const { pos, neu, neg } = correlations;
  if (!pos || !neu || !neg) { sec.style.display = 'none'; return; }

  const barColor = r => r >= 0 ? 'var(--up)' : 'var(--down)';
  const rFmt = r => (r >= 0 ? '+' : '') + r.toFixed(2);

  const makeItem = (item, badgeClass, badgeText) => {
    const wrap = document.createElement('div');
    wrap.className = 'corr-item';

    const badge = document.createElement('span');
    badge.className = `corr-badge ${badgeClass}`;
    badge.textContent = badgeText;

    const score = document.createElement('span');
    score.className = 'corr-score';
    score.style.color = barColor(item.val);
    score.textContent = rFmt(item.val);

    const nameEl = document.createElement('span');
    nameEl.className = 'corr-name corr-clickable';
    nameEl.textContent = item.name || item.code;
    nameEl.title = `${item.name || item.code} 조회`;

    const codeEl = document.createElement('span');
    codeEl.className = 'corr-code corr-clickable';
    codeEl.textContent = '';
    codeEl.title = `${item.name || item.code} 조회`;

    const onClick = () => {
      const inputEl = document.getElementById('stockInput');
      if (inputEl) {
        inputEl.value = item.code;
        if (typeof doSearch !== 'undefined') doSearch(item.code);
      }
    };
    nameEl.addEventListener('click', onClick);
    codeEl.addEventListener('click', onClick);

    wrap.append(badge, score, nameEl, codeEl);
    return wrap;
  };

  sec.innerHTML = '';
  sec.className = 'corr-section corr-horizontal';
  sec.appendChild(makeItem(pos, 'corr-badge-pos', '양'));
  sec.appendChild(makeItem(neu, 'corr-badge-neu', '중'));
  sec.appendChild(makeItem(neg, 'corr-badge-neg', '음'));
  sec.style.display = 'flex';
}

function renderPreview(data) {
  if (!data || !data.candlesWithBB || data.candlesWithBB.length === 0) {
    hidePreview();
    return;
  }
  const { name, code, market, currentPrice, isUS, interval,
    todayChange, todayChangePct, change, changePct,
    bb, alert: al } = data;

  // 🚀 [On-Demand Simulation] 오늘 탐색 모드에서 상세 조회 시 과거 이력 즉석 계산
  if (SimState.todayMode && data.candlesWithBB) {
    const existing = SimState.simResults[data.code];
    // 아직 전체 이력(trades)이 계산되지 않은 상태라면 지금 실행
    if (existing && !existing.trades) {
      const fullRes = _calculateTotalSim(data);
      SimState.simResults[data.code] = {
        ...existing,
        ...fullRes
      };
    }
  }

  document.getElementById('previewName').textContent = name;
  document.getElementById('previewCode').textContent = data.ticker;
  document.getElementById('previewPrice').textContent = fmtPrice(currentPrice, isUS);
  document.getElementById('previewIntervalBadge').textContent = interval === '1wk' ? '주봉' : '일봉';

  // 섹터 백지
  const sectorBadge = document.getElementById('previewSectorBadge');
  if (sectorBadge) {
    const sector = data.sector || SimState.fundamentals[data.code]?.sector;
    if (sector) {
      // /api/stock 응답의 sector를 fundamentals 캐시에도 저장 (리스트 표시용)
      if (data.sector && !SimState.fundamentals[data.code]) {
        SimState.fundamentals[data.code] = {};
      }
      if (data.sector && SimState.fundamentals[data.code]) {
        SimState.fundamentals[data.code].sector = data.sector;
      }
      sectorBadge.textContent = sector;
      sectorBadge.style.display = '';
    } else {
      sectorBadge.style.display = 'none';
    }
  }

  // 금일 등락: 전일 종가 → 현재가
  const todayEl = document.getElementById('previewTodayChange');
  if (todayEl) {
    todayEl.textContent = `${fmtPct(todayChangePct)} (${fmtChg(todayChange, isUS)})`;
    todayEl.className = 'preview-today-chg ' + (todayChange >= 0 ? 'up' : 'down');
  }

  // 기간 등락 라벨 (N일 / N주)
  const periodLbl = document.getElementById('previewPeriodLabel');
  if (periodLbl) {
    periodLbl.textContent = interval === '1wk'
      ? `${SimState.candleCount}주`
      : `${SimState.candleCount}일`;
  }

  // 기간 등락: 기간 첫날 종가 → 현재가
  const chgEl = document.getElementById('previewChange');
  if (chgEl) {
    chgEl.textContent = `${fmtPct(changePct)} (${fmtChg(change, isUS)})`;
    chgEl.className = 'preview-change ' + (change >= 0 ? 'up' : 'down');
  }

  // BB 경고 배지
  const alertEl = document.getElementById('previewAlert');
  if (alertEl) {
    alertEl.textContent = al.stars;
    alertEl.className = `preview-alert alert-lv${al.level}`;
  }

  // BB 바
  if (bb) {
    const pct = (al.ratio * 100).toFixed(1);
    const fill = document.getElementById('previewBBFill');
    fill.style.width = pct + '%';
    fill.className = `bb-bar-fill lv${al.level}`;
    document.getElementById('previewBBMarker').style.left = pct + '%';

    // 현재가 기준 BB 상단/중단/하단까지 % 거리 + 밴드 가격
    const cur = currentPrice;
    const upperPctEl = document.getElementById('previewBBUpperPct');
    const middlePctEl = document.getElementById('previewBBMiddlePct');
    const lowerPctEl = document.getElementById('previewBBLowerPct');
    const upperPriceEl = document.getElementById('previewBBUpperPrice');
    const middlePriceEl = document.getElementById('previewBBMiddlePrice');
    const lowerPriceEl = document.getElementById('previewBBLowerPrice');

    const setBBBand = (pctEl, priceEl, band) => {
      if (!pctEl && !priceEl) return;
      const v = ((band - cur) / cur) * 100;
      const cls = v >= 0 ? 'pct-up' : 'pct-down';
      if (pctEl) {
        pctEl.textContent = (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
        pctEl.className = 'bb-pct-val ' + cls;
      }
      if (priceEl) {
        priceEl.textContent = fmtPrice(band, isUS);
        priceEl.className = 'bb-pct-price ' + cls;
      }
    };
    setBBBand(upperPctEl, upperPriceEl, bb.upper);
    setBBBand(middlePctEl, middlePriceEl, bb.middle);
    setBBBand(lowerPctEl, lowerPriceEl, bb.lower);
  }

  // leftPanelTitle 제거됨 — 종목명은 previewName에만 표시
  const latest = data.candlesWithBB?.at(-1);
  const hEom = document.getElementById('headerEomValue');
  const hRsi = document.getElementById('headerRsiValue');
  if (hEom) hEom.textContent = latest?.eom != null ? (latest.eom > 0 ? '+' : '') + latest.eom.toFixed(2) : '--';
  if (hRsi) hRsi.textContent = latest?.rsi != null ? Math.round(latest.rsi) : '--';

  const regBtn = document.getElementById('btnRegister');
  if (regBtn) {
    regBtn.disabled = false;
    regBtn.innerHTML = '<i class="fas fa-plus-circle"></i> 등록';
    regBtn.style.display = 'flex';
  }
  const previewCard = document.getElementById('previewCard');
  if (previewCard) previewCard.style.display = 'flex';

  // 상관관계 섹션: API 응답에 correlations 데이터가 있을 때만 표시
  // watchData 키 불일치 문제를 피하기 위해 data.correlations를 직접 넘김
  const corrData = data.correlations || SimState.watchData[data.code]?.correlations;
  renderCorrSection(corrData);

  ['eomSection', 'rsiStochSection', 'macdSection', 'mfiSection'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'block';
  });

  // 시뮬레이션 이력 렌더링 (추가)
  // 🚀 키 불일치 방지: data.code 대신 클릭 시 사용된 SimState.previewCode를 우선 참조
  const simRes = SimState.simResults[SimState.previewCode] || SimState.simResults[data.code];
  const histSection = document.getElementById('simHistorySection');
  if (histSection) {
    if (simRes && simRes.trades && simRes.trades.length > 0) {
      histSection.style.display = 'block';
      renderSimHistory(simRes.trades);
    } else {
      histSection.style.display = 'none';
    }
  }

  // 시뮬레이션 상세 로그 렌더링 (기존 모달용 로그)
  renderSimLog(SimState.previewCode || data.code);

  setTimeout(() => {
    Charts.renderMini('previewChart', data, simRes, SimState.simPeriodMonths, SimState.selectedTradeIndex);
    Charts.renderEOM('eomChart', data, simRes, SimState.simPeriodMonths);
    Charts.renderRSIStoch('rsiStochChart', data, simRes, SimState.simPeriodMonths, SimState.rsiOB, SimState.rsiOS, SimState.stochOB, SimState.stochOS);
    Charts.renderMACD('macdChart', data, simRes, SimState.simPeriodMonths, SimState.selectedTradeIndex);
    Charts.renderMFI('mfiChart', data, simRes, SimState.simPeriodMonths, SimState.mfiOB, SimState.mfiOS, SimState.selectedTradeIndex);
  }, 50);
}

async function showStockPreview(code) {
  const cached = SimState.watchData[code];
  SimState.selectedTradeIndex = -1; // 종목 변경 시 선택 인덱스 초기화
  SimState.historyActive = false;   // 종목 변경 시 이력 영역 활성 해제

  // previewInterval 과 listInterval 이 같으면 캐시 즉시 표시 후 백그라운드 갱신
  if (cached && SimState.previewInterval === SimState.listInterval) {
    SimState.previewCode = code;
    SimState.previewData = cached;
    renderPreview(cached);
    // 캐시로 즉시 표시 후 백그라운드에서 watchData + 리스트 BB만 조용히 갱신
    // (hidePreview/showLoading 없이 실행 → 화면 깜빡임 방지)
    _bgRefreshStock(cached.ticker || code, code);
    return;
  }

  // previewInterval 이 listInterval 과 다른 경우(예: 주봉 선택 상태)
  // → previewInterval 기준으로 DB 조회 (dbOnly=true, 깜빡임 없음)
  doSearch(code, true);
}

/* ── 백그라운드 종목 갱신: 미리보기 UI를 건드리지 않고 watchData·리스트만 갱신 ── */
async function _bgRefreshStock(input, registeredCode) {
  try {
    // listInterval(previewInterval과 동기화) 기준으로 fetch
    const raw = await API.fetchStock(input, SimState.candleCount, SimState.listInterval);
    const analyzed = Indicators.analyzeAll(raw, 20, _getIndicatorOpts());
    const code = registeredCode || analyzed.code;
    // watchData 갱신 (등록된 종목이면)
    if (Object.prototype.hasOwnProperty.call(SimState.watchData, code)) {
      SimState.watchData[code] = analyzed;
      _refreshListItem(code);
      _fixStockNameIfNeeded(code, analyzed.name);
    }
    // 목록과 미리보기가 동일한 종목, 동일한 조건(일봉/주봉)을 표시 중이라면 미리보기도 갱신 (데이터 불일치 버그 수정)
    if (SimState.previewCode === code && SimState.previewInterval === SimState.listInterval) {
      SimState.previewData = analyzed;
      renderPreview(analyzed);
    }
  } catch (_) {
    // 백그라운드 실패 무시 (캐시 데이터로 이미 표시 중)
  }
}

function hidePreview() {
  const previewCard2 = document.getElementById('previewCard');
  if (previewCard2) previewCard2.style.display = 'none';
  const regBtn = document.getElementById('btnRegister');
  if (regBtn) { regBtn.style.display = 'none'; regBtn.disabled = true; }
  // leftPanelTitle 제거됨
  ['eomSection', 'rsiStochSection'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  Charts.dispose('eomChart');
  Charts.dispose('rsiStochChart');
  Charts.dispose('macdChart');
  Charts.dispose('mfiChart');
}
function showSearchError(msg) {
  showToast(msg, 'error');
}
function hideSearchError() {
  const el = document.getElementById('searchError');
  if (el) el.style.display = 'none';
}
function showSearchLoading(v) { document.getElementById('searchLoading').style.display = v ? 'flex' : 'none'; }

/* ══════════════════════════════════════════════
   일봉/주봉 전환 — API 1회 배치 조회
   1. POST /api/stock/batch (전체 종목, 새 interval)
   2. 응답 배열에서 previewCode 먼저 → renderPreview()
   3. 나머지 순차 → _refreshListItem()
   4. previewCode가 탭에 없으면 → POST /api/stock 1회 별도
══════════════════════════════════════════════ */
async function _intervalSwitch(interval) {
  // 1. 현재 활성 탭 종목 우선 분류
  const activeStocks = Storage.getWatchlist();
  const activeCodes = new Set(activeStocks.map(s => s.code));

  // 2. 나머지 모든 탭 종목 수집
  const otherStocks = [];
  const seen = new Set(activeCodes);
  Storage.getTabs().forEach(tab => {
    tab.stocks.forEach(s => {
      if (!seen.has(s.code)) {
        seen.add(s.code);
        otherStocks.push(s);
      }
    });
  });

  // watchData 키 선점
  [...activeStocks, ...otherStocks].forEach(s => {
    if (!Object.prototype.hasOwnProperty.call(SimState.watchData, s.code)) {
      SimState.watchData[s.code] = null;
    }
  });

  // 🚀 단계 1: 현재 탭 종목 즉시 전환 로드
  if (activeStocks.length) {
    console.log(`[Interval] 우선순위 로드: ${activeStocks.length}종목 (${interval})`);
    const batchResults = await API.fetchBatch(activeStocks, SimState.candleCount, interval, null);

    batchResults.forEach((res, i) => {
      if (res) {
        const analyzed = Indicators.analyzeAll(res, 20, _getIndicatorOpts());
        const code = activeStocks[i].code;
        SimState.watchData[code] = analyzed;
        if (analyzed.name) _fixStockNameIfNeeded(code, analyzed.name);
      }
    });

    _syncFundamentalsFromWatchData();
    setLastUpdated();
    renderList(); // 현재 탭 즉시 갱신

    // 미리보기 화면 동기화
    if (SimState.previewCode && activeCodes.has(SimState.previewCode)) {
      if (SimState.previewInterval === interval) {
        const data = SimState.watchData[SimState.previewCode];
        if (data) renderPreview(data);
      }
    }
  }

  // 🚀 단계 2: 나머지 종목 백그라운드 분할 로드 (50개씩)
  if (otherStocks.length) {
    console.log(`[Interval] 백그라운드 로드 시작: ${otherStocks.length}종목`);
    const CHUNK_SIZE = 50;

    (async () => {
      for (let i = 0; i < otherStocks.length; i += CHUNK_SIZE) {
        const chunk = otherStocks.slice(i, i + CHUNK_SIZE);
        const chunkResults = await API.fetchBatch(chunk, SimState.candleCount, interval, null);

        chunkResults.forEach((res, j) => {
          if (res) {
            const analyzed = Indicators.analyzeAll(res, 20, _getIndicatorOpts());
            const code = chunk[j].code;
            SimState.watchData[code] = analyzed;
            if (analyzed.name) _fixStockNameIfNeeded(code, analyzed.name);
          }
        });

        // 배치 처리 완료 후 화면 갱신 (프로그레시브 로딩)
        if (SimState.bbFilterActive || SimState.eomFilterActive || SimState.rsiFilterActive || SimState.stochFilterActive) {
          renderList();
        }

        // 브라우저 렌더링을 위해 숨 고르기
        await new Promise(r => setTimeout(r, 50));
      }
      _syncFundamentalsFromWatchData();
      if (SimState.bbFilterActive || SimState.eomFilterActive || SimState.rsiFilterActive || SimState.stochFilterActive) {
        renderList();
      }
      console.log(`[Interval] 모든 종목 전환 로드 완료`);
    })();
  }
}

/* ══════════════════════════════════════════════
   우단 전체 새로고침 (비동기 스텔스 갱신)
══════════════════════════════════════════════ */
async function doRefreshAll(btn) {
  const stocks = getAllStocksFromDB();
  if (!stocks.length) return;

  const total = stocks.length;
  let done = 0;

  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-sync-alt fa-spin"></i> 데이터 수집 중... (0/${total})`;

  try {
    // API.fetchBatch는 DB 데이터만 가져오므로 매우 빠름
    await API.fetchBatch(stocks, SimState.candleCount, SimState.listInterval, (code, res, err) => {
      done++;
      if (res) {
        const analyzed = Indicators.analyzeAll(res, 20, _getIndicatorOpts());
        SimState.watchData[code] = analyzed;
        _refreshListItem(code);
        if (analyzed.name) _fixStockNameIfNeeded(code, analyzed.name);
      }
      btn.innerHTML = `<i class="fas fa-sync-alt fa-spin"></i> 로컬 데이터 로드 중... (${done}/${total})`;
    });
  } catch (e) {
    showToast(`데이터 로드 실패: ${e.message}`, 'error');
  }

  _syncFundamentalsFromWatchData();
  setLastUpdated();
  renderList();

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-sync-alt"></i> 전체 갱신';
  showToast(`${total}개 종목 데이터 수집 완료`, 'success');
}

/**
 * 🚀 시뮬레이션 핵심 엔진
 */
async function runSimulation() {
  const stocks = getSelectedStocks();
  if (!stocks.length) {
    showToast('시뮬레이션할 대상 종목이 없습니다.', 'warn');
    return;
  }

  // BB 방향(이탈/돌파) 모두 미선택 시 경고
  if (SimState.bbFilterActive && !SimState.bbCrossDown && !SimState.bbCrossUp) {
    showToast('BB 필터 사용 시 이탈 또는 돌파 방향을 하나 이상 선택하세요.', 'warn');
    return;
  }

  const btn = document.getElementById('btnRunSim');
  btn.disabled = true;
  // 분석 중 표시 (dirty 스타일 초기화)
  btn.style.background = '#081640';
  btn.style.boxShadow = 'none';
  btn.innerHTML = `<i class="fas fa-sync-alt fa-spin"></i> 0/${stocks.length}`;

  SimState.simStarted = true; // 시작 플래그 ON

  try {
    // 🚀 실시간 진행률 표시를 위해 100종목씩 끊어서 처리 (Chunking)
    const CHUNK_SIZE = 100;
    let done = 0;

    for (let i = 0; i < stocks.length; i += CHUNK_SIZE) {
      const chunk = stocks.slice(i, i + CHUNK_SIZE);
      
      await API.fetchBatch(chunk, SimState.candleCount, SimState.listInterval, (code, res, err) => {
        done++;
        if (res) {
          const analyzed = Indicators.analyzeAll(res, 20, _getIndicatorOpts());
          SimState.watchData[code] = analyzed;
          SimState.simResults[code] = _calculateTotalSim(analyzed);
        }
        // 버튼에 현재 진행 상황 업데이트 (동기적 루프가 아니므로 UI 반영됨)
        btn.innerHTML = `<i class="fas fa-sync-alt fa-spin"></i> ${done}/${stocks.length}`;
      });

      // 대량 처리 시 UI 프리징 방지를 위한 미세한 휴식 (선택 사항)
      if (stocks.length > CHUNK_SIZE) await new Promise(r => setTimeout(r, 10));
    }

    _clearSimDirty(); // 성공 시 dirty 해제
    renderList();

    // 결과 요약 Toast: 전략 조건에 부합했던 종목 수만 표시
    const matchedCount = stocks.filter(s => (SimState.simResults[s.code]?.total ?? 0) > 0).length;
    showToast(`분석 완료: 전략 조건에 부합한 종목 ${matchedCount}개 발견`, 'success');
  } catch (e) {
    console.error(e);
    showToast('시뮬레이션 실패: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    // dirty 상태에 따라 버튼 복원
    if (SimState.simDirty) {
      btn.style.background = '#7c2d12';
      btn.style.boxShadow = 'none';
      btn.innerHTML = '다시 실행';
    } else {
      btn.style.background = '';
      btn.style.boxShadow = '';
      btn.innerHTML = '시작';
    }
    _updateRunButtonsState(); // 필터 유무에 따른 추가 검증
  }
}

function _calculateTotalSim(data) {
  if (!data || !data.candlesWithBB) return null;

  // 🚀 핵심 수정 1: 지표가 하나도 선택되지 않았으면 시뮬레이션 하지 않음
  const anyFilter = SimState.bbFilterActive || SimState.eomFilterActive || SimState.rsiFilterActive || SimState.stochFilterActive || SimState.macdFilterActive || SimState.mfiFilterActive;
  if (!anyFilter) {
    return { success: 0, total: 0, winRate: 0, pnl: 0, buyAndHoldPnl: 0, diffPnl: 0, pnlAvg: 0, trades: [] };
  }

  const candles = data.candlesWithBB;
  const totalDays = candles.length;
  if (totalDays === 0) return null;

  // 🚀 현재일로부터 N개월 전 정확한 시작 날짜 계산
  const lastCandle = candles[totalDays - 1];
  if (!lastCandle) return null;
  
  const lastDate = new Date(lastCandle.date);
  const startDate = new Date(lastDate);
  startDate.setMonth(startDate.getMonth() - SimState.simPeriodMonths);

  // startDate보다 크거나 같은 첫 번째 캔들 인덱스 찾기
  let startIdx = 0;
  for (let i = 0; i < totalDays; i++) {
    if (candles[i] && new Date(candles[i].date) >= startDate) {
      startIdx = i;
      break;
    }
  }

  const endThreshold = totalDays - 1; 

  let totalSignals = 0;
  let successCount = 0;
  let cumulativePnl = 0; 
  let compoundMulti = 1.0; 
  let firstBuyPrice = null;
  const trades = [];
  const win = SimState.simSignalWindow; 

  let nextAllowedIdx = startIdx; 

  for (let i = startIdx; i <= endThreshold; i++) {
    if (i < nextAllowedIdx) continue; 

    const c = candles[i];
    if (!c.bbUpper || !c.bbLower) continue;

    const isBuyToday = SimState.simBuyTiming === 'today';
    const isSellToday = SimState.simSellTiming === 'today';

    // 1. 오늘의 시그널 조건 체크 (BB + EOM + RSI 교집합)
    let bbOk = !SimState.bbFilterActive;
    if (SimState.bbFilterActive) {
      for (let k = 0; k < win; k++) {
        const curIdx = i - k;
        if (curIdx < 0) break;
        
        const curC = candles[curIdx];
        const baseVal = SimState.bbBase === 'middle' ? curC.bbMiddle : curC.bbLower;
        if (baseVal === null) continue;

        const threshold = SimState.bbFilterThreshold || 0;
        // 밴드 선 기준값 (임계값 반영)
        const triggerLine = baseVal * (1 + threshold / 100);
        
        const prevIdx = curIdx - 1;
        if (prevIdx < 0) continue;
        
        const prev = candles[prevIdx];
        const prevBase = SimState.bbBase === 'middle' ? prev.bbMiddle : prev.bbLower;
        if (prevBase === null) continue;
        
        const prevTriggerLine = prevBase * (1 + threshold / 100);
        
        // 🚀 매수 가격 기준(buyPriceType) 적용
        const pPrice = prev?.[SimState.bbBuyPriceType] || prev?.close || 0;
        const cPrice = curC?.[SimState.bbBuyPriceType] || curC?.close || 0;

        let crossOk = false;
        // 이탈 (Cross Down)
        if (SimState.bbCrossDown) {
          if (pPrice > prevTriggerLine && cPrice <= triggerLine) crossOk = true;
        }
        // 돌파 (Cross Up)
        if (SimState.bbCrossUp) {
          if (pPrice < prevTriggerLine && cPrice >= triggerLine) crossOk = true;
        }

        if (crossOk) {
          bbOk = true;
          break;
        }
      }
    }

    let eomOk = !SimState.eomFilterActive;
    let eomSigIdx = -1;
    if (SimState.eomFilterActive) {
      for (let k = 0; k < win; k++) {
        if (i - k < 0) break;
        if (candles[i - k].eomCross === 'BUY') { 
          eomOk = true; 
          eomSigIdx = i - k; 
          break; 
        }
      }
    }

    let rsiOk = !SimState.rsiFilterActive;
    let rsiSigIdx = -1;
    if (SimState.rsiFilterActive) {
      for (let k = 0; k < win; k++) {
        if (i - k < 0) break;
        if (candles[i - k].rsiSignal === 'BUY') { 
          rsiOk = true; 
          rsiSigIdx = i - k;
          break; 
        }
      }
    }

    let stochOk = !SimState.stochFilterActive;
    let stochSigIdx = -1;
    if (SimState.stochFilterActive) {
      for (let k = 0; k < win; k++) {
        if (i - k < 0) break;
        if (candles[i - k].stochSignal === 'BUY') { 
          stochOk = true; 
          stochSigIdx = i - k;
          break; 
        }
      }
    }

    let macdOk = !SimState.macdFilterActive;
    if (SimState.macdFilterActive) {
      for (let k = 0; k < win; k++) {
        if (i - k < 0) break;
        if (candles[i - k].macdCross === 'BUY') { macdOk = true; break; }
      }
    }

    let mfiOk = !SimState.mfiFilterActive;
    if (SimState.mfiFilterActive) {
      for (let k = 0; k < win; k++) {
        if (i - k < 0) break;
        if (candles[i - k].mfiSignal === 'BUY') { mfiOk = true; break; }
      }
    }

    // 2. 진입 결정 (오늘 확정 -> 매수 시점(simBuyTiming)에 따라 매수 처리)
    let allReqMet = true;
    let anyOptSelected = false;
    let anyOptMet = false;

    const checkIndicator = (active, req, met) => {
      if (active) {
        if (req === 'req') { if (!met) allReqMet = false; }
        else { anyOptSelected = true; if (met) anyOptMet = true; }
      }
    };

    checkIndicator(SimState.bbFilterActive, SimState.bbReq, bbOk);
    checkIndicator(SimState.eomFilterActive, SimState.eomReq, eomOk);
    checkIndicator(SimState.rsiFilterActive, SimState.rsiReq, rsiOk);
    checkIndicator(SimState.stochFilterActive, SimState.stochReq, stochOk);
    checkIndicator(SimState.macdFilterActive, SimState.macdReq, macdOk);
    checkIndicator(SimState.mfiFilterActive, SimState.mfiReq, mfiOk);

    const optConditionMet = anyOptSelected ? anyOptMet : true;

    if (allReqMet && optConditionMet) {
      // 🚀 핵심 수정: 다중 지표 결합 시 최종 기준일은 과거가 아닌 조건 완성 당일(i)로 기록
      if (!candles[i]) continue;
      const sigDate = candles[i].date;

      let buyIdx = isBuyToday ? i : i + 1;
      
      // 🚀 핵심 수정: 내일자 캔들이 없는 오늘자(Today) '익일 매수' 신호 누락 방지 (대기 상태로 기록)
      if (!candles[buyIdx]) {
        const reasons = [];
        if (SimState.bbFilterActive && bbOk) reasons.push('BB');
        if (SimState.eomFilterActive && eomOk) reasons.push('EOM');
        if (SimState.rsiFilterActive && rsiOk) reasons.push('RSI');
        if (SimState.stochFilterActive && stochOk) reasons.push('ST');
        if (SimState.macdFilterActive && macdOk) reasons.push('MACD');
        if (SimState.mfiFilterActive && mfiOk) reasons.push('MFI');
        if (reasons.length === 0) {
          if (SimState.bbFilterActive) reasons.push('BB');
          if (SimState.eomFilterActive) reasons.push('EOM');
          if (SimState.rsiFilterActive) reasons.push('RSI');
          if (SimState.stochFilterActive) reasons.push('ST');
          if (SimState.macdFilterActive) reasons.push('MACD');
          if (SimState.mfiFilterActive) reasons.push('MFI');
        }
        
        trades.push({
          sigDate,
          buyDate: '발생완료 (익일매수 대기)',
          buyPrice: 0,
          exitDate: '-',
          exitPrice: 0,
          exitReason: '대기중',
          pnl: 0,
          isOpen: true,
          reason: (reasons.length > 0 ? reasons.join('+') : '시그널') + '(대기)'
        });
        totalSignals++;
        continue;
      }

      const buyPrice = candles[buyIdx]?.[SimState.bbBuyPriceType] ?? candles[buyIdx]?.close ?? 0;
      if (firstBuyPrice === null) firstBuyPrice = buyPrice;
      const buyDate = candles[buyIdx]?.date || 'Unknown';

      let hitTarget = false;
      let isOpen = false;
      let actualExitIdx = -1;
      let exitPrice = 0;
      let exitDate = '';
      let exitReason = '기간만료';

      // 추적 매도용 상태: 현재 적용 중인 마지노선 값 (null -> middle -> upper 순으로 상향)
      let currentMajinosen = null;
      let majinosenLevel = 0; // 0:없음, 1:중단, 2:상단

      // 3. 보유 기간 중 매도 조건 감시 (종가 기준)
      // 최대 감시 기간을 남은 데이터 전체(끝까지)로 설정 (기존 120일 제한 해제)
      const maxWatchDays = totalDays - buyIdx; 
      
      for (let j = 0; j < maxWatchDays; j++) {
        const checkIdx = buyIdx + j;
        if (!candles[checkIdx]) {
          isOpen = true;
          actualExitIdx = totalDays - 1;
          exitPrice = candles[actualExitIdx]?.[SimState.bbSellPriceType] ?? candles[actualExitIdx]?.close ?? 0;
          exitDate = null;
          exitReason = '진행중';
          hitTarget = true;
          break;
        }

        const curClose = candles[checkIdx]?.close ?? 0;
        const curBB = {
          upper: candles[checkIdx]?.bbUpper,
          middle: candles[checkIdx]?.bbMiddle,
          lower: candles[checkIdx]?.bbLower
        };

        // A. 추적 매도 마지노선 업데이트 (돌파 시 상향)
        const sPrice = candles[checkIdx]?.[SimState.bbSellPriceType] ?? candles[checkIdx]?.close ?? 0;
        const raisePrice = candles[checkIdx]?.close ?? 0; // 마지노선 상승 판별은 종가 기준으로 고정 (민감도 유지)

        if (SimState.bbTrackingSellActive && curBB.middle !== null) {
          // 레벨 상향 판별 (한 번 올라간 레벨은 내려가지 않음)
          if (majinosenLevel < 1 && raisePrice > curBB.middle) majinosenLevel = 1;
          if (majinosenLevel < 2 && curBB.upper !== null && raisePrice > curBB.upper) majinosenLevel = 2;
          
          // 마지노선을 당일의 현재 밴드값으로 매일 추적(Trailing) 업데이트 (과거 가격 고정 오류 수정)
          if (majinosenLevel === 1) currentMajinosen = curBB.middle;
          else if (majinosenLevel === 2) currentMajinosen = curBB.upper;
        }

        // 매수 당일(j=0)은 매도 조건 체크 생략 (최소 1일 보유 보장)
        if (j === 0) continue;

        // B. 매도 조건 체크 (First-hit)

        // 1) 추적 매도: 당일 업데이트된 마지노선 밴드 이탈 여부 실제 추적 확인
        if (SimState.bbTrackingSellActive && currentMajinosen !== null) {
          if (sPrice < currentMajinosen) {
            exitReason = (majinosenLevel === 2) ? '상단이탈' : '중단이탈';
            actualExitIdx = isSellToday ? checkIdx : checkIdx + 1;
            hitTarget = true;
          }
        }

        // 2) 익절: 매도기준가가 목표가 이상일 때 (Option)
        if (!hitTarget && SimState.targetProfitActive) {
          const targetPrice = buyPrice * (1 + SimState.simTargetProfit / 100);
          if (sPrice >= targetPrice) {
            exitReason = '목표익절';
            actualExitIdx = isSellToday ? checkIdx : checkIdx + 1;
            hitTarget = true;
          }
        }

        // 3) 기술적 지표 매도 신호
        if (!hitTarget && SimState.sellEOMActive && candles[checkIdx].eomCross === 'SELL') {
          exitReason = 'EOM매도';
          actualExitIdx = isSellToday ? checkIdx : checkIdx + 1;
          hitTarget = true;
        }
        if (!hitTarget && SimState.sellRSIActive && candles[checkIdx].rsiSignal === 'SELL') {
          exitReason = 'RSI매도';
          actualExitIdx = isSellToday ? checkIdx : checkIdx + 1;
          hitTarget = true;
        }
        if (!hitTarget && SimState.sellSTOCHActive && candles[checkIdx].stochSignal === 'SELL') {
          exitReason = 'ST매도';
          actualExitIdx = isSellToday ? checkIdx : checkIdx + 1;
          hitTarget = true;
        }
        if (!hitTarget && SimState.sellMACDActive && candles[checkIdx].macdCross === 'SELL') {
          exitReason = 'MACD매도';
          actualExitIdx = isSellToday ? checkIdx : checkIdx + 1;
          hitTarget = true;
        }
        if (!hitTarget && SimState.sellMFIActive && candles[checkIdx].mfiSignal === 'SELL') {
          exitReason = 'MFI매도';
          actualExitIdx = isSellToday ? checkIdx : checkIdx + 1;
          hitTarget = true;
        }

        // 4) 보유기간 만료 (Option)
        if (!hitTarget && SimState.holdDaysActive) {
          if (j >= SimState.simHoldingDays - 1) {
            exitReason = '기간만료';
            actualExitIdx = isSellToday ? checkIdx : checkIdx + 1;
            hitTarget = true;
          }
        }

        if (hitTarget) {
          // 🧤 같은 날 in/out 동시 발생 방지
          if (actualExitIdx <= buyIdx) actualExitIdx = buyIdx + 1;
          
          if (!candles[actualExitIdx]) {
            isOpen = true;
            actualExitIdx = totalDays - 1;
            exitPrice = candles[actualExitIdx]?.[SimState.bbSellPriceType] ?? candles[actualExitIdx]?.close ?? 0;
            exitDate = null;
            exitReason = '진행중';
          } else {
            exitPrice = candles[actualExitIdx]?.[SimState.bbSellPriceType] ?? candles[actualExitIdx]?.close ?? 0;
            exitDate = candles[actualExitIdx]?.date || 'Unknown';
          }
          break;
        }
      }

      // 매도 조건을 충족하지 못하고 데이터 끝(현재)에 도달한 경우: 강제 청산이 아닌 '진행중' 상태로 유지
      if (!hitTarget) {
        actualExitIdx = totalDays - 1; // 🚀 버그 수정: 중복 매수 방지를 위해 진행중이더라도 통제 인덱스 명시
        exitPrice = candles[actualExitIdx]?.[SimState.bbSellPriceType] ?? candles[actualExitIdx]?.close ?? 0;
        exitDate = null;
        exitReason = '진행중';
        isOpen = true;
      }

      // 5. 수익 및 통계 기록
      let tradePnlPct = ((exitPrice - buyPrice) / buyPrice) * 100;
      totalSignals++;
      
      if (tradePnlPct > 0) successCount++; // 종가 기준이므로 실제 PnL이 양수면 성공

      cumulativePnl += tradePnlPct;
      compoundMulti *= (1 + tradePnlPct / 100);

      // 🚀 실제 발동된 지표만 표시 (단순 활성화 여부가 아닌 신호 발동 여부 기준)
      const reasons = [];
      if (SimState.bbFilterActive && bbOk) reasons.push('BB');
      if (SimState.eomFilterActive && eomOk) reasons.push('EOM');
      if (SimState.rsiFilterActive && rsiOk) reasons.push('RSI');
      if (SimState.stochFilterActive && stochOk) reasons.push('ST');
      if (SimState.macdFilterActive && macdOk) reasons.push('MACD');
      if (SimState.mfiFilterActive && mfiOk) reasons.push('MFI');
      // 모두 false인 경우 (opt 조건 충족 등)는 활성 필터를 폴백으로 표시
      if (reasons.length === 0) {
        if (SimState.bbFilterActive) reasons.push('BB');
        if (SimState.eomFilterActive) reasons.push('EOM');
        if (SimState.rsiFilterActive) reasons.push('RSI');
        if (SimState.stochFilterActive) reasons.push('ST');
        if (SimState.macdFilterActive) reasons.push('MACD');
        if (SimState.mfiFilterActive) reasons.push('MFI');
      }
      const reasonStr = (reasons.length > 0 ? reasons.join('+') : '시그널') + '(In)';

      trades.push({
        sigDate,
        buyDate,
        buyPrice, // 🚀 실제 매수가 필드 복구 (보유 수익률 계산용)
        buyIdx,
        exitDate,
        exitPrice,
        exitReason,
        exitIdx: actualExitIdx,
        pnl: tradePnlPct,
        isOpen,
        reason: reasonStr
      });

      nextAllowedIdx = actualExitIdx + 1;
    }
  }

  const pnlAvg = trades.length > 0 ? (cumulativePnl / trades.length) : 0;
  const lastPrice = lastCandle?.close || 0;
  const buyAndHoldPnl = firstBuyPrice !== null && firstBuyPrice > 0 ? ((lastPrice - firstBuyPrice) / firstBuyPrice) * 100 : 0;
  const compoundedPnl = (compoundMulti - 1) * 100;

  // 🚀 리스크 지표(MDD, Sharpe, Sortino) 계산을 위한 일별 자산곡선 생성
  const equityCurve = new Float32Array(totalDays).fill(1.0);
  const dailyReturns = [];
  let currentComp = 1.0;

  trades.forEach(t => {
    const start = t.buyIdx;
    const end = t.exitIdx;
    if (start === -1 || start >= totalDays) return;
    
    // 매수 시점의 기초가 (익일매수라면 buyIdx의 시가/종가)
    const basePrice = candles[start]?.[SimState.bbBuyPriceType] || candles[start]?.close || 0;
    if (basePrice <= 0) return;

    for (let i = start; i <= end; i++) {
      if (!candles[i]) break;
      const dayPrice = candles[i].close || 0;
      const tradeDayReturn = (dayPrice - basePrice) / basePrice;
      equityCurve[i] = currentComp * (1 + tradeDayReturn);
      
      // 일별 변동성 계산을 위한 수익률 수집 (보유 중인 날만)
      if (i > start && candles[i-1]) {
        const prevDayPrice = candles[i-1].close || 0;
        const dRet = (dayPrice - prevDayPrice) / prevDayPrice;
        dailyReturns.push(dRet);
      }
    }
    // 다음 매매를 위해 현재까지의 확정 복리 수익률 업데이트
    const exitPriceFinal = candles[end]?.[SimState.bbSellPriceType] || candles[end]?.close || 0;
    if (basePrice > 0) {
      currentComp *= (1 + (exitPriceFinal - basePrice) / basePrice);
    }
  });

  // 보유하지 않은 날은 직전 자산 가치 유지
  for (let i = 1; i < totalDays; i++) {
    if (equityCurve[i] === 1.0 && equityCurve[i-1] !== 1.0) {
      equityCurve[i] = equityCurve[i-1];
    }
  }

  // MDD 계산 (복리용)
  let peak = -Infinity;
  let maxDdown = 0;
  for (let i = 0; i < totalDays; i++) {
    if (equityCurve[i] > peak) peak = equityCurve[i];
    const ddown = (equityCurve[i] - peak) / peak;
    if (ddown < maxDdown) maxDdown = ddown;
  }

  // 🚀 [신규] 단리 기준 리스크 지표 계산 (매매별 수익률 분포 기준)
  let simpleMdd = 0;
  let simpleSharpe = 0;
  let simpleSortino = 0;
  
  if (trades.length > 0) {
    // 1. 단리 MDD (산술 누적 곡선 기준)
    let currentSum = 0;
    let simplePeak = 0; // 0%에서 시작
    let maxDraw = 0;
    trades.forEach(t => {
      currentSum += (t.pnl || 0);
      if (currentSum > simplePeak) simplePeak = currentSum;
      const draw = currentSum - simplePeak;
      if (draw < maxDraw) maxDraw = draw;
    });
    simpleMdd = Math.abs(maxDraw);

    // 2. 단리 샤프/소르티노 (매매 결과 분포 기준)
    const pnlValues = trades.map(t => t.pnl || 0);
    const avgP = pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length;
    const stdP = Math.sqrt(pnlValues.reduce((a, b) => a + Math.pow(b - avgP, 2), 0) / pnlValues.length);
    const downP = Math.sqrt(pnlValues.filter(v => v < 0).reduce((a,b) => a + Math.pow(b, 2), 0) / pnlValues.length);
    
    if (stdP > 0) simpleSharpe = avgP / stdP; // 매매당 샤프
    if (downP > 0) simpleSortino = avgP / downP;
  }

  // Sharpe / Sortino 계산 (복리용 - 일별 수익률 기준)
  let sharpe = 0;
  let sortino = 0;
  if (dailyReturns.length > 5) {
    const avgRet = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const stdDev = Math.sqrt(dailyReturns.reduce((a, b) => a + Math.pow(b - avgRet, 2), 0) / dailyReturns.length);
    const downsideDev = Math.sqrt(dailyReturns.filter(r => r < 0).reduce((a, b) => a + Math.pow(b, 2), 0) / dailyReturns.length);
    
    if (stdDev > 0) sharpe = (avgRet / stdDev) * Math.sqrt(252);
    if (downsideDev > 0) sortino = (avgRet / downsideDev) * Math.sqrt(252);
  }

  const resultCompounded = (compoundMulti - 1) * 100;
  const resultSimple = cumulativePnl;
  
  // RoMaD 계산 (모드별 대응)
  const romadComp = Math.abs(maxDdown) > 0 ? (resultCompounded / (Math.abs(maxDdown) * 100)) : 0;
  const romadSimple = simpleMdd > 0 ? (resultSimple / simpleMdd) : 0;

  return {
    success: successCount,
    total: totalSignals,
    winRate: totalSignals > 0 ? (successCount / totalSignals * 100) : 0,
    pnl: resultCompounded,
    simplePnl: resultSimple,
    buyAndHoldPnl,
    diffPnl: (SimState.pnlType === 'simple' ? resultSimple : resultCompounded) - buyAndHoldPnl,
    pnlAvg,
    trades,
    mdd: maxDdown * 100,
    simpleMdd: simpleMdd,
    sharpe,
    simpleSharpe,
    sortino,
    simpleSortino,
    romad: romadComp,
    simpleRomad: romadSimple,
    lastSignalDate: trades.length > 0 ? trades[trades.length - 1].buyDate : null
  };
}

/* ── 펀더멘털 → SimState.fundamentals 동기화
 * watchData에 이미 포함된 펀더멘털 값을 SimState.fundamentals에 반영.
 * (API /api/stock 응답에 펀더멘털이 포함되므로 별도 배치 조회 불필요)
 * ────────────────────────────────────────────────────────────────── */
function _syncFundamentalsFromWatchData() {
  for (const [code, data] of Object.entries(SimState.watchData)) {
    if (!data) continue;
    const fd = {
      trailingPE: data.trailingPE ?? null,
      forwardPE: data.forwardPE ?? null,
      pbr: data.pbr ?? null,
      evToEbitda: data.evToEbitda ?? null,
      dividendYield: data.dividendYield ?? null,
      eps: data.eps ?? null,
      beta: data.beta ?? null,
      sector: data.sector ?? null,
    };
    const cacheKey = code.replace(/\.(KS|KQ)$/, '');
    SimState.fundamentals[code] = fd;
    SimState.fundamentals[cacheKey] = fd;
    if (/^\d{5,6}$/.test(cacheKey)) {
      SimState.fundamentals[cacheKey + '.KS'] = fd;
    }
  }
}

// 하위 호환 — app.js 내 일부 코드가 참조
async function _fetchAllFundamentals(stocks) {
  _syncFundamentalsFromWatchData();
}

/* ── 이름 교정: API에서 가져온 정제된 이름이 저장된 이름과 다르면 서버 업데이트 ── */
function _fixStockNameIfNeeded(code, cleanName) {
  if (!cleanName || cleanName.length === 0) return;
  // Storage._tabs 내 stock.name과 비교하여 다르면 서버+메모리 동시 갱신
  // (Storage.updateStockName이 _tabs 메모리도 함께 수정)
  Storage.updateStockName(code, cleanName).catch(e =>
    console.warn('[이름교정]', code, e?.message)
  );
}


/* ══════════════════════════════════════════════
   오늘의 신호 탐색 (Scanner)
══════════════════════════════════════════════ */
async function runTodayScan() {
  const stocks = getSelectedStocks();
  if (!stocks.length) {
    showToast('탐색할 종목이 없습니다. 관심을 먼저 등록하세요.', 'warn');
    return;
  }

  // BB 방향(이탈/돌파) 모두 미선택 시 경고
  if (SimState.bbFilterActive && !SimState.bbCrossDown && !SimState.bbCrossUp) {
    showToast('BB 필터 사용 시 이탈 또는 돌파 방향을 하나 이상 선택하세요.', 'warn');
    return;
  }

  const btn = document.getElementById('btnTodayScan');
  if (btn) {
    btn.disabled = true;
    btn.style.background = '#081640';
    btn.style.boxShadow = 'none';
    btn.innerHTML = `<i class="fas fa-sync-alt fa-spin"></i> 0/...`;
  }

  SimState.simStarted = true;
  SimState.todayMode = true;
  SimState.simResults = {};

  try {
    // 1. 데이터 로드 (Batch)
    let done = 0;
    const CHUNK_SIZE = 100;
    for (let i = 0; i < stocks.length; i += CHUNK_SIZE) {
      const chunk = stocks.slice(i, i + CHUNK_SIZE);
      await API.fetchBatch(chunk, SimState.candleCount, SimState.listInterval, (code, res, err) => {
        done++;
        if (res) {
          const analyzed = Indicators.analyzeAll(res, 20, _getIndicatorOpts());
          SimState.watchData[code] = analyzed;
        }
        if (btn) btn.innerHTML = `<i class="fas fa-sync-alt fa-spin"></i> ${done}/${stocks.length}`;
      });
    }

    // 2. 전역 최종 날짜(LastDate) 찾기
    let globalLastDate = "";
    stocks.forEach(s => {
      const data = SimState.watchData[s.code];
      if (data && data.candlesWithBB && data.candlesWithBB.length > 0) {
        const last = data.candlesWithBB[data.candlesWithBB.length - 1].date;
        if (last > globalLastDate) globalLastDate = last;
      }
    });

    if (!globalLastDate) {
      showToast('분석 가능한 데이터가 없습니다.', 'error');
      return;
    }

    const win = SimState.simSignalWindow;

      // 3. 각 종목별 당일 신호 체크
      stocks.forEach(stock => {
        const data = SimState.watchData[stock.code];
        if (!data || !data.candlesWithBB) return;

        // 🚀 핵심 수정: 중복 하드코딩된 신호 판별 부분을 제거하고 백테스터 엔진을 직접 호출해 재사용 (DRY 원칙 준수)
        const fullRes = _calculateTotalSim(data);
        if (!fullRes || !fullRes.trades || fullRes.trades.length === 0) return;

        const lastTrade = fullRes.trades[fullRes.trades.length - 1];
        
        // 시뮬레이터가 계산한 마지막 시그널일이 전체의 마지막 거래일(Today)과 일치하면 오늘자 신호로 간주
        if (lastTrade.sigDate === globalLastDate) {
          SimState.simResults[stock.code] = {
            ...fullRes,
            todaySignal: lastTrade.reason.replace('(대기)', '').replace('(In)', ''), // UI 표시용 다듬기
            isTodaySub: true
          };
        }
      });

    renderList();
    const foundCount = Object.keys(SimState.simResults).length;
    showToast(`${globalLastDate} 기준 ${foundCount}개 종목 신호 포착 및 분석 완료`, 'success');
  } catch (e) {
    console.error(e);
    showToast('탐색 중 오류 발생: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.background = '#1e40af';
      btn.innerHTML = '오늘 검색';
      _updateRunButtonsState(); // 필터 유무에 따른 추가 검증
    }
  }
}


/* ══════════════════════════════════════════════
   우단 리스트 렌더링
══════════════════════════════════════════════ */
function renderList() {
  syncColumnWidthsFromStorage();

  const anyFilter = SimState.bbFilterActive || SimState.eomFilterActive || SimState.rsiFilterActive || SimState.stochFilterActive;
  const listEl = document.getElementById('stockList');
  const emptyEl = document.getElementById('emptyState');

  // 시뮬레이션 버튼이 선택되기 전에는 리스트를 비워둠
  if (!SimState.simStarted) {
    const listEl = document.getElementById('stockList');
    const emptyEl = document.getElementById('emptyState');
    if (listEl) listEl.innerHTML = '';
    if (emptyEl) {
      emptyEl.style.display = 'flex';
      const hint = emptyEl.querySelector('.empty-hint');
      if (hint) hint.textContent = '지표 시뮬레이션 시작 버튼을 클릭하여 분석을 시작하세요.';
    }
    updateStockCount(0);
    return;
  }

  // 🚀 핵심: 선택된 종목(박제) vs 나머지 분리
  const allStocks = getSelectedStocks(); // 전체 원본 종목
  const pinnedSet = new Set(SimState.selectedCodes);

  // 1) 박제된 종목 그룹: 지표 신호(total > 0) 상관없이 무조건 상단 유지 및 순서 고정
  const pinnedList = SimState.selectedCodes
    .map(code => allStocks.find(s => s.code === code))
    .filter(Boolean);

  // 2) 나머지 종목 그룹: 지표 조건 필터링 및 현재 정렬 기준 적용
  let remainingList = allStocks.filter(stock => {
    if (pinnedSet.has(stock.code)) return false; // 상단 박제된 건 제외
    const res = SimState.simResults[stock.code];
    return res && res.total > 0; // 신호가 있는 놈만 
  });

  // 나머지 종목에 대해서만 정렬 수행
  if (SimState.sortCol) {
    remainingList = sortList(remainingList, SimState.sortCol, SimState.sortDir);
  } else {
    remainingList.sort((a, b) => {
      const ra = SimState.simResults[a.code], rb = SimState.simResults[b.code];
      if (ra && rb) {
        if (rb.pnl !== ra.pnl) return rb.pnl - ra.pnl; // 수익률 내림차순
        if (rb.diffPnl !== ra.diffPnl) return rb.diffPnl - ra.diffPnl; 
        const rateA = ra.success / ra.total, rateB = rb.success / rb.total;
        return rateB - rateA;
      }
      return (a.name || a.code).localeCompare(b.name || b.code);
    });
  }

  // 3) 최종 결합: [선택/박제 종목들] + [조건에 부합하는 나머지 정렬 종목들]
  const finalDisplayList = [...pinnedList, ...remainingList];

  updateStockCount(finalDisplayList.length);

  if (!finalDisplayList.length) {
    listEl.innerHTML = '';
    if (emptyEl) {
      emptyEl.style.display = 'flex';
      const hint = emptyEl.querySelector('.empty-hint');
      if (hint) hint.textContent = anyFilter ? '조건에 맞는 종목이 없습니다.' : '종목을 등록하세요.';
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  listEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  
  finalDisplayList.forEach((stock, idx) => {
    const data = SimState.watchData[stock.code];
    const isPinned = pinnedSet.has(stock.code);
    frag.appendChild(buildListItem(stock, data, idx + 1, isPinned));
  });
  listEl.appendChild(frag);

  if (SimState.previewCode) highlightActiveRow(SimState.previewCode);
}

/* ── 리스트 행 생성 ── */
function buildListItem(stock, data, rowNum, isPinned) {
  const item = document.createElement('div');
  item.className = 'stock-item' + (isPinned ? ' row-pinned' : '');
  item.dataset.code = stock.code;

  let simCountStr = '--';
  let simPnlStr = '--';
  let pnlClass = '';
  let simBHStr = '--';
  let bhClass = '';

  const res = SimState.simResults[stock.code];
  
  if (res) {
    simCountStr = `${res.success}/${res.total}`;
    
    // 🚀 신규: 비교수익률 (전략 - 단순보유) - 소수점 제거
    const diff = res.diffPnl || 0;
    const diffClass = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
    const simDiffStr = res.total > 0 ? `${diff >= 0 ? '+' : ''}${Math.trunc(diff)}%` : '--';

    const pnl = (SimState.pnlType === 'simple' ? res.simplePnl : res.pnl) || 0;
    pnlClass = pnl > 0 ? 'up' : pnl < 0 ? 'down' : '';
    simPnlStr = `${pnl >= 0 ? '+' : ''}${Math.trunc(pnl)}%`;

    const avgPnl = res.pnlAvg || 0;
    const avgClass = avgPnl > 0 ? 'up' : avgPnl < 0 ? 'down' : '';
    const simAvgStr = `${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%`;

    const bh = res.buyAndHoldPnl || 0;
    bhClass = bh > 0 ? 'up' : bh < 0 ? 'down' : '';
    simBHStr = res.total > 0 ? `${bh >= 0 ? '+' : ''}${Math.trunc(bh)}%` : '--';
    
    if (SimState.todayMode && res.todaySignal) {
      simCountStr += `<div style="font-size:9px; color:var(--accent); margin-top:1px;">${res.todaySignal}</div>`;
    }

    const mddVal = (SimState.pnlType === 'simple' ? res.simpleMdd : res.mdd) || 0;
    const shaVal = (SimState.pnlType === 'simple' ? res.simpleSharpe : res.sharpe) || 0;
    const stnVal = (SimState.pnlType === 'simple' ? res.simpleSortino : res.sortino) || 0;
    const rmdVal = (SimState.pnlType === 'simple' ? res.simpleRomad : res.romad) || 0;

    item.innerHTML = `
      <div class="col-idx">${rowNum || ''}</div>
      <div class="col-name">
        <span class="item-name">${data?.name || stock.name || stock.code}</span>
      </div>
      <div class="col-item col-sim-count">${simCountStr}</div>
      <div class="col-item col-sim-pnl ${pnlClass}">${simPnlStr}</div>
      <div class="col-item col-sim-avg ${avgClass}">${simAvgStr}</div>
      <div class="col-item col-sim-bh ${bhClass}">${simBHStr}</div>
      <div class="col-item col-sim-diff ${diffClass}">${simDiffStr}</div>
      <div class="col-item col-sim-mdd down">${Math.trunc(mddVal)}%</div>
      <div class="col-item col-sim-sha">${shaVal.toFixed(1)}</div>
      <div class="col-item col-sim-stn">${stnVal.toFixed(1)}</div>
      <div class="col-item col-sim-rmd">${rmdVal.toFixed(1)}</div>`;
  } else {
    // 결과 없을 때 기본값
    item.innerHTML = `
      <div class="col-idx">${rowNum || ''}</div>
      <div class="col-name">
        <span class="item-name">${data?.name || stock.name || stock.code}</span>
      </div>
      <div class="col-item col-sim-count">--</div>
      <div class="col-item col-sim-pnl">--</div>
      <div class="col-item col-sim-avg">--</div>
      <div class="col-item col-sim-bh">--</div>
      <div class="col-item col-sim-diff">--</div>
      <div class="col-item col-sim-mdd">--</div>
      <div class="col-item col-sim-sha">--</div>
      <div class="col-item col-sim-stn">--</div>
      <div class="col-item col-sim-rmd">--</div>`;
  }

  item.addEventListener('click', e => {
    // 🚀 Ctrl 키가 눌려있으면: 박제(Multi Select) 토글
    if (e.ctrlKey) {
      const codeIdx = SimState.selectedCodes.indexOf(stock.code);
      if (codeIdx > -1) {
        SimState.selectedCodes.splice(codeIdx, 1);
      } else {
        SimState.selectedCodes.push(stock.code);
      }
      _updateRunButtonsState(); // 최적조건 버튼 활성화 상태 갱신
      renderList(); // 박제 위치 조정을 위해 재렌더링
    } else {
      // 일반 클릭
      // 🚀 개별 종목 최적화 데이터가 있다면, 클릭한 종목 전용 세팅으로 UI 변신
      if (SimState.optResults && SimState.optResults[stock.code]) {
        const combo = SimState.optResults[stock.code];
        Object.assign(SimState, combo);
        SimState.holdDaysActive = false;
        SimState.targetProfitActive = false;
        SimState.bbFilterThreshold = 0;
        
        syncUIToState(combo);
        _updateRunButtonsState();
        
        // 전체 리스트 재계산 (단, optResults가 있는 박제 종목들의 최고 기록은 _markSimDirty 내부에서 보호됨)
        _markSimDirty(true); // 보호막 유지
      }
      
      showStockPreview(stock.code);
      highlightActiveRow(stock.code);
      
      if (SimState.optResults && SimState.optResults[stock.code]) {
        renderList(); // 재계산된 점수판 반영
      }
    }
  });
  return item;
}

function highlightActiveRow(code) {
  const container = document.getElementById('stockList');
  if (!container) return;
  container.querySelectorAll('.stock-item').forEach(el =>
    el.classList.toggle('row-active', el.dataset.code === code)
  );
}

function updateStockCount(count) {
  const finalCount = count !== undefined ? count : 0;
  document.getElementById('stockCount').textContent = finalCount;
}

/* ── 특정 행만 증분 갱신 (새로고침 중 즉시 반영) ── */
function _refreshListItem(code) {
  const el = document.querySelector(`.stock-item[data-code="${code}"]`);
  if (!el) return;

  const data = SimState.watchData[code];

  // 이름/코드 갱신
  if (data?.name) {
    const nameEl = el.querySelector('.item-name');
    if (nameEl) nameEl.textContent = data.name;
  }
  if (data?.ticker) {
    const codeEl = el.querySelector('.item-code');
    if (codeEl) codeEl.textContent = data.ticker;
  }

  // 시뮬레이션 결과 갱신
  const sim = SimState.simResults[code];
  const countEl = el.querySelector('.col-sim-count');
  if (countEl) countEl.innerHTML = sim ? `${sim.success}/${sim.total}${SimState.todayMode && sim.todaySignal ? `<div style="font-size:9px; color:var(--accent); margin-top:1px;">${sim.todaySignal}</div>` : ''}` : '--';
  
  const pnlEl = el.querySelector('.col-sim-pnl');
  if (pnlEl) {
    const pnl = (SimState.pnlType === 'simple' ? sim?.simplePnl : sim?.pnl) ?? 0;
    pnlEl.textContent = sim ? (pnl >= 0 ? '+' : '') + Math.trunc(pnl) + '%' : '--';
    pnlEl.className = `col-item col-sim-pnl ${sim ? (pnl >= 0 ? 'up' : 'down') : ''}`;
  }
  const avgEl = el.querySelector('.col-sim-avg');
  if (avgEl) {
    const avg = sim?.pnlAvg ?? 0;
    avgEl.textContent = sim ? (avg >= 0 ? '+' : '') + avg.toFixed(1) + '%' : '--';
    avgEl.className = `col-item col-sim-avg ${sim ? (avg >= 0 ? 'up' : 'down') : ''}`;
  }
  const bhEl = el.querySelector('.col-sim-bh');
  if (bhEl) {
    const bh = sim?.buyAndHoldPnl ?? 0;
    bhEl.textContent = sim && sim.total > 0 ? (bh >= 0 ? '+' : '') + Math.trunc(bh) + '%' : '--';
    bhEl.className = `col-item col-sim-bh ${sim && sim.total > 0 ? (bh >= 0 ? 'up' : 'down') : ''}`;
  }
  const diffEl = el.querySelector('.col-sim-diff');
  if (diffEl) {
    const diff = sim?.diffPnl ?? 0;
    diffEl.textContent = sim && sim.total > 0 ? (diff >= 0 ? '+' : '') + Math.trunc(diff) + '%' : '--';
    diffEl.className = `col-item col-sim-diff ${sim && sim.total > 0 ? (diff >= 0 ? 'up' : 'down') : ''}`;
  }

  // 🚀 리스크 지표 추가 갱신
  const mddEl = el.querySelector('.col-sim-mdd');
  if (mddEl) {
    const val = (SimState.pnlType === 'simple' ? sim?.simpleMdd : sim?.mdd) || 0;
    mddEl.textContent = sim ? Math.trunc(val) + '%' : '--';
  }
  const shaEl = el.querySelector('.col-sim-sha');
  if (shaEl) {
    const val = (SimState.pnlType === 'simple' ? sim?.simpleSharpe : sim?.sharpe) || 0;
    shaEl.textContent = sim ? val.toFixed(1) : '--';
  }
  const stnEl = el.querySelector('.col-sim-stn');
  if (stnEl) {
    const val = (SimState.pnlType === 'simple' ? sim?.simpleSortino : sim?.sortino) || 0;
    stnEl.textContent = sim ? val.toFixed(1) : '--';
  }
  const rmdEl = el.querySelector('.col-sim-rmd');
  if (rmdEl) {
    const val = (SimState.pnlType === 'simple' ? sim?.simpleRomad : sim?.romad) || 0;
    rmdEl.textContent = sim ? val.toFixed(1) : '--';
  }
}

/* ══════════════════════════════════════════════
   종목 행 드래그 정렬
══════════════════════════════════════════════ */


/* ══════════════════════════════════════════════
   정렬
══════════════════════════════════════════════ */
function initSortHeaders() {
  document.querySelectorAll('.sort-col').forEach(span => {
    span.addEventListener('click', e => {
      e.stopPropagation();
      const col = span.dataset.col;
      if (SimState.sortCol === col) SimState.sortDir = SimState.sortDir === 'asc' ? 'desc' : 'asc';
      else { SimState.sortCol = col; SimState.sortDir = col === 'alert' ? 'desc' : 'asc'; }
      updateSortIcons(); renderList();
    });
  });
}

function sortList(list, col, dir) {
  return [...list].sort((a, b) => {
    const da = SimState.watchData[a.code], db = SimState.watchData[b.code];
    const ra = SimState.simResults[a.code], rb = SimState.simResults[b.code];
    let va, vb;
    switch (col) {
      // ── 기본 컬럼 ──
      case 'alert': va = da?.alert?.level ?? -1; vb = db?.alert?.level ?? -1; break;
      case 'name': va = (da?.name || a.code).toLowerCase(); vb = (db?.name || b.code).toLowerCase(); break;
      case 'price': va = da?.currentPrice ?? -Infinity; vb = db?.currentPrice ?? -Infinity; break;
      case 'sector': va = (SimState.fundamentals[a.code]?.sector || '').toLowerCase();
        vb = (SimState.fundamentals[b.code]?.sector || '').toLowerCase(); break;
      // ── 시뮬 결과 컬럼 ──
      case 'simCount': va = ra?.total ?? -1; vb = rb?.total ?? -1; break;
      case 'simWinRate': va = ra?.winRate ?? -Infinity; vb = rb?.winRate ?? -Infinity; break;
      case 'simDiff': va = ra?.diffPnl ?? -Infinity; vb = rb?.diffPnl ?? -Infinity; break;
      case 'simPnl': 
        va = (SimState.pnlType === 'simple' ? ra?.simplePnl : ra?.pnl) ?? -Infinity; 
        vb = (SimState.pnlType === 'simple' ? rb?.simplePnl : rb?.pnl) ?? -Infinity; 
        break;
      case 'simBH': va = ra?.buyAndHoldPnl ?? -Infinity; vb = rb?.buyAndHoldPnl ?? -Infinity; break;
      case 'simMDD': 
        va = (SimState.pnlType === 'simple' ? ra?.simpleMdd : ra?.mdd) ?? 0; 
        vb = (SimState.pnlType === 'simple' ? rb?.simpleMdd : rb?.mdd) ?? 0; 
        break;
      case 'simSHA': 
        va = (SimState.pnlType === 'simple' ? ra?.simpleSharpe : ra?.sharpe) ?? -Infinity; 
        vb = (SimState.pnlType === 'simple' ? rb?.simpleSharpe : rb?.sharpe) ?? -Infinity; 
        break;
      case 'simSTN': 
        va = (SimState.pnlType === 'simple' ? ra?.simpleSortino : ra?.sortino) ?? -Infinity; 
        vb = (SimState.pnlType === 'simple' ? rb?.simpleSortino : rb?.sortino) ?? -Infinity; 
        break;
      case 'simRMD': 
        va = (SimState.pnlType === 'simple' ? ra?.simpleRomad : ra?.romad) ?? -Infinity; 
        vb = (SimState.pnlType === 'simple' ? rb?.simpleRomad : rb?.romad) ?? -Infinity; 
        break;
      case 'simAvgPnl': va = ra?.pnlAvg ?? -Infinity; vb = rb?.pnlAvg ?? -Infinity; break;
      case 'simLastDate': va = ra?.lastSignalDate ?? ''; vb = rb?.lastSignalDate ?? ''; break;
      // ── 레거시 컬럼 (다른 탭과 공유되는 sortList 호환) ──
      case 'todayChg': va = da?.todayChangePct ?? -Infinity; vb = db?.todayChangePct ?? -Infinity; break;
      case 'change': va = da?.changePct ?? -Infinity; vb = db?.changePct ?? -Infinity; break;
      case 'bbRatio': va = da?.bbRatio ?? -1; vb = db?.bbRatio ?? -1; break;
      case 'trailPE': va = SimState.fundamentals[a.code]?.trailingPE ?? -Infinity; vb = SimState.fundamentals[b.code]?.trailingPE ?? -Infinity; break;
      case 'forwardPE': va = SimState.fundamentals[a.code]?.forwardPE ?? -Infinity; vb = SimState.fundamentals[b.code]?.forwardPE ?? -Infinity; break;
      case 'pbr': va = SimState.fundamentals[a.code]?.pbr ?? -Infinity; vb = SimState.fundamentals[b.code]?.pbr ?? -Infinity; break;
      case 'evEbitda': va = SimState.fundamentals[a.code]?.evToEbitda ?? -Infinity; vb = SimState.fundamentals[b.code]?.evToEbitda ?? -Infinity; break;
      case 'divYield': va = SimState.fundamentals[a.code]?.dividendYield ?? -Infinity; vb = SimState.fundamentals[b.code]?.dividendYield ?? -Infinity; break;
      case 'eps': va = SimState.fundamentals[a.code]?.eps ?? -Infinity; vb = SimState.fundamentals[b.code]?.eps ?? -Infinity; break;
      case 'beta': va = SimState.fundamentals[a.code]?.beta ?? -Infinity; vb = SimState.fundamentals[b.code]?.beta ?? -Infinity; break;
      case 'corrPos': va = da?.correlations?.pos?.val ?? -Infinity; vb = db?.correlations?.pos?.val ?? -Infinity; break;
      case 'corrNeu': va = da?.correlations?.neu?.val ?? -Infinity; vb = db?.correlations?.neu?.val ?? -Infinity; break;
      case 'corrNeg': va = da?.correlations?.neg?.val ?? -Infinity; vb = db?.correlations?.neg?.val ?? -Infinity; break;
      default: return 0;
    }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function updateSortIcons() {
  document.querySelectorAll('.sort-col').forEach(th => {
    const col = th.dataset.col;
    const el = th.querySelector('.sort-icon');
    if (!el) return;
    el.innerHTML = SimState.sortCol === col
      ? (SimState.sortDir === 'asc'
        ? '<i class="fas fa-sort-up active-sort"></i>'
        : '<i class="fas fa-sort-down active-sort"></i>')
      : '<i class="fas fa-sort"></i>';
  });
}

/* ══════════════════════════════════════════════
   컬럼 리사이저
══════════════════════════════════════════════ */
function initColResizers() {
  const CSS = {
    name: '--sim-col-name',
    simCount: '--sim-col-count',
    simPnl: '--sim-col-pnl',
    simAvg: '--sim-col-avg',
    simBH: '--sim-col-bh',
    simDiff: '--sim-col-diff',
    simMDD: '--sim-col-mdd',
    simSHA: '--sim-col-sha',
    simSTN: '--sim-col-stn',
    simRMD: '--sim-col-rmd',
  };
  const MIN = {
    name: 80, simCount: 44, simPnl: 40, simBH: 40, simDiff: 40, simMDD: 40, simSHA: 36, simSTN: 36, simRMD: 36
  };

  document.querySelectorAll('.col-resizer').forEach(h => {
    const key = h.dataset.col, v = CSS[key];
    if (!v) return;
    let sx = 0, sw = 0;
    h.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      h.classList.add('dragging');
      sw = parseInt(getComputedStyle(document.documentElement).getPropertyValue(v), 10) || 80;
      sx = e.clientX;
      
      const mv = ev => {
        document.documentElement.style.setProperty(v, Math.max(MIN[key] || 40, sw + ev.clientX - sx) + 'px');
        Charts.resizeAll();
      };
      const up = async () => {
        h.classList.remove('dragging');
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);

        // 리사이즈 완료 시 모든 컬럼의 현재 '계산된' 너비 추출하여 저장
        // 지표발굴 탭은 별도 고정 탭이 없으므로 'simulation' 이라는 가상 ID에 저장하거나
        // 현재 활성 그룹(simGroupSelect)에 저장함. 여기서는 그룹별로 다를 수 있으므로 activeTabId 사용.
        const select = document.getElementById('simGroupSelect');
        const activeTabId = (select && select.value !== 'all') ? select.value : Storage.getActiveTabId();
        if (!activeTabId) return;

        const widths = {};
        const rootStyle = getComputedStyle(document.documentElement);

        Object.entries(CSS).forEach(([k, varName]) => {
          const val = rootStyle.getPropertyValue(varName).trim();
          if (val) widths[k] = val;
        });

        await Storage.updateColumnWidths(activeTabId, widths);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  });
}

/** 저장된 너비를 현재 탭 설정에서 불러와 적용 */
function syncColumnWidthsFromStorage() {
  const select = document.getElementById('simGroupSelect');
  const activeTabId = (select && select.value !== 'all') ? select.value : Storage.getActiveTabId();
  const activeTab = Storage.getTabs().find(t => t.uid === activeTabId);
  if (!activeTab || !activeTab.column_widths) return;

  const CSS_VARS = {
    name: '--sim-col-name',
    simCount: '--sim-col-count',
    simPnl: '--sim-col-pnl',
    simAvg: '--sim-col-avg',
    simBH: '--sim-col-bh',
    simDiff: '--sim-col-diff',
    simMDD: '--sim-col-mdd',
    simSHA: '--sim-col-sha',
    simSTN: '--sim-col-stn',
    simRMD: '--sim-col-rmd',
  };

  Object.entries(activeTab.column_widths).forEach(([key, width]) => {
    const varName = CSS_VARS[key];
    if (varName && width) {
      document.documentElement.style.setProperty(varName, width);
    } else if (varName) {
      // 명시적 너비가 없으면 초기화 (기본값 사용)
      document.documentElement.style.removeProperty(varName);
    }
  });

  // 너비가 하나도 없는 경우 모든 변수 초기화
  if (Object.keys(activeTab.column_widths).length === 0) {
    Object.values(CSS_VARS).forEach(v => document.documentElement.style.removeProperty(v));
  }

  Charts.resizeAll();
}

/* ══════════════════════════════════════════════
   체크박스 / 삭제
══════════════════════════════════════════════ */
function initCheckAll() {
  const el = document.getElementById('checkAll');
  if (!el) return;
  el.addEventListener('change', e => {
    Storage.getWatchlist().forEach(s => {
      const cb = document.getElementById(`cb-${s.code}`);
      if (cb) cb.checked = e.target.checked;
      if (e.target.checked) SimState.checkedCodes.add(s.code);
      else SimState.checkedCodes.delete(s.code);
    });
  });
}
function syncCheckAll() {
  const cb = document.getElementById('checkAll');
  if (!cb) return;
  const total = Storage.getWatchlist().length;
  const checked = SimState.checkedCodes.size;
  cb.checked = total > 0 && checked === total;
  cb.indeterminate = checked > 0 && checked < total;
}



/* ══════════════════════════════════════════════
   모달
══════════════════════════════════════════════ */
function openModal(data) {
  const iLabel = data.interval === '1wk' ? '주봉' : '일봉';
  document.getElementById('modalTitle').textContent =
    `${data.name} (${data.code}) — ${iLabel} ${SimState.candleCount} 캔들`;
  document.getElementById('chartModal').style.display = 'flex';

  // 시뮬레이션 상세 기록 렌더링 (모달 전용)
  renderSimLog(data.code);

  setTimeout(() => Charts.renderModal('modalChart', data, SimState.simResults[data.code], SimState.simPeriodMonths), 60);
}
function initModal() {
  document.getElementById('modalClose').addEventListener('click', closeModal);
  document.getElementById('chartModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
}
function closeModal() {
  document.getElementById('chartModal').style.display = 'none';
  Charts.dispose('modalChart');
}

/* ══════════════════════════════════════════════
   종목 이동 / 복사
   ─ 행 우클릭 → 컨텍스트 메뉴
   ─ 체크 선택 후 상단 드롭다운 버튼
══════════════════════════════════════════════ */

/** 공유 컨텍스트 메뉴 DOM (한 개만 유지) */
let _ctxMenu = null;

function _getCtxMenu() {
  if (!_ctxMenu) {
    _ctxMenu = document.createElement('div');
    _ctxMenu.id = 'stockCtxMenu';
    _ctxMenu.className = 'stock-ctx-menu';
    document.body.appendChild(_ctxMenu);
    // 외부 클릭 시 닫기
    document.addEventListener('click', e => {
      if (!_ctxMenu.contains(e.target)) _hideCtxMenu();
    }, true);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') _hideCtxMenu();
    });
  }
  return _ctxMenu;
}

function _hideCtxMenu() {
  if (_ctxMenu) _ctxMenu.style.display = 'none';
}

/**
 * 컨텍스트 메뉴 표시
 * @param {number} x  - pageX
 * @param {number} y  - pageY
 * @param {string[]} codes - 대상 종목 코드 배열
 * @param {string} label - 메뉴 헤더 텍스트
 */
function _showCtxMenu(x, y, codes, label) {
  const tabs = Storage.getTabs();
  const othTabs = tabs.filter(t => t.uid !== Storage.getActiveTabId());
  if (!othTabs.length) {
    showToast('이동/복사할 다른 그룹이 없습니다.', 'warn');
    return;
  }

  const menu = _getCtxMenu();
  menu.innerHTML = `
    <div class="ctx-header">${label}</div>
      <div class="ctx-section-title"><i class="fas fa-arrow-right"></i> 이동</div>
    ${othTabs.map(t => `
      <button class="ctx-item ctx-move" data-tab="${t.uid}">
        <i class="fas fa-sign-out-alt"></i> ${t.name}
      </button>`).join('')
    }
    <div class="ctx-divider"></div>
    <div class="ctx-section-title"><i class="fas fa-copy"></i> 복사</div>
    ${othTabs.map(t => `
      <button class="ctx-item ctx-copy" data-tab="${t.uid}">
        <i class="fas fa-clone"></i> ${t.name}
      </button>`).join('')
    }
  `;

  // 이동 버튼 이벤트
  menu.querySelectorAll('.ctx-move').forEach(btn => {
    btn.addEventListener('click', async () => {
      _hideCtxMenu();
      const toTabUid = btn.dataset.tab;
      const toTab = Storage.getTabs().find(t => t.uid === toTabUid);
      const n = await Storage.moveStocks(codes, toTabUid);
      // 이동된 종목은 현재 탭 캐시에서 제거
      codes.forEach(c => { delete SimState.watchData[c]; Charts.dispose(`spark-${c}`); });
      SimState.checkedCodes.clear();
      renderList(); updateDeleteBtn();
      showToast(
        n > 0
          ? `✅ ${n}개 종목 → <b>${toTab?.name}</b> 이동 완료`
          : `이미 <b>${toTab?.name}</b> 에 존재하는 종목입니다.`,
        n > 0 ? 'success' : 'warn'
      );
    });
  });

  // 복사 버튼 이벤트
  menu.querySelectorAll('.ctx-copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      _hideCtxMenu();
      const toTabUid = btn.dataset.tab;
      const toTab = Storage.getTabs().find(t => t.uid === toTabUid);
      const n = await Storage.copyStocks(codes, toTabUid);
      showToast(
        n > 0
          ? `✅ ${n}개 종목 → <b>${toTab?.name}</b> 복사 완료`
          : `이미 <b>${toTab?.name}</b> 에 존재하는 종목입니다.`,
        n > 0 ? 'success' : 'warn'
      );
    });
  });

  // 위치 조정 (화면 밖으로 나가지 않도록)
  menu.style.display = 'block';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - mw - 8) + 'px';
  menu.style.top = Math.min(y, vh - mh - 8) + 'px';
}

/** 선택된 종목들에 대한 일괄 이동/복사 드롭다운 토글 */
function _toggleBulkDropdown(type, anchorEl) {
  // 기존 열린 메뉴 닫기
  const existing = document.getElementById('bulkDropdown');
  if (existing) { existing.remove(); return; }

  const codes = [...SimState.checkedCodes];
  if (!codes.length) return;

  const tabs = Storage.getTabs();
  const othTabs = tabs.filter(t => t.uid !== Storage.getActiveTabId());
  if (!othTabs.length) { showToast('이동/복사할 다른 그룹이 없습니다.', 'warn'); return; }

  const dd = document.createElement('div');
  dd.id = 'bulkDropdown';
  dd.className = 'bulk-dropdown';
  dd.innerHTML = othTabs.map(t => `
    <button class="bulk-dd-item" data-tab="${t.uid}">
      <i class="fas fa-${type === 'move' ? 'sign-out-alt' : 'clone'}"></i> ${t.name}
    </button>`).join('');

  dd.querySelectorAll('.bulk-dd-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      dd.remove();
      const toTabUid = btn.dataset.tab;
      const toTab = Storage.getTabs().find(t => t.uid === toTabUid);
      let n;
      if (type === 'move') {
        n = await Storage.moveStocks(codes, toTabUid);
        codes.forEach(c => { delete SimState.watchData[c]; Charts.dispose(`spark - ${c} `); });
        SimState.checkedCodes.clear();
        renderList(); updateDeleteBtn();
      } else {
        n = await Storage.copyStocks(codes, toTabUid);
      }
      showToast(
        n > 0
          ? `✅ ${n}개 종목 → <b>${toTab?.name}</b> ${type === 'move' ? '이동' : '복사'} 완료`
          : `이미 <b>${toTab?.name}</b> 에 존재하는 종목입니다.`,
        n > 0 ? 'success' : 'warn'
      );
    });
  });

  // 외부 클릭 시 닫기
  const outsideClick = e => {
    if (!dd.contains(e.target) && e.target !== anchorEl) {
      dd.remove(); document.removeEventListener('click', outsideClick, true);
    }
  };
  document.addEventListener('click', outsideClick, true);

  // 앵커 버튼 바로 아래에 위치
  const rect = anchorEl.getBoundingClientRect();
  dd.style.position = 'fixed';
  dd.style.top = (rect.bottom + 4) + 'px';
  dd.style.left = rect.left + 'px';
  document.body.appendChild(dd);
}

/** 각 행에 우클릭 이벤트 바인딩 */
function _bindRowContextMenu(row, stock) {
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    // 우클릭한 종목이 체크된 경우 → 체크된 전체 대상
    // 아닌 경우 → 우클릭 단일 종목
    const codes = SimState.checkedCodes.has(stock.code) && SimState.checkedCodes.size > 1
      ? [...SimState.checkedCodes]
      : [stock.code];
    const label = codes.length > 1
      ? `${codes.length}개 종목 선택`
      : `${stock.name || stock.code} `;
    _showCtxMenu(e.pageX, e.pageY, codes, label);
  });
}

// function initMoveButtons() { ... } 제거됨

/* ══════════════════════════════════════════════
   새로고침 버튼
══════════════════════════════════════════════ */

/* ══════════════════════════════════════════════
   인덱스(S&P, Nasdaq, Kospi) 동기화 버튼 공통 헬퍼
══════════════════════════════════════════════ */
// function initIndexSyncBtn() { ... } 제거됨

/* ══════════════════════════════════════════════
   키보드 네비게이션
══════════════════════════════════════════════ */
function initKeyboardNavigation() {
  window.addEventListener('keydown', e => {
    // 1. 입력창이 활성화된 경우 무시
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    // 3. 관심종목 탭이 활성 상태일 때만 작동 (다른 탭과의 간섭 방지)
    const filterTab = document.getElementById('tab-simulation');
    if (!filterTab || filterTab.classList.contains('hidden') || filterTab.style.display === 'none') return;

    // 🚀 매매 이력(History) 방향키 네비게이션
    if (SimState.historyActive && SimState.previewData && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const simRes = SimState.simResults[SimState.previewCode] || SimState.simResults[SimState.previewData.code];
      if (simRes && simRes.trades && simRes.trades.length > 0) {
        e.preventDefault();
        const maxIdx = simRes.trades.length - 1;
        if (e.key === 'ArrowUp') {
          SimState.selectedTradeIndex = Math.max(0, SimState.selectedTradeIndex - 1);
        } else {
          SimState.selectedTradeIndex = Math.min(maxIdx, SimState.selectedTradeIndex + 1);
        }
        renderSimHistory(simRes.trades);
        
        // 차트 갱신 (모든 차트에 인덱스 전달)
        Charts.renderMini('previewChart', SimState.previewData, simRes, SimState.simPeriodMonths, SimState.selectedTradeIndex);
        Charts.renderEOM('eomChart', SimState.previewData, simRes, SimState.simPeriodMonths, SimState.selectedTradeIndex);
        Charts.renderRSIStoch('rsiStochChart', SimState.previewData, simRes, SimState.simPeriodMonths, SimState.rsiOB, SimState.rsiOS, SimState.stochOB, SimState.stochOS, SimState.selectedTradeIndex);
        Charts.renderMACD('macdChart', SimState.previewData, simRes, SimState.simPeriodMonths, SimState.selectedTradeIndex);
        Charts.renderMFI('mfiChart', SimState.previewData, simRes, SimState.simPeriodMonths, SimState.mfiOB, SimState.mfiOS, SimState.selectedTradeIndex);
        return;
      }
    }

    // 4. 종목 리스트 방향키 네비게이션
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // 🚀 메인 리스트 탐색 (이력 영역이 활성화된 경우 건너뜀)
      if (SimState.historyActive) return;

      const listEl = document.getElementById('stockList');
      if (!listEl) return;
      
      // 메인 리스트 행이 명시적으로 선택되었거나, 이력 영역이 비활성일 때만 동작
      const items = Array.from(listEl.querySelectorAll('.stock-item'));
      if (!items.length) return;

      // 현재 활성화된 종목의 인덱스 찾기
      // (단순 previewCode 기반 검색은 중복 종목 시 문제를 일으키므로, 시각적 하이라이트 기준 우선)
      let currentIndex = items.findIndex(el => el.classList.contains('row-active'));
      if (currentIndex === -1 && SimState.previewCode) {
        currentIndex = items.findIndex(el => el.dataset.code === SimState.previewCode);
      }

      let nextIndex;
      if (e.key === 'ArrowDown') {
        if (currentIndex === -1) nextIndex = 0;
        else nextIndex = Math.min(items.length - 1, currentIndex + 1);
      } else { // ArrowUp
        if (currentIndex === -1) nextIndex = items.length - 1;
        else nextIndex = Math.max(0, currentIndex - 1);
      }

      if (nextIndex !== undefined && nextIndex !== currentIndex) {
        e.preventDefault();
        const targetItem = items[nextIndex];
        const targetCode = targetItem.dataset.code;

        // 미리보기 및 리스트 하이라이트 트리거
        showStockPreview(targetCode);
        highlightActiveRow(targetCode);

        // 스크롤 이동
        targetItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  });
}

/* ══════════════════════════════════════════════
   초기화
══════════════════════════════════════════════ */
async function init() {
  showGlobalLoading(true);
  try { await Storage.init(); }
  catch (e) { console.error('[App] Storage 초기화 실패:', e); }
  showGlobalLoading(false);

  initHeaderControls();
  initGroupSelect();
  initFilters();
  initSortHeaders();
  initColResizers();
  syncColumnWidthsFromStorage();
  initCheckAll();
  initModal();
  initKeyboardNavigation();


  renderList();

  // 🚀 시뮬레이션 탭은 수동 시작이므로 초기 로딩 시 백그라운드 전수 조사를 수행하지 않음
  // (필요한 경우만 개별 로드하거나, 시뮬레이션 시작 버튼 클릭 시 수행)
  console.log('[Init] 시뮬레이션 준비 완료. (수동 실행 대기)');
}

/**
 * 그룹 선택 풀다운 초기화
 */
function initGroupSelect() {
  const select = document.getElementById('simGroupSelect');
  if (!select) return;

  const tabs = Storage.getTabs();
  // "전체" 옵션과 함께 각 탭 목록 추가
  select.innerHTML = '<option value="all">전체</option>' +
    tabs.map(t => `<option value="${t.uid}">${t.name}</option>`).join('');

  // "한국" 그룹을 찾아서 기본값으로 설정
  const koreaTab = tabs.find(t => t.name === '한국');
  if (koreaTab) {
    select.value = koreaTab.uid;
  }

  select.addEventListener('change', async () => {
    const val = select.value;
    if (val !== 'all') {
      await Storage.setActiveTabId(val);
    }
    // 그룹 변경 시 컬럼 너비 재동기화
    syncColumnWidthsFromStorage();
    
    // 그룹 변경 시 시뮬레이션 초기화 (이전 그룹 결과 제거)
    SimState.simStarted = false;
    SimState.simResults = {};
    renderList();
  });
}

document.addEventListener('DOMContentLoaded', init);
/**
 * 시뮬레이션 이력 테이블 렌더링
 */
function renderSimHistory(trades) {
  const body = document.getElementById('simHistoryBody');
  if (!body) return;
  body.innerHTML = '';

  let simplePnlSum = 0;
  let compoundMulti = 1.0;
  trades.forEach((t, idx) => {
    simplePnlSum += (t.pnl || 0);
    compoundMulti *= (1 + (t.pnl || 0) / 100);
    const cumPnl = (SimState.pnlType === 'simple') ? simplePnlSum : (compoundMulti - 1) * 100;
    const row = document.createElement('tr');
    row.dataset.index = idx; // 인덱스 저장
    row.style.cursor = 'pointer';

    // 선택 상태 표시
    if (idx === SimState.selectedTradeIndex) {
      row.classList.add('active-row');
      row.style.background = 'rgba(59, 130, 246, 0.15)';
    }

    // 1. 날짜 표시 (다양한 날짜 포맷 대응: YYYY-MM-DD 또는 YYYY.MM.DD)
    const fmtDt = (s) => {
      if (!s) return '';
      const clean = s.replace(/\./g, '-'); // . 을 - 로 통일
      const parts = clean.split('-');
      if (parts.length >= 3) return `${parts[1]}.${parts[2]}`; // MM.DD
      return s;
    };
    const dateDisplay = t.isOpen 
      ? `<span class="log-date">${fmtDt(t.buyDate)}</span> <span style="font-size:10px; opacity:0.5;">~ing</span>` 
      : `<span class="log-date">${fmtDt(t.buyDate)}~${fmtDt(t.exitDate)}</span>`;

    // 2. 종료 사유(Out) 계산
    let exitCond = '';
    if (t.isOpen) {
      exitCond = '<span style="color:var(--text-muted)">진행중</span>';
    } else {
      // 🚀 신규: 저장된 exitReason이 있으면 우선 활용하고, 색상 매칭
      const reasonMap = { '목표가': 'up', 'EOM매도': 'up', '기간만료': 'muted' };
      const cls = reasonMap[t.exitReason] || '';
      exitCond = `<span class="log-pnl ${cls}">${t.exitReason || '종료'}</span>`;
    }

    // 🚀 '보유' 로직 수정: 첫 번째 매매의 매수가를 기준으로 고정
    const firstBuyPrice = trades[0].buyPrice;
    const targetPrice = t.isOpen 
      ? (SimState.previewData ? SimState.previewData.currentPrice : t.buyPrice) 
      : (t.exitPrice || t.buyPrice);
    
    const holdPnl = firstBuyPrice > 0 ? ((targetPrice - firstBuyPrice) / firstBuyPrice) * 100 : 0;

    // 🚀 신규: 가격 표시 (isUS 반영)
    const isUS = SimState.previewData ? SimState.previewData.isUS : false;
    const inPriceStr = fmtPrice(t.buyPrice, isUS);
    const outPriceStr = t.isOpen ? '--' : fmtPrice(t.exitPrice, isUS);

    row.innerHTML = `
      <td title="${t.buyDate} ~ ${t.exitDate || '진행중'}">${dateDisplay}</td>
      <td style="color:var(--up); font-weight:600;">${t.reason || '신호(In)'}</td>
      <td style="text-align: right; opacity: 0.9; font-size: 11px;">${inPriceStr}</td>
      <td style="text-align: right; opacity: 0.9; font-size: 11px;">${outPriceStr}</td>
      <td style="padding-left: 10px;">${exitCond}</td>
      <td class="log-pnl ${t.pnl >= 0 ? 'up' : 'down'}" style="text-align: right; font-weight:600;">
        ${t.pnl >= 0 ? '+' : ''}${Math.trunc(t.pnl)}%
      </td>
      <td class="log-pnl ${cumPnl >= 0 ? 'up' : 'down'}" style="text-align: right; font-weight:500;">
        ${cumPnl >= 0 ? '+' : ''}${Math.trunc(cumPnl)}%
      </td>
      <td class="log-pnl ${holdPnl >= 0 ? 'up' : 'down'}" style="text-align: right; opacity: 0.8; font-weight: 500;">
        ${holdPnl >= 0 ? '+' : ''}${Math.trunc(holdPnl)}%
      </td>
    `;

    // 클릭 이벤트: 차트 마커 강조
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      SimState.selectedTradeIndex = idx;
      SimState.historyActive = true;
      
      // 행 스타일 업데이트를 위해 재렌더링
      renderSimHistory(trades);
      
      // 차트 즉시 갱신
      const data = SimState.previewData;
      if (data) {
        // 🚀 키 불일치 방지: previewCode를 우선 참조하여 타점 증발 방지
        const simRes = SimState.simResults[SimState.previewCode] || SimState.simResults[data.code];
        Charts.renderMini('previewChart', data, simRes, SimState.simPeriodMonths, idx);
        Charts.renderEOM('eomChart', data, simRes, SimState.simPeriodMonths, idx);
        Charts.renderRSIStoch('rsiStochChart', data, simRes, SimState.simPeriodMonths, SimState.rsiOB, SimState.rsiOS, SimState.stochOB, SimState.stochOS, idx);
        Charts.renderMACD('macdChart', data, simRes, SimState.simPeriodMonths, idx);
        Charts.renderMFI('mfiChart', data, simRes, SimState.simPeriodMonths, SimState.mfiOB, SimState.mfiOS, idx);
      }
    });

    body.appendChild(row);
  });

  // 🚀 [최종 보유 행 추가] 최초 In 시점부터 DB상 마지막(현재) 시점까지의 보유 수익률
  if (trades.length > 0) {
    const firstBuyPrice = trades[0].buyPrice;
    const currentPrice = SimState.previewData ? SimState.previewData.currentPrice : 0;
    const totalHoldPnl = firstBuyPrice > 0 ? ((currentPrice - firstBuyPrice) / firstBuyPrice) * 100 : 0;
    
    const lastCandle = SimState.previewData && SimState.previewData.candles.length > 0 
      ? SimState.previewData.candles[SimState.previewData.candles.length - 1] 
      : null;
    const fmtDt = (s) => {
      if (!s) return '';
      const clean = s.replace(/\./g, '-');
      const parts = clean.split('-');
      if (parts.length >= 3) return `${parts[1]}.${parts[2]}`;
      return s;
    };
    const lastDateDisplay = lastCandle ? fmtDt(lastCandle.date) : '현재';

    const lastRow = document.createElement('tr');
    lastRow.className = 'summary-hold-row';
    lastRow.style.background = 'rgba(255, 255, 255, 0.05)';
    lastRow.style.borderTop = '1px dashed rgba(255, 255, 255, 0.2)';
    
    lastRow.innerHTML = `
      <td style="color:var(--text-muted); font-weight: 500;">최종 보유 (${lastDateDisplay})</td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td></td>
      <td class="log-pnl ${totalHoldPnl >= 0 ? 'up' : 'down'}" style="text-align: right; font-weight:700;">
        ${totalHoldPnl >= 0 ? '+' : ''}${Math.trunc(totalHoldPnl)}%
      </td>
    `;
    body.appendChild(lastRow);
  }

  // 스크롤을 활성 행으로 (키보드 네비게이션 시 유용)
  if (SimState.selectedTradeIndex !== -1) {
    const activeRow = body.querySelector(`.active-row`);
    if (activeRow && SimState.historyActive) {
      activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // 외부 클릭 시 이력 영역 활성 해제
  const wrap = body.closest('.sim-history-table-wrap');
  if (wrap) {
    if (!wrap.dataset.listenerBound) {
      wrap.addEventListener('click', () => { SimState.historyActive = true; });
      document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) SimState.historyActive = false;
      });
      wrap.dataset.listenerBound = 'true';
    }
  }
}
