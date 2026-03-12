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
  eomFilterActive: false,
  rsiFilterActive: false,
  // 시뮬레이션 파라미터
  simPeriodMonths: 6,
  simHoldingDays: 5,
  simTargetProfit: 5.0,
  simSignalWindow: 3,   // EOM/RSI 시그널 유효 윈도우 (일)
  simResults: {}, // code -> { success, total, winRate, pnl, trades }
  simStarted: false, // 시뮬레이션 시작 여부
  todayMode: false,  // 🚀 '오늘' 탐색 모드 여부
  simDirty: false,   // 파라미터 변경 후 재실행 필요 여부
  selectedTradeIndex: -1, // 선택된 시뮬레이션 거래 인덱스
  historyActive: false,    // 이력 영역 활성화 여부 (키보드 네비게이션용)
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
const fmtPct = n => (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%';

function fmtPrice(price, isUS) {
  if (isUS) return '$' + Number(price).toFixed(2);
  return fmt(Math.round(price)) + '원';
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

  // 정상 종료(success, info)인 경우 3초 후 자동 닫기
  if (type === 'success' || type === 'info') {
    setTimeout(() => {
      if (t.parentElement) {
        t.classList.remove('toast-show');
        setTimeout(() => t.remove(), 300);
      }
    }, 3000);
  }
}

/* ══════════════════════════════════════════════
   시뮬 파라미터 변경 → 재실행 유도 (Dirty 플래그)
══════════════════════════════════════════════ */
function _markSimDirty() {
  if (!SimState.simStarted) return;

  // 🚀 핵심: 설정이 바뀌면 이미 로드된 데이터를 기반으로 즉시 시뮬레이션 재계산
  // 이렇게 해야 차트의 마커와 리스트의 숫자가 항상 현재 설정과 일치하게 유지됨 (Orphan 마커 방지)
  Object.keys(SimState.watchData).forEach(code => {
    SimState.simResults[code] = _calculateTotalSim(SimState.watchData[code]);
  });

  renderList();

  // 현재 선택된 종목이 있다면 미리보기 차트도 즉시 갱신
  if (SimState.selectedStockCode) {
    showStockPreview(SimState.selectedStockCode);
  }

  if (SimState.simDirty) return;
  SimState.simDirty = true;
  const btn = document.getElementById('btnRunSim');
  if (btn) {
    btn.style.background = '#7c2d12';
    btn.style.boxShadow = 'none';
    btn.innerHTML = '다시 실행 필요';
  }
}

function _clearSimDirty() {
  SimState.simDirty = false;
  const btn = document.getElementById('btnRunSim');
  if (btn) {
    btn.style.background = '';
    btn.style.boxShadow = '';
    btn.innerHTML = '시작';
  }
}

/* ══════════════════════════════════════════════
   헤더 컨트롤 초기화
══════════════════════════════════════════════ */
function initHeaderControls() {
  SimState.previewInterval = '1d';
  SimState.listInterval = '1d';
  SimState.candleCount = 252; // 약 1년치

  // 시뮬레이션 버튼 바인딩
  const btnRun = document.getElementById('btnRunSim');
  if (btnRun) btnRun.addEventListener('click', () => {
    SimState.todayMode = false;
    runSimulation();
  });

  // 오늘 탐색 버튼 바인딩
  const btnToday = document.getElementById('btnTodayScan');
  if (btnToday) btnToday.addEventListener('click', () => {
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
    SimState.simTargetProfit = isNaN(v) ? 5.0 : v;
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

function initFilters() {
  const checkBB = document.getElementById('checkBBFilter');
  const inputBB = document.getElementById('inputBBThreshold');
  const checkEom = document.getElementById('checkEomFilter');
  const checkRsi = document.getElementById('checkRsiFilter');

  if (checkBB) {
    checkBB.addEventListener('change', () => {
      SimState.bbFilterActive = checkBB.checked;
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
      _markSimDirty();
      if (SimState.simStarted) renderList();
    });
    SimState.eomFilterActive = checkEom.checked;
  }
  if (checkRsi) {
    checkRsi.addEventListener('change', () => {
      SimState.rsiFilterActive = checkRsi.checked;
      _markSimDirty();
      if (SimState.simStarted) renderList();
    });
    SimState.rsiFilterActive = checkRsi.checked;
  }
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
    const analyzed = Indicators.analyzeAll(raw);
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

  ['eomSection', 'rsiStochSection'].forEach(id => {
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
    Charts.renderRSIStoch('rsiStochChart', data, simRes, SimState.simPeriodMonths);
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
    const analyzed = Indicators.analyzeAll(raw);
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
        const analyzed = Indicators.analyzeAll(res);
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
            const analyzed = Indicators.analyzeAll(res);
            const code = chunk[j].code;
            SimState.watchData[code] = analyzed;
            if (analyzed.name) _fixStockNameIfNeeded(code, analyzed.name);
          }
        });

        // 배치 처리 완료 후 화면 갱신 (프로그레시브 로딩)
        if (SimState.bbFilterActive || SimState.eomFilterActive || SimState.rsiFilterActive) {
          renderList();
        }

        // 브라우저 렌더링을 위해 숨 고르기
        await new Promise(r => setTimeout(r, 50));
      }
      _syncFundamentalsFromWatchData();
      if (SimState.bbFilterActive || SimState.eomFilterActive || SimState.rsiFilterActive) {
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
        const analyzed = Indicators.analyzeAll(res);
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
          const analyzed = Indicators.analyzeAll(res);
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
      btn.innerHTML = '다시 실행 필요';
    } else {
      btn.style.background = '';
      btn.style.boxShadow = '';
      btn.innerHTML = '시작';
    }
  }
}

function _calculateTotalSim(data) {
  if (!data || !data.candlesWithBB) return null;
  const candles = data.candlesWithBB;
  const totalDays = candles.length;

  // 🚀 현재일로부터 N개월 전 정확한 시작 날짜 계산
  const lastCandle = candles[totalDays - 1];
  const lastDate = new Date(lastCandle.date);
  const startDate = new Date(lastDate);
  startDate.setMonth(startDate.getMonth() - SimState.simPeriodMonths);

  // startDate보다 크거나 같은 첫 번째 캔들 인덱스 찾기
  let startIdx = 0;
  for (let i = 0; i < totalDays; i++) {
    if (new Date(candles[i].date) >= startDate) {
      startIdx = i;
      break;
    }
  }

  const endThreshold = totalDays - 1; 

  let totalSignals = 0;
  let successCount = 0;
  let cumulativePnl = 0; 
  const trades = [];
  const win = SimState.simSignalWindow; 

  let nextAllowedIdx = startIdx; 

  for (let i = startIdx; i <= endThreshold; i++) {
    if (i < nextAllowedIdx) continue; 

    const c = candles[i];
    if (!c.bbUpper || !c.bbLower) continue;

    // 1. 오늘의 시그널 조건 체크 (BB + EOM + RSI 교집합)
    let bbOk = true;
    if (SimState.bbFilterActive) {
      // 🚀 사용자의 '터치' 직관에 맞춰 Low(저가)를 기준으로 밴드 하단 이탈 체크
      // 오차를 방지하기 위해 c.bbLower가 유효한지 먼저 확인
      if (c.bbLower === null) {
        bbOk = false;
      } else {
        const dropPct = ((c.low - c.bbLower) / c.low) * 100;
        bbOk = dropPct <= (SimState.bbFilterThreshold + 0.001); // 부동소수점 오차 방어
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
        if (candles[i - k].rsiStSignal === 'BUY') { 
          rsiOk = true; 
          rsiSigIdx = i - k;
          break; 
        }
      }
    }

    // 2. 진입 결정 (오늘 확정 -> 내일 시가 매수)
    if (bbOk && eomOk && rsiOk) {
      // 🚀 신호 발생일(B) 추적: EOM/RSI 신호가 있으면 해당 날짜, 없으면 오늘(i)
      let sIdx = i;
      if (SimState.eomFilterActive && eomSigIdx !== -1) sIdx = eomSigIdx;
      else if (SimState.rsiFilterActive && rsiSigIdx !== -1) sIdx = rsiSigIdx;
      const sigDate = candles[sIdx].date;

      const buyIdx = i + 1;
      if (!candles[buyIdx]) continue;

      const buyPrice = candles[buyIdx].open;
      const buyDate = candles[buyIdx].date;

      let hitTarget = false;
      let isOpen = false;
      let actualExitIdx = -1;
      let exitPrice = 0;
      let exitDate = '';

      // 3. 보유 기간 중 목표가 도달 여부 감시 (고회전 모델)
      for (let j = 0; j < SimState.simHoldingDays; j++) {
        const checkIdx = buyIdx + j;
        if (!candles[checkIdx]) break;

        const dayHigh = candles[checkIdx].high;
        const profitAtHigh = ((dayHigh - buyPrice) / buyPrice) * 100;

        if (profitAtHigh >= SimState.simTargetProfit) {
          hitTarget = true;
          actualExitIdx = checkIdx;
          exitPrice = buyPrice * (1 + SimState.simTargetProfit / 100);
          exitDate = candles[checkIdx].date;
          break;
        }
      }

      // 4. 목표 미도달 시 만기(Expire) 또는 현재 보유 중 처리
      if (!hitTarget) {
        const lastIdx = Math.min(buyIdx + SimState.simHoldingDays - 1, totalDays - 1);
        actualExitIdx = lastIdx;
        exitPrice = candles[lastIdx].close;
        exitDate = candles[lastIdx].date;

        // 아직 보유 기간이 남았는데 데이터가 끝난 경우 -> '진행 중'으로 표시
        if (lastIdx === totalDays - 1 && (totalDays - 1 - buyIdx < SimState.simHoldingDays - 1)) {
          isOpen = true;
          exitPrice = candles[lastIdx].close; // 현재가로 가수익률 계산
          exitDate = null; // 아직 팔지 않음
        }
      }

      // 5. 수익 및 통계 기록
      let tradePnlPct = ((exitPrice - buyPrice) / buyPrice) * 100;
      totalSignals++; // 🚀 종료 여부와 상관없이 신호 발생 횟수 카운트
      
      if (hitTarget) {
        successCount++;
        tradePnlPct = SimState.simTargetProfit;
      }

      cumulativePnl += tradePnlPct; // 단리 합산

      // 진입 사유 요약
      const reasons = [];
      if (SimState.bbFilterActive) reasons.push('BB');
      if (SimState.eomFilterActive) reasons.push('EOM');
      if (SimState.rsiFilterActive) reasons.push('RSI');
      const reasonStr = (reasons.length > 0 ? reasons.join('+') : '시그널') + '(In)';

      trades.push({
        sigDate, // 🚀 실제 신호 발생일 저장
        buyDate,
        buyPrice,
        exitDate,
        exitPrice,
        pnl: tradePnlPct,
        isOpen,
        reason: reasonStr
      });

      // 🚀 고회전 핵심: 청산된 '당일' 종가부터 바로 새로운 시그널 탐색 가능
      // 단, '진행 중(isOpen)'인 경우에는 아직 돈이 묶여 있으므로 다음날까지 탐색 차단
      nextAllowedIdx = isOpen ? actualExitIdx + 1 : actualExitIdx;
    }
  }

  const pnlAvg = trades.length > 0 ? (cumulativePnl / trades.length) : 0;

  return {
    success: successCount,
    total: totalSignals,
    winRate: totalSignals > 0 ? (successCount / totalSignals * 100) : 0,
    pnl: cumulativePnl,
    pnlAvg,
    trades,
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
          const analyzed = Indicators.analyzeAll(res);
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

      const candles = data.candlesWithBB;
      const lastIdx = candles.findIndex(c => c.date === globalLastDate);
      if (lastIdx === -1) return;

      const c = candles[lastIdx];
      
      let bbOk = true;
      if (SimState.bbFilterActive) {
        if (c.bbLower === null) bbOk = false;
        else {
          const dropPct = ((c.low - c.bbLower) / c.low) * 100;
          bbOk = dropPct <= (SimState.bbFilterThreshold + 0.001);
        }
      }

      let eomOk = !SimState.eomFilterActive;
      if (SimState.eomFilterActive) {
        for (let k = 0; k < win; k++) {
          if (lastIdx - k < 0) break;
          if (candles[lastIdx - k].eomCross === 'BUY') { eomOk = true; break; }
        }
      }

      let rsiOk = !SimState.rsiFilterActive;
      if (SimState.rsiFilterActive) {
        for (let k = 0; k < win; k++) {
          if (lastIdx - k < 0) break;
          if (candles[lastIdx - k].rsiStSignal === 'BUY') { rsiOk = true; break; }
        }
      }

      if (bbOk && eomOk && rsiOk) {
        const reasons = [];
        if (SimState.bbFilterActive) reasons.push('BB');
        if (SimState.eomFilterActive) reasons.push('EOM');
        if (SimState.rsiFilterActive) reasons.push('RSI');
        
        // 🚀 핵심 변경: 오늘 신호가 뜬 종목에 대해 즉시 시뮬레이션 엔진 호출
        const fullRes = _calculateTotalSim(data);
        SimState.simResults[stock.code] = {
          ...fullRes,
          todaySignal: reasons.join('+'),
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
      btn.style.background = '#1e3a8a';
      btn.innerHTML = '오늘';
    }
  }
}


/* ══════════════════════════════════════════════
   우단 리스트 렌더링
══════════════════════════════════════════════ */
function renderList() {
  syncColumnWidthsFromStorage();

  const anyFilter = SimState.bbFilterActive || SimState.eomFilterActive || SimState.rsiFilterActive;

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

  // 🚀 필터링 및 노출 조건
  let sorted = getSelectedStocks().filter(stock => {
    const res = SimState.simResults[stock.code];
    return res && res.total > 0;
  });

  const listEl = document.getElementById('stockList');
  const emptyEl = document.getElementById('emptyState');

  // 정렬 로직 (사용자 직접 정렬이 없으면 수익률 높은 순 -> 성공률 순)
  if (SimState.sortCol) {
    sorted = sortList(sorted, SimState.sortCol, SimState.sortDir);
  } else {
    sorted.sort((a, b) => {
      const ra = SimState.simResults[a.code], rb = SimState.simResults[b.code];
      if (ra && rb) {
        if (rb.pnl !== ra.pnl) return rb.pnl - ra.pnl; // 수익률 내림차순
        const rateA = ra.success / ra.total, rateB = rb.success / rb.total;
        return rateB - rateA; // 성공률 내림차순
      }
      return (a.name || a.code).localeCompare(b.name || b.code);
    });
  }

  updateStockCount(sorted.length);

  if (!sorted.length) {
    listEl.innerHTML = '';
    if (emptyEl) {
      emptyEl.style.display = 'flex';
      const hint = emptyEl.querySelector('.empty-hint');
      if (hint) {
        hint.textContent = anyFilter ? '조건에 맞는 종목이 없습니다.' : '종목을 등록하세요.';
      }
    }
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  // 완전 초기화 후 재생성 — emptyState가 리스트 밖으로 이동했으므로 innerHTML 안전
  listEl.innerHTML = '';

  const frag = document.createDocumentFragment();
  sorted.forEach(stock => {
    const data = SimState.watchData[stock.code];
    frag.appendChild(buildListItem(stock, data));
  });
  listEl.appendChild(frag);

  if (SimState.previewCode) highlightActiveRow(SimState.previewCode);
}

/* ── 리스트 행 생성 ── */
function buildListItem(stock, data) {
  const item = document.createElement('div');
  item.className = 'stock-item';
  item.dataset.code = stock.code;

  // 시뮬레이션 결과
  let simCountStr = '--';
  let simPnlStr = '--';
  let pnlClass = '';
  const res = SimState.simResults[stock.code];
  
  if (res) {
    simCountStr = `${res.success}/${res.total}`;
    const pnl = res.pnl || 0;
    pnlClass = pnl > 0 ? 'up' : pnl < 0 ? 'down' : '';
    simPnlStr = `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`;
    
    // 오늘 신호인 경우 종목명 옆이나 성공횟수 자리에 작게 힌트 추가 가능
    if (SimState.todayMode && res.todaySignal) {
      simCountStr += `<div style="font-size:9px; color:var(--accent); margin-top:1px;">${res.todaySignal}</div>`;
    }
  }

  item.innerHTML = `
    <div class="col-name" style="flex: 1;">
      <span class="item-name">${data?.name || stock.name || stock.code}</span>
      <span class="item-code">${data?.ticker || stock.code}</span>
    </div>
    <div class="col-item col-sim-count" style="min-width: 90px;">${simCountStr}</div>
    <div class="col-item col-sim-pnl ${pnlClass}" style="min-width: 90px;">${simPnlStr}</div>`;

  item.addEventListener('click', e => {
    showStockPreview(stock.code);
    highlightActiveRow(stock.code);
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
  if (countEl) countEl.textContent = sim ? `${sim.success}/${sim.total}` : '--';
  const pnlEl = el.querySelector('.col-sim-pnl');
  if (pnlEl) {
    const pnl = sim?.pnl ?? 0;
    pnlEl.textContent = sim ? (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%' : '--';
    pnlEl.className = `col-item col-sim-pnl ${sim ? (pnl >= 0 ? 'up' : 'down') : ''}`;
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
      case 'simPnl': va = ra?.pnl ?? -Infinity; vb = rb?.pnl ?? -Infinity; break;
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
    alert: '--col-alert',
    name: '--col-name',
    price: '--col-price',
    todayChg: '--col-today-chg',
    change: '--col-change',
    bbRatio: '--col-bb',
    trailPE: '--col-trail-pe',
    forwardPE: '--col-forward-pe',
    pbr: '--col-pbr',
    evEbitda: '--col-ev-ebitda',
    divYield: '--col-div-yield',
    eps: '--col-eps',
    beta: '--col-beta',
    sector: '--col-sector',
  };
  const MIN = {
    alert: 48, name: 70, price: 70, todayChg: 60, change: 60, bbRatio: 120,
    trailPE: 40, forwardPE: 40, pbr: 40, evEbitda: 40, divYield: 40, eps: 40, beta: 40, sector: 60
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
        document.documentElement.style.setProperty(v, Math.max(MIN[key] || 60, sw + ev.clientX - sx) + 'px');
        Charts.resizeAll();
      };
      const up = async () => {
        h.classList.remove('dragging');
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);

        // 리사이즈 완료 시 모든 컬럼의 현재 '계산된' 너비 추출하여 저장
        const activeTabId = Storage.getActiveTabId();
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
  const activeTab = Storage.getActiveTab();
  if (!activeTab || !activeTab.column_widths) return;

  const CSS_VARS = {
    alert: '--col-alert', name: '--col-name', price: '--col-price',
    todayChg: '--col-today-chg', change: '--col-change', bbRatio: '--col-bb',
    trailPE: '--col-trail-pe', forwardPE: '--col-forward-pe', pbr: '--col-pbr',
    evEbitda: '--col-ev-ebitda', divYield: '--col-div-yield', eps: '--col-eps',
    beta: '--col-beta', sector: '--col-sector'
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

  // 너비가 하나도 없는 경우 (초기 탭 등) 모든 변수 초기화
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

    // 2. 관심종목 탭이 활성 상태일 때만 작동 (다른 탭과의 간섭 방지)
    const filterTab = document.getElementById('tab-simulation');
    if (!filterTab || filterTab.classList.contains('hidden') || filterTab.style.display === 'none') return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // 🚀 이력 영역(History)이 활성화된 경우 이력 탐색
      if (SimState.historyActive && SimState.previewData) {
        // 🚀 키 불일치 방지: previewCode를 우선 참조
        const simRes = SimState.simResults[SimState.previewCode] || SimState.simResults[SimState.previewData.code];
        
        if (simRes && simRes.trades && simRes.trades.length > 0) {
          e.preventDefault();
          const maxIdx = simRes.trades.length - 1;
          if (e.key === 'ArrowDown') {
            SimState.selectedTradeIndex = Math.min(maxIdx, SimState.selectedTradeIndex + 1);
          } else {
            SimState.selectedTradeIndex = Math.max(0, SimState.selectedTradeIndex - 1);
          }
          renderSimHistory(simRes.trades);
          Charts.renderMini('previewChart', SimState.previewData, simRes, SimState.simPeriodMonths, SimState.selectedTradeIndex);
          Charts.renderEOM('eomChart', SimState.previewData, simRes, SimState.simPeriodMonths);
          Charts.renderRSIStoch('rsiStochChart', SimState.previewData, simRes, SimState.simPeriodMonths);
          return;
        }
      }

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

  select.addEventListener('change', () => {
    _markSimDirty();
    // 그룹 변경 시 현재 리스트 초기화 (옵션)
    // SimState.simStarted = false;
    // renderList();
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

  let cumPnl = 0;
  trades.forEach((t, idx) => {
    cumPnl += (t.pnl || 0);
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
      const isTarget = Math.abs((t.pnl || 0) - SimState.simTargetProfit) < 0.01;
      exitCond = isTarget ? '<span class="log-pnl up">목표달성</span>' : '기간만료';
    }

    // 🚀 '보유' 로직 수정: 첫 번째 매매의 매수가를 기준으로 고정
    const firstBuyPrice = trades[0].buyPrice;
    const targetPrice = t.isOpen 
      ? (SimState.previewData ? SimState.previewData.currentPrice : t.buyPrice) 
      : (t.exitPrice || t.buyPrice);
    
    const holdPnl = firstBuyPrice > 0 ? ((targetPrice - firstBuyPrice) / firstBuyPrice) * 100 : 0;

    row.innerHTML = `
      <td title="${t.buyDate} ~ ${t.exitDate || '진행중'}">${dateDisplay}</td>
      <td style="color:var(--up); font-weight:600;">${t.reason || '신호(In)'}</td>
      <td>${exitCond}</td>
      <td class="log-pnl ${t.pnl >= 0 ? 'up' : 'down'}" style="text-align: right; font-weight:600;">
        ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}%
      </td>
      <td class="log-pnl ${cumPnl >= 0 ? 'up' : 'down'}" style="text-align: right; font-weight:500;">
        ${cumPnl >= 0 ? '+' : ''}${cumPnl.toFixed(2)}%
      </td>
      <td class="log-pnl ${holdPnl >= 0 ? 'up' : 'down'}" style="text-align: right; opacity: 0.8; font-weight: 500;">
        ${holdPnl >= 0 ? '+' : ''}${holdPnl.toFixed(2)}%
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
        Charts.renderEOM('eomChart', data, simRes, SimState.simPeriodMonths);
        Charts.renderRSIStoch('rsiStochChart', data, simRes, SimState.simPeriodMonths);
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
      <td class="log-pnl ${totalHoldPnl >= 0 ? 'up' : 'down'}" style="text-align: right; font-weight:700;">
        ${totalHoldPnl >= 0 ? '+' : ''}${totalHoldPnl.toFixed(2)}%
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
