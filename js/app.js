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
const AppState = {
  candleCount:     52,    // 고정값 — UI 버튼 없음
  previewInterval: '1d',  // 좌측 미리보기 전용 (일봉/주봉 토글)
  listInterval:    '1d',  // 우측 리스트 — previewInterval 과 동기화
  previewData:  null,
  previewCode:  null,
  watchData:    {},
  fundamentals: {},       // 종목코드 → { trailingPE, eps, beta }
  sortCol:      null,
  sortDir:      'asc',
  checkedCodes: new Set(),
};

/* ══════════════════════════════════════════════
   펀더멘털 헬퍼 (캐시/TTL 없음 — 항상 실제 조회)
══════════════════════════════════════════════ */
async function _saveFundamentalToServer(code, data) {
  const hasValue = data.trailingPE != null || data.eps != null || data.beta != null;
  if (!hasValue) return;
  try {
    await Storage.saveFundamental(code, {
      trailingPE:  data.trailingPE,
      eps:         data.eps,
      beta:        data.beta,
      fetchedAt:   Date.now(),
      fetchFailed: false,
    });
  } catch(e) {
    console.warn(`[펀더멘털 서버 저장 실패] ${code}:`, e.message);
  }
}

/* ══════════════════════════════════════════════
   유틸리티
══════════════════════════════════════════════ */
const fmt    = n => Number(n).toLocaleString('ko-KR');
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
  const d   = new Date();
  const pad = v => String(v).padStart(2, '0');
  el.textContent =
    `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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
  const icons = { info:'fa-info-circle', warn:'fa-exclamation-triangle',
                  error:'fa-times-circle', success:'fa-check-circle' };
  t.innerHTML = `<i class="fas ${icons[type]||icons.info}"></i><span>${msg}</span>`;
  c.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('toast-show')));
  setTimeout(() => {
    t.classList.remove('toast-show');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
  }, 3200);
}

/* ══════════════════════════════════════════════
   일봉/주봉 토글 — 좌측 미리보기 전용
   (우측 리스트는 previewInterval 과 동기화)
══════════════════════════════════════════════ */
function initHeaderControls() {
  // 저장된 미리보기 인터벌 복원
  AppState.previewInterval = Storage.getInterval();
  AppState.listInterval    = AppState.previewInterval;  // 리스트도 동일 interval 로 시작
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.interval === AppState.previewInterval);
    btn.addEventListener('click', async () => {
      if (AppState.previewInterval === btn.dataset.interval) return;
      // JS 플래그로 중복 클릭 방지 (CSS disabled만으로는 부족)
      if (btn._switching) return;

      // 버튼 잠금 — 배치 완료 전 중복 클릭 방지
      const allBtns = document.querySelectorAll('.interval-btn');
      allBtns.forEach(b => { b.disabled = true; b._switching = true; });

      AppState.previewInterval = btn.dataset.interval;
      AppState.listInterval    = btn.dataset.interval;
      await Storage.setInterval(AppState.previewInterval);
      allBtns.forEach(b => b.classList.toggle('active', b === btn));

      // 배치 1회 호출 → 미리보기 우선 렌더 → 리스트 순차 렌더
      await _intervalSwitch(AppState.previewInterval);

      // 버튼 잠금 해제
      allBtns.forEach(b => { b.disabled = false; b._switching = false; });
    });
  });

  // candleCount = 52 고정 (UI 버튼 없음)
  AppState.candleCount = 52;
}

/* ══════════════════════════════════════════════
   탭 관리
══════════════════════════════════════════════ */
function renderTabs() {
  const tabs     = Storage.getTabs();
  const activeId = Storage.getActiveTabId();
  const listEl   = document.getElementById('tabList');
  listEl.innerHTML = '';

  tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className  = 'tab-item' + (tab.uid === activeId ? ' active' : '');
    el.dataset.id = tab.uid;
    el.draggable  = true;
    el.innerHTML  = `
      <span class="tab-label" data-id="${tab.uid}">${tab.name}</span>
      <button class="tab-close" data-id="${tab.uid}" title="탭 삭제">
        <i class="fas fa-times"></i>
      </button>`;

    el.addEventListener('click', async e => {
      if (e.target.closest('.tab-close')) return;
      if (e.target.closest('.tab-label') && e.detail === 2) return;
      await Storage.setActiveTabId(tab.uid);
      AppState.checkedCodes.clear();
      renderTabs(); renderList(); updateStockCount();
    });

    el.querySelector('.tab-label').addEventListener('dblclick', e => {
      e.stopPropagation();
      startTabRename(tab.uid, el.querySelector('.tab-label'));
    });

    el.querySelector('.tab-close').addEventListener('click', async e => {
      e.stopPropagation();
      if (Storage.getTabs().length <= 1) { showToast('마지막 탭은 삭제할 수 없습니다.', 'warn'); return; }
      if (!confirm(`"${tab.name}" 탭을 삭제하시겠습니까?\n(탭 내 종목도 모두 삭제됩니다)`)) return;
      await Storage.removeTab(tab.uid);
      renderTabs(); renderList(); updateStockCount();
      showToast(`"${tab.name}" 탭이 삭제되었습니다.`, 'info');
    });

    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('tab-id', tab.uid);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging-tab');
    });
    el.addEventListener('dragend',  () => el.classList.remove('dragging-tab'));
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over-tab'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over-tab'));
    el.addEventListener('drop', async e => {
      e.preventDefault(); el.classList.remove('drag-over-tab');
      const fromId = e.dataTransfer.getData('tab-id');
      if (!fromId || fromId === tab.uid) return;
      const ordered = Storage.getTabs().map(t => t.uid);
      const fi = ordered.indexOf(fromId), ti = ordered.indexOf(tab.uid);
      ordered.splice(fi, 1); ordered.splice(ti, 0, fromId);
      await Storage.reorderTabs(ordered); renderTabs();
    });

    listEl.appendChild(el);
  });
}

function startTabRename(tabId, labelEl) {
  const input = document.getElementById('tabRenameInput');
  const rect  = labelEl.getBoundingClientRect();
  input.value = labelEl.textContent;
  input.style.cssText = `display:block;position:fixed;left:${rect.left}px;top:${rect.top}px;` +
                        `width:${Math.max(80, rect.width+20)}px;z-index:2000;`;
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

function initAddTab() {
  document.getElementById('btnAddTab').addEventListener('click', async () => {
    const name = prompt('새 그룹 이름:', `그룹${Storage.getTabs().length + 1}`);
    if (name === null) return;
    await Storage.addTab(name.trim() || `그룹${Storage.getTabs().length}`);
    renderTabs(); renderList(); updateStockCount();
  });
}

/* ══════════════════════════════════════════════
   좌단 검색 & 미리보기
══════════════════════════════════════════════ */
function initSearch() {
  const inp = document.getElementById('stockInput');
  inp.addEventListener('input', () => {
    const v = inp.value.trim();
    inp.dataset.market = !v ? '' : /^\d+$/.test(v) ? 'KRX' : 'US';
  });

  document.getElementById('btnSearch').addEventListener('click', () => {
    const raw = inp.value.trim();
    if (!raw) { showSearchError('종목코드 또는 티커를 입력하세요.'); return; }
    doSearch(raw);
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnSearch').click();
  });

  document.getElementById('btnRegister').addEventListener('click', async () => {
    if (!AppState.previewData) return;
    const { code, name, market } = AppState.previewData;
    await Storage.addStock({ code, name, market });
    AppState.watchData[code] = AppState.previewData;
    renderList(); updateStockCount();
    showToast(`✅ <b>${name}</b> 등록 완료!`, 'success');
  });
}

async function doSearch(input, dbOnly = false) {
  // 로딩 표시 없이 즉시 조회 (B 검색, F 행 클릭, D/E 일봉/주봉 미리보기 공통)
  hideSearchError();
  AppState.previewCode = input.toUpperCase();
  try {
    const raw      = await API.fetchStock(input, AppState.candleCount, AppState.previewInterval);
    const analyzed = Indicators.analyzeAll(raw);
    AppState.previewCode = analyzed.code;
    AppState.previewData = analyzed;
    if (Object.prototype.hasOwnProperty.call(AppState.watchData, analyzed.code)) {
      if (AppState.previewInterval === AppState.listInterval) {
        AppState.watchData[analyzed.code] = analyzed;
        _refreshListItem(analyzed.code);
      }
      _fixStockNameIfNeeded(analyzed.code, analyzed.name);
    }
    renderPreview(analyzed);
  } catch (err) {
    AppState.previewCode = null;
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
function _pearson(candlesA, candlesB) {
  // 날짜 → 일간 수익률 맵 생성 (가격 대신 수익률로 상관 계산 → 레벨 효과 제거)
  const rateMap = (candles) => {
    const m = new Map();
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1].close;
      const cur  = candles[i].close;
      if (prev && cur) m.set(candles[i].date, (cur - prev) / prev);
    }
    return m;
  };
  const mA = rateMap(candlesA);
  const mB = rateMap(candlesB);

  // 공통 날짜만 추출
  const dates = [...mA.keys()].filter(d => mB.has(d));
  if (dates.length < 5) return null;

  const xs = dates.map(d => mA.get(d));
  const ys = dates.map(d => mB.get(d));
  const n  = xs.length;

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;

  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num  += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return null;
  return num / den;
}

/**
 * 현재 탭의 모든 종목과 target code 간 상관계수를 계산해
 * 최고 양/음 상관 종목을 반환
 * returns { pos: {code, name, r, n}, neg: {code, name, r, n} } | null
 */
function _calcCorrelations(targetCode) {
  const targetData = AppState.watchData[targetCode];
  if (!targetData?.allCandles?.length) return null;

  const tab = Storage.getActiveTab();
  if (!tab) return null;

  const others = tab.stocks.filter(s => s.code !== targetCode);
  if (!others.length) return null;

  const results = [];
  for (const s of others) {
    const d = AppState.watchData[s.code];
    if (!d?.allCandles?.length) continue;
    const r = _pearson(targetData.allCandles, d.allCandles);
    if (r === null) continue;
    results.push({
      code: s.code,
      name: d.name || s.name || s.code,
      r,
    });
  }

  if (!results.length) return null;

  results.sort((a, b) => b.r - a.r);

  // 0에 가장 가까운 종목 (양·음 최대와 다른 종목 중 |r| 최소)
  const posCode = results[0].code;
  const negCode = results[results.length - 1].code;
  const neuCandidates = results.filter(x => x.code !== posCode && x.code !== negCode);
  // 후보가 없으면 pos/neg 제외 없이 전체에서 선택
  const neuPool = neuCandidates.length ? neuCandidates : results;
  const neu = neuPool.reduce((best, x) =>
    Math.abs(x.r) < Math.abs(best.r) ? x : best
  );

  return {
    pos: results[0],
    neu,
    neg: results[results.length - 1],
  };
}

/** 상관관계 섹션 렌더링 — 가로 배치 */
function renderCorrSection(targetCode) {
  const sec = document.getElementById('corrSection');
  if (!sec) return;

  const result = _calcCorrelations(targetCode);
  if (!result) {
    sec.style.display = 'none';
    return;
  }

  const { pos, neu, neg } = result;
  const barColor = r => r >= 0 ? 'var(--up)' : 'var(--down)';
  const rFmt     = r => (r >= 0 ? '+' : '') + r.toFixed(2);

  const makeItem = (item, badgeClass, badgeText) => {
    const wrap = document.createElement('div');
    wrap.className = 'corr-item';

    const badge = document.createElement('span');
    badge.className   = `corr-badge ${badgeClass}`;
    badge.textContent = badgeText;

    const score = document.createElement('span');
    score.className   = 'corr-score';
    score.style.color = barColor(item.r);
    score.textContent = rFmt(item.r);

    const nameEl = document.createElement('span');
    nameEl.className   = 'corr-name corr-clickable';
    nameEl.textContent = item.name;
    nameEl.title       = `${item.name} 조회`;

    const codeEl = document.createElement('span');
    codeEl.className   = 'corr-code corr-clickable';
    codeEl.textContent = item.code;
    codeEl.title       = `${item.name} 조회`;

    const onClick = () => {
      document.getElementById('stockInput').value = item.code;
      doSearch(item.code);
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

  document.getElementById('previewName').textContent  = name;
  document.getElementById('previewCode').textContent  = data.ticker;
  document.getElementById('previewPrice').textContent = fmtPrice(currentPrice, isUS);
  document.getElementById('previewIntervalBadge').textContent = interval === '1wk' ? '주봉' : '일봉';

  // 섹터 백지
  const sectorBadge = document.getElementById('previewSectorBadge');
  if (sectorBadge) {
    const sector = data.sector || AppState.fundamentals[data.code]?.sector;
    if (sector) {
      // /api/stock 응답의 sector를 fundamentals 캐시에도 저장 (리스트 표시용)
      if (data.sector && !AppState.fundamentals[data.code]) {
        AppState.fundamentals[data.code] = {};
      }
      if (data.sector && AppState.fundamentals[data.code]) {
        AppState.fundamentals[data.code].sector = data.sector;
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
    todayEl.textContent = `${fmtChg(todayChange, isUS)} (${fmtPct(todayChangePct)})`;
    todayEl.className   = 'preview-today-chg ' + (todayChange >= 0 ? 'up' : 'down');
  }

  // 기간 등락 라벨 (N일 / N주)
  const periodLbl = document.getElementById('previewPeriodLabel');
  if (periodLbl) {
    periodLbl.textContent = interval === '1wk'
      ? `${AppState.candleCount}주`
      : `${AppState.candleCount}일`;
  }

  // 기간 등락: 기간 첫날 종가 → 현재가
  const chgEl = document.getElementById('previewChange');
  if (chgEl) {
    chgEl.textContent = `${fmtChg(change, isUS)} (${fmtPct(changePct)})`;
    chgEl.className   = 'preview-change ' + (change >= 0 ? 'up' : 'down');
  }

  // BB 경고 배지
  const alertEl = document.getElementById('previewAlert');
  if (alertEl) {
    alertEl.textContent = al.stars;
    alertEl.className   = `preview-alert alert-lv${al.level}`;
  }

  // BB 바
  if (bb) {
    const pct  = (al.ratio * 100).toFixed(1);
    const fill = document.getElementById('previewBBFill');
    fill.style.width = pct + '%';
    fill.className   = `bb-bar-fill lv${al.level}`;
    document.getElementById('previewBBMarker').style.left = pct + '%';

    // 현재가 기준 BB 상단/중단/하단까지 % 거리 + 밴드 가격
    const cur = currentPrice;
    const upperPctEl    = document.getElementById('previewBBUpperPct');
    const middlePctEl   = document.getElementById('previewBBMiddlePct');
    const lowerPctEl    = document.getElementById('previewBBLowerPct');
    const upperPriceEl  = document.getElementById('previewBBUpperPrice');
    const middlePriceEl = document.getElementById('previewBBMiddlePrice');
    const lowerPriceEl  = document.getElementById('previewBBLowerPrice');

    const setBBBand = (pctEl, priceEl, band) => {
      if (!pctEl && !priceEl) return;
      const v = ((band - cur) / cur) * 100;
      const cls = v >= 0 ? 'pct-up' : 'pct-down';
      if (pctEl) {
        pctEl.textContent = (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
        pctEl.className   = 'bb-pct-val ' + cls;
      }
      if (priceEl) {
        priceEl.textContent = fmtPrice(band, isUS);
        priceEl.className   = 'bb-pct-price ' + cls;
      }
    };
    setBBBand(upperPctEl,  upperPriceEl,  bb.upper);
    setBBBand(middlePctEl, middlePriceEl, bb.middle);
    setBBBand(lowerPctEl,  lowerPriceEl,  bb.lower);
  }

  document.getElementById('leftPanelTitle').innerHTML =
    `<i class="fas fa-chart-area"></i> ${name} ` +
    `<small style="font-size:11px;color:var(--text-muted)">${data.ticker}</small>`;

  const regBtn = document.getElementById('btnRegister');
  regBtn.disabled = false;
  regBtn.innerHTML = '<i class="fas fa-plus-circle"></i> 등록';
  regBtn.style.display = 'flex';
  document.getElementById('previewCard').style.display = 'flex';

  // 상관관계 섹션: 등록 종목이 2개 이상일 때만 표시
  renderCorrSection(data.code);

  ['eomSection', 'rsiStochSection'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'block';
  });

  setTimeout(() => {
    Charts.renderMini('previewChart', data);
    Charts.renderEOM('eomChart', data);
    Charts.renderRSIStoch('rsiStochChart', data);
  }, 50);
}

async function showStockPreview(code) {
  const cached = AppState.watchData[code];
  document.getElementById('stockInput').value = cached?.ticker || code;

  // previewInterval 과 listInterval 이 같으면 캐시 즉시 표시 후 백그라운드 갱신
  if (cached && AppState.previewInterval === AppState.listInterval) {
    AppState.previewCode = code;
    AppState.previewData = cached;
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
    const raw      = await API.fetchStock(input, AppState.candleCount, AppState.listInterval);
    const analyzed = Indicators.analyzeAll(raw);
    const code     = registeredCode || analyzed.code;
    // watchData 갱신 (등록된 종목이면)
    if (Object.prototype.hasOwnProperty.call(AppState.watchData, code)) {
      AppState.watchData[code] = analyzed;
      _refreshListItem(code);
      _fixStockNameIfNeeded(code, analyzed.name);
    }
    // ※ 미리보기는 건드리지 않음 — 미리보기는 doSearch(previewInterval 기준)에서 관리
  } catch (_) {
    // 백그라운드 실패 무시 (캐시 데이터로 이미 표시 중)
  }
}

function hidePreview() {
  document.getElementById('previewCard').style.display = 'none';
  const regBtn = document.getElementById('btnRegister');
  regBtn.style.display = 'none';
  regBtn.disabled = true;
  document.getElementById('leftPanelTitle').innerHTML = '<i class="fas fa-search"></i> 종목 검색';
  ['eomSection', 'rsiStochSection'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  Charts.dispose('eomChart');
  Charts.dispose('rsiStochChart');
}
function showSearchError(msg) {
  document.getElementById('searchErrorMsg').textContent = msg;
  document.getElementById('searchError').style.display = 'flex';
}
function hideSearchError()    { document.getElementById('searchError').style.display = 'none'; }
function showSearchLoading(v) { document.getElementById('searchLoading').style.display = v ? 'flex' : 'none'; }

/* ══════════════════════════════════════════════
   일봉/주봉 전환 — API 1회 배치 조회
   1. POST /api/stock/batch (전체 종목, 새 interval)
   2. 응답 배열에서 previewCode 먼저 → renderPreview()
   3. 나머지 순차 → _refreshListItem()
   4. previewCode가 탭에 없으면 → POST /api/stock 1회 별도
══════════════════════════════════════════════ */
async function _intervalSwitch(interval) {
  // 전체 탭 종목 수집
  const allCodes  = new Set();
  const allStocks = [];
  Storage.getTabs().forEach(tab => {
    tab.stocks.forEach(s => {
      if (!allCodes.has(s.code)) { allCodes.add(s.code); allStocks.push(s); }
    });
  });

  // watchData 키 선점
  allStocks.forEach(s => {
    if (!Object.prototype.hasOwnProperty.call(AppState.watchData, s.code)) {
      AppState.watchData[s.code] = null;
    }
  });

  // ① 배치 1회 조회 (DB only)
  const batchResults = await API.fetchBatch(
    allStocks, AppState.candleCount, interval, null  // onProgress 없이 배열로 받음
  );

  // code → analyzed 맵 구성
  const dataMap = new Map();
  batchResults.forEach((res, i) => {
    if (!res) return;
    const analyzed = Indicators.analyzeAll(res);
    AppState.watchData[allStocks[i].code] = analyzed;
    dataMap.set(allStocks[i].code, analyzed);
    if (analyzed.name) _fixStockNameIfNeeded(allStocks[i].code, analyzed.name);
  });

  // ② 미리보기 우선 렌더
  if (AppState.previewCode) {
    if (dataMap.has(AppState.previewCode)) {
      // 탭에 있는 종목 → 배치 결과에서 바로 렌더
      const analyzed = dataMap.get(AppState.previewCode);
      AppState.previewData = analyzed;
      renderPreview(analyzed);
    } else {
      // 탭에 없는 종목 (검색 결과) → 별도 1회 조회
      try {
        const raw      = await API.fetchStock(AppState.previewCode, AppState.candleCount, interval);
        const analyzed = Indicators.analyzeAll(raw);
        AppState.previewData = analyzed;
        renderPreview(analyzed);
      } catch (e) {
        console.warn('[interval-switch] 미리보기 조회 실패:', e.message);
      }
    }
  }

  // ③ 리스트 순차 렌더
  allStocks.forEach(s => _refreshListItem(s.code));
  // watchData → AppState.fundamentals 동기화 (펀더멘털·섹터 표시)
  _syncFundamentalsFromWatchData();
  setLastUpdated();
  renderList();
}

/* ══════════════════════════════════════════════
   우단 전체 새로고침
══════════════════════════════════════════════ */
async function doRefreshAll() {
  /* ── 새로고침 버튼 (yfinance 포함) ──────────────────────────────────── */
  const allCodes  = new Set();
  const allStocks = [];
  Storage.getTabs().forEach(tab => {
    tab.stocks.forEach(s => {
      if (!allCodes.has(s.code)) { allCodes.add(s.code); allStocks.push(s); }
    });
  });
  if (!allStocks.length) return;

  const loadEl = document.getElementById('listLoading');
  const total  = allStocks.length;
  let done = 0;
  const setMsg = msg => { const s = loadEl.querySelector('span'); if (s) s.textContent = msg; };
  loadEl.style.display = 'flex';
  setMsg(`데이터 로드 중... (0/${total})`);

  allStocks.forEach(s => {
    if (!Object.prototype.hasOwnProperty.call(AppState.watchData, s.code)) {
      AppState.watchData[s.code] = null;
    }
  });

  // 새로고침: 개별 POST /api/stock 순차 호출 (DB 우선, 없으면 yfinance)
  await API.fetchMultiple(allStocks, AppState.candleCount, AppState.listInterval,
    (code, res, err) => {
      done++;
      if (res) {
        const analyzed = Indicators.analyzeAll(res);
        AppState.watchData[code] = analyzed;
        _refreshListItem(code);
        if (analyzed.name) _fixStockNameIfNeeded(code, analyzed.name);
      } else {
        console.warn(`[${code}] 조회 실패:`, err?.message);
      }
      setMsg(`데이터 로드 중... (${done}/${total})`);
    }
  );

  loadEl.style.display = 'none';
  // watchData → AppState.fundamentals 동기화 (펀더멘털·섹터 표시)
  _syncFundamentalsFromWatchData();
  setLastUpdated();
  renderList();
  if (AppState.previewCode && AppState.watchData[AppState.previewCode]) {
    AppState.previewData = AppState.watchData[AppState.previewCode];
    renderPreview(AppState.previewData);
  }
}

/* ── 펀더멘털 → AppState.fundamentals 동기화
 * watchData에 이미 포함된 펀더멘털 값을 AppState.fundamentals에 반영.
 * (API /api/stock 응답에 펀더멘털이 포함되므로 별도 배치 조회 불필요)
 * ────────────────────────────────────────────────────────────────── */
function _syncFundamentalsFromWatchData() {
  for (const [code, data] of Object.entries(AppState.watchData)) {
    if (!data) continue;
    const fd = {
      trailingPE:   data.trailingPE   ?? null,
      forwardPE:    data.forwardPE    ?? null,
      pbr:          data.pbr          ?? null,
      evToEbitda:   data.evToEbitda   ?? null,
      dividendYield:data.dividendYield ?? null,
      eps:          data.eps          ?? null,
      beta:         data.beta         ?? null,
      sector:       data.sector       ?? null,
    };
    const cacheKey = code.replace(/\.(KS|KQ)$/, '');
    AppState.fundamentals[code]     = fd;
    AppState.fundamentals[cacheKey] = fd;
    if (/^\d{5,6}$/.test(cacheKey)) {
      AppState.fundamentals[cacheKey + '.KS'] = fd;
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
   우단 리스트 렌더링
══════════════════════════════════════════════ */
function renderList() {
  const watchlist = Storage.getWatchlist();
  const listEl    = document.getElementById('stockList');
  const emptyEl   = document.getElementById('emptyState');
  updateStockCount();

  if (!watchlist.length) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'flex';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  let sorted = [...watchlist];
  if (AppState.sortCol) sorted = sortList(sorted, AppState.sortCol, AppState.sortDir);

  // 완전 초기화 후 재생성 — emptyState가 리스트 밖으로 이동했으므로 innerHTML 안전
  listEl.innerHTML = '';

  const frag = document.createDocumentFragment();
  sorted.forEach(stock => {
    const data = AppState.watchData[stock.code];
    frag.appendChild(buildListItem(stock, data));
  });
  listEl.appendChild(frag);

  AppState.checkedCodes.forEach(code => {
    const cb = document.getElementById(`cb-${code}`);
    if (cb) cb.checked = true;
  });
  if (AppState.previewCode) highlightActiveRow(AppState.previewCode);
  updateDeleteBtn();
}

/* ── 리스트 행 생성 ── */
function buildListItem(stock, data) {
  const item = document.createElement('div');
  item.className    = 'stock-item';
  item.dataset.code = stock.code;

  const al   = data?.alert || { level: 0, stars: '', label: '--', ratio: 0.5 };
  if (al.ratio == null) al.ratio = 0.5;
  const isUS = data?.isUS ?? (stock.market === 'US');

  const priceStr = data ? fmtPrice(data.currentPrice, isUS) : '--';

  // 금일 등락 (퍼센트만)
  const todayPctVal  = data?.todayChangePct ?? 0;
  const todayChgVal  = data?.todayChange    ?? 0;
  const todayStr     = data ? fmtPct(todayPctVal) : '--';
  const todayUpDown  = data ? (todayChgVal >= 0 ? 'up' : 'down') : '';

  // 기간 등락 (퍼센트만)
  const periodPctVal = data?.changePct ?? 0;
  const periodChgVal = data?.change    ?? 0;
  const periodStr    = data ? fmtPct(periodPctVal) : '--';
  const periodUpDown = data ? (periodChgVal >= 0 ? 'up' : 'down') : '';

  const bbPct   = (al.ratio * 100).toFixed(1);

  // BB 밴드 % 거리 계산 (현재가 기준)
  let bbUpperPct = '--', bbMiddlePct = '--', bbLowerPct = '--';
  let bbUpperCls = '', bbMiddleCls = '', bbLowerCls = '';
  if (data?.bb && data.currentPrice) {
    const cur = data.currentPrice;
    const calcPct = (band) => {
      const v = ((band - cur) / cur) * 100;
      return { str: (v >= 0 ? '+' : '') + v.toFixed(2) + '%', cls: v >= 0 ? 'pct-up' : 'pct-down' };
    };
    const u = calcPct(data.bb.upper);
    const m = calcPct(data.bb.middle);
    const l = calcPct(data.bb.lower);
    bbUpperPct  = u.str; bbUpperCls  = u.cls;
    bbMiddlePct = m.str; bbMiddleCls = m.cls;
    bbLowerPct  = l.str; bbLowerCls  = l.cls;
  }

  // 펀더멘털
  const fd = AppState.fundamentals[stock.code] || {};
  const trailPE    = fmtFundNum(fd.trailingPE);
  const forwardPE  = fmtFundNum(fd.forwardPE);
  const pbrVal     = fmtFundNum(fd.pbr);
  const evEbitda   = fmtFundNum(fd.evToEbitda);
  const divYield   = fd.dividendYield != null ? fmtFundNum(fd.dividendYield) + '%' : '--';
  const epsVal     = fmtFundNum(fd.eps);
  const betaVal    = fmtFundNum(fd.beta);
  const betaCls    = fd.beta != null ? (fd.beta >= 1 ? 'fund-up' : 'fund-down') : '';
  const sectorVal  = fd.sector || '';
  const sectorShort = sectorVal.length > 16 ? sectorVal.slice(0, 15) + '…' : sectorVal;

  item.innerHTML = `
    <div class="col-check">
      <input type="checkbox" id="cb-${stock.code}" data-code="${stock.code}" />
    </div>
    <div class="col-alert">
      ${al.level===2 ? `<span class="star-badge lv2" title="BB하단 근접">★★</span>`
       : al.level===1 ? `<span class="star-badge lv1" title="BB하단 접근">★</span>`
       : '<span class="no-alert">—</span>'}
    </div>
    <div class="col-name">
      <span class="item-name">${data?.name || stock.name || stock.code}</span>
      <span class="item-code">${data?.ticker || stock.code}</span>
    </div>
    <div class="col-price">
      ${data ? `<span class="item-price">${priceStr}</span>` : '<span class="no-data">--</span>'}
    </div>
    <div class="col-today-chg ${todayUpDown}">${todayStr}</div>
    <div class="col-change ${periodUpDown}">${periodStr}</div>
    <div class="col-bb">
      <div class="bb-pos-bar">
        <div class="bb-pos-track">
          <div class="bb-pos-fill lv${al.level}" style="width:${bbPct}%"></div>
          <div class="bb-pos-marker" style="left:${bbPct}%"></div>
          <div class="bb-pos-middle"></div>
        </div>
        <div class="bb-band-pct-row">
          <span class="bb-band-pct-item">
            <span class="bb-band-pct-lbl">하단</span>
            <span class="bb-band-pct-val ${bbLowerCls}">${bbLowerPct}</span>
          </span>
          <span class="bb-band-pct-item">
            <span class="bb-band-pct-lbl">중단</span>
            <span class="bb-band-pct-val ${bbMiddleCls}">${bbMiddlePct}</span>
          </span>
          <span class="bb-band-pct-item">
            <span class="bb-band-pct-lbl">상단</span>
            <span class="bb-band-pct-val ${bbUpperCls}">${bbUpperPct}</span>
          </span>
        </div>
      </div>
    </div>
    <div class="col-trail-pe  fund-val">${trailPE}</div>
    <div class="col-forward-pe fund-val">${forwardPE}</div>
    <div class="col-pbr        fund-val">${pbrVal}</div>
    <div class="col-ev-ebitda  fund-val">${evEbitda}</div>
    <div class="col-div-yield  fund-val">${divYield}</div>
    <div class="col-eps        fund-val">${epsVal}</div>
    <div class="col-beta       fund-val ${betaCls}">${betaVal}</div>
    <div class="col-sector     fund-val" title="${sectorVal}">${sectorShort}</div>
    <div class="col-action">
      <button class="btn-detail" data-code="${stock.code}" title="상세 차트">
        <i class="fas fa-chart-bar"></i>
      </button>
    </div>`;

  // querySelector는 점(.)을 클래스로 해석하므로 attribute 선택자 사용 (BRK.B, BF.B 등 대응)
  const cbEl = item.querySelector(`input[type="checkbox"][data-code="${stock.code}"]`);
  if (cbEl) cbEl.addEventListener('change', e => {
    if (e.target.checked) AppState.checkedCodes.add(stock.code);
    else AppState.checkedCodes.delete(stock.code);
    syncCheckAll(); updateDeleteBtn();
  });
  item.querySelector('.btn-detail').addEventListener('click', e => {
    e.stopPropagation();
    if (data) openModal(data);
  });
  item.addEventListener('click', e => {
    if (e.target.closest('input[type="checkbox"]')) return;
    if (e.target.closest('.btn-detail'))            return;
    if (e.target.closest('.col-drag-handle'))       return;
    showStockPreview(stock.code);
    highlightActiveRow(stock.code);
  });
  return item;
}

function highlightActiveRow(code) {
  document.querySelectorAll('.stock-item').forEach(el =>
    el.classList.toggle('row-active', el.dataset.code === code)
  );
}

function updateStockCount() {
  document.getElementById('stockCount').textContent = Storage.getWatchlist().length;
}

/* ── 특정 행만 증분 갱신 (새로고침 중 즉시 반영) ── */
function _refreshListItem(code) {
  const el   = document.querySelector(`.stock-item[data-code="${code}"]`);
  if (!el) return;

  const data = AppState.watchData[code];

  // 이름/코드 갱신 (data.name이 있으면 최신 API 이름으로 덮어씀)
  if (data?.name) {
    const nameEl = el.querySelector('.item-name');
    if (nameEl) nameEl.textContent = data.name;
  }
  if (data?.ticker) {
    const codeEl = el.querySelector('.item-code');
    if (codeEl) codeEl.textContent = data.ticker;
  }

  // 캔들 데이터 없어도 펀더멘털 컬럼은 항상 갱신
  const fd = AppState.fundamentals[code] || {};
  const _setFund = (sel, val, cls) => {
    const el2 = el.querySelector(sel);
    if (!el2) return;
    el2.textContent = val;
    if (cls !== undefined) el2.className = `fund-val ${cls}`;
  };
  _setFund('.col-trail-pe',  fmtFundNum(fd.trailingPE));
  _setFund('.col-forward-pe', fmtFundNum(fd.forwardPE));
  _setFund('.col-pbr',       fmtFundNum(fd.pbr));
  _setFund('.col-ev-ebitda', fmtFundNum(fd.evToEbitda));
  _setFund('.col-div-yield', fd.dividendYield != null ? fmtFundNum(fd.dividendYield) + '%' : '--');
  _setFund('.col-eps',       fmtFundNum(fd.eps));
  _setFund('.col-beta',      fmtFundNum(fd.beta),
    fd.beta != null ? (fd.beta >= 1 ? 'fund-up' : 'fund-down') : '');
  const sv = fd.sector || '';
  _setFund('.col-sector', sv.length > 16 ? sv.slice(0,15)+'…' : sv);

  // 캔들 데이터 없으면 나머지 갱신 건너뜀
  if (!data) return;

  const al   = data.alert || { level: 0, stars: '', label: '--', ratio: 0.5 };
  const isUS = data.isUS;

  // 경고 배지
  const alertEl = el.querySelector('.col-alert');
  if (alertEl) alertEl.innerHTML =
    al.level === 2 ? `<span class="star-badge lv2" title="BB하단 근접">★★</span>`
    : al.level === 1 ? `<span class="star-badge lv1" title="BB하단 접근">★</span>`
    : '<span class="no-alert">—</span>';

  // 현재가
  const priceEl = el.querySelector('.col-price');
  if (priceEl) priceEl.innerHTML = `<span class="item-price">${fmtPrice(data.currentPrice, isUS)}</span>`;

  // 금일 등락 (퍼센트만)
  const todayChgVal = data.todayChange    ?? 0;
  const todayPctVal = data.todayChangePct ?? 0;
  const todayEl     = el.querySelector('.col-today-chg');
  if (todayEl) {
    todayEl.textContent = fmtPct(todayPctVal);
    todayEl.className   = `col-today-chg ${todayChgVal >= 0 ? 'up' : 'down'}`;
  }

  // 기간 등락 (퍼센트만)
  const periodChgVal = data.change    ?? 0;
  const periodPctVal = data.changePct ?? 0;
  const chgEl        = el.querySelector('.col-change');
  if (chgEl) {
    chgEl.textContent = fmtPct(periodPctVal);
    chgEl.className   = `col-change ${periodChgVal >= 0 ? 'up' : 'down'}`;
  }

  // BB 바 위치
  const bbFill = el.querySelector('.bb-pos-fill');
  if (bbFill) {
    bbFill.style.width = (al.ratio * 100).toFixed(1) + '%';
    bbFill.className   = `bb-pos-fill lv${al.level}`;
  }
  const bbMarker = el.querySelector('.bb-pos-marker');
  if (bbMarker) bbMarker.style.left = (al.ratio * 100).toFixed(1) + '%';

  // BB 밴드 % 거리 갱신
  if (data.bb && data.currentPrice) {
    const cur = data.currentPrice;
    const calcPct = (band) => {
      const v = ((band - cur) / cur) * 100;
      return { str: (v >= 0 ? '+' : '') + v.toFixed(2) + '%', cls: v >= 0 ? 'pct-up' : 'pct-down' };
    };
    const pctItems = el.querySelectorAll('.bb-band-pct-item');
    const vals = [calcPct(data.bb.lower), calcPct(data.bb.middle), calcPct(data.bb.upper)];
    pctItems.forEach((item, i) => {
      const valEl = item.querySelector('.bb-band-pct-val');
      if (valEl) {
        valEl.textContent = vals[i].str;
        valEl.className   = `bb-band-pct-val ${vals[i].cls}`;
      }
    });
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
      if (AppState.sortCol === col) AppState.sortDir = AppState.sortDir === 'asc' ? 'desc' : 'asc';
      else { AppState.sortCol = col; AppState.sortDir = col === 'alert' ? 'desc' : 'asc'; }
      updateSortIcons(); renderList();
    });
  });
}

function sortList(list, col, dir) {
  return [...list].sort((a, b) => {
    const da = AppState.watchData[a.code], db = AppState.watchData[b.code];
    let va, vb;
    switch (col) {
      case 'alert':    va = da?.alert?.level    ?? -1;       vb = db?.alert?.level    ?? -1;       break;
      case 'name':     va = (da?.name || a.code).toLowerCase(); vb = (db?.name || b.code).toLowerCase(); break;
      case 'price':    va = da?.currentPrice    ?? -Infinity; vb = db?.currentPrice    ?? -Infinity; break;
      case 'todayChg': va = da?.todayChangePct  ?? -Infinity; vb = db?.todayChangePct  ?? -Infinity; break;
      case 'change':   va = da?.changePct        ?? -Infinity; vb = db?.changePct        ?? -Infinity; break;
      case 'bbRatio':  va = da?.bbRatio          ?? -1;       vb = db?.bbRatio          ?? -1;       break;
      case 'trailPE':   va = AppState.fundamentals[a.code]?.trailingPE  ?? -Infinity; vb = AppState.fundamentals[b.code]?.trailingPE  ?? -Infinity; break;
      case 'forwardPE': va = AppState.fundamentals[a.code]?.forwardPE   ?? -Infinity; vb = AppState.fundamentals[b.code]?.forwardPE   ?? -Infinity; break;
      case 'pbr':       va = AppState.fundamentals[a.code]?.pbr         ?? -Infinity; vb = AppState.fundamentals[b.code]?.pbr         ?? -Infinity; break;
      case 'evEbitda':  va = AppState.fundamentals[a.code]?.evToEbitda  ?? -Infinity; vb = AppState.fundamentals[b.code]?.evToEbitda  ?? -Infinity; break;
      case 'divYield':  va = AppState.fundamentals[a.code]?.dividendYield ?? -Infinity; vb = AppState.fundamentals[b.code]?.dividendYield ?? -Infinity; break;
      case 'eps':       va = AppState.fundamentals[a.code]?.eps         ?? -Infinity; vb = AppState.fundamentals[b.code]?.eps         ?? -Infinity; break;
      case 'beta':      va = AppState.fundamentals[a.code]?.beta        ?? -Infinity; vb = AppState.fundamentals[b.code]?.beta        ?? -Infinity; break;
      case 'sector':    va = (AppState.fundamentals[a.code]?.sector || '').toLowerCase(); vb = (AppState.fundamentals[b.code]?.sector || '').toLowerCase(); break;
      default: return 0;
    }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

function updateSortIcons() {
  document.querySelectorAll('.sort-col').forEach(th => {
    const col = th.dataset.col;
    const el  = th.querySelector('.sort-icon');
    if (!el) return;
    el.innerHTML = AppState.sortCol === col
      ? (AppState.sortDir === 'asc'
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
    alert:    '--col-alert',
    name:     '--col-name',
    price:    '--col-price',
    todayChg: '--col-today-chg',
    change:   '--col-change',
    bbRatio:  '--col-bb',
    trailPE:  '--col-trail-pe',
    forwardPE:'--col-forward-pe',
    pbr:      '--col-pbr',
    evEbitda: '--col-ev-ebitda',
    divYield: '--col-div-yield',
    eps:      '--col-eps',
    beta:     '--col-beta',
    sector:   '--col-sector',
  };
  const MIN = { alert: 48, name: 70, price: 70, todayChg: 60, change: 60, bbRatio: 120,
    trailPE: 40, forwardPE: 40, pbr: 40, evEbitda: 40, divYield: 40, eps: 40, beta: 40, sector: 60 };

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
      const up = () => {
        h.classList.remove('dragging');
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  });
}

/* ══════════════════════════════════════════════
   체크박스 / 삭제
══════════════════════════════════════════════ */
function initCheckAll() {
  document.getElementById('checkAll').addEventListener('change', e => {
    Storage.getWatchlist().forEach(s => {
      const cb = document.getElementById(`cb-${s.code}`);
      if (cb) cb.checked = e.target.checked;
      if (e.target.checked) AppState.checkedCodes.add(s.code);
      else AppState.checkedCodes.delete(s.code);
    });
    updateDeleteBtn();
  });
}
function syncCheckAll() {
  const total   = Storage.getWatchlist().length;
  const checked = AppState.checkedCodes.size;
  const cb = document.getElementById('checkAll');
  cb.checked      = total > 0 && checked === total;
  cb.indeterminate = checked > 0 && checked < total;
}
function updateDeleteBtn() {
  const n   = AppState.checkedCodes.size;
  const btn = document.getElementById('btnDeleteSelected');
  btn.disabled  = n === 0;
  btn.innerHTML = `<i class="fas fa-trash-alt"></i> 선택 삭제${n > 0 ? ` (${n})` : ''}`;
  // 이동/복사 버튼도 동기화
  const hasMultiTab = Storage.getTabs().length > 1;
  const btnMove = document.getElementById('btnMoveSelected');
  const btnCopy = document.getElementById('btnCopySelected');
  if (btnMove) btnMove.disabled = n === 0 || !hasMultiTab;
  if (btnCopy) btnCopy.disabled = n === 0 || !hasMultiTab;
  // 순서 이동 버튼 활성화
  const dis = n === 0;
  ['btnMoveTop','btnMoveUp','btnMoveDown','btnMoveBot'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = dis;
  });
}
function initDeleteBtn() {
  document.getElementById('btnDeleteSelected').addEventListener('click', async () => {
    if (!AppState.checkedCodes.size) return;
    const names = [...AppState.checkedCodes].map(c => AppState.watchData[c]?.name || c).join(', ');
    if (!confirm(`[${names}] 을(를) 삭제하시겠습니까?`)) return;
    AppState.checkedCodes.forEach(code => {
      delete AppState.watchData[code];
      Charts.dispose(`spark-${code}`);
      if (AppState.previewCode === code) {
        hidePreview();
        AppState.previewCode = null;
        AppState.previewData = null;
        document.getElementById('stockInput').value = '';
      }
    });
    await Storage.removeStocks([...AppState.checkedCodes]);
    AppState.checkedCodes.clear();
    updateDeleteBtn(); renderList();
    showToast('삭제 완료', 'info');
  });
}

/* ══════════════════════════════════════════════
   모달
══════════════════════════════════════════════ */
function openModal(data) {
  const iLabel = data.interval === '1wk' ? '주봉' : '일봉';
  document.getElementById('modalTitle').textContent =
    `${data.name} (${data.code}) — ${iLabel} ${AppState.candleCount}캔들`;
  document.getElementById('chartModal').style.display = 'flex';
  setTimeout(() => Charts.renderModal('modalChart', data), 60);
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
    _ctxMenu.id        = 'stockCtxMenu';
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
  const tabs    = Storage.getTabs();
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
      </button>`).join('')}
    <div class="ctx-divider"></div>
    <div class="ctx-section-title"><i class="fas fa-copy"></i> 복사</div>
    ${othTabs.map(t => `
      <button class="ctx-item ctx-copy" data-tab="${t.uid}">
        <i class="fas fa-clone"></i> ${t.name}
      </button>`).join('')}
  `;

  // 이동 버튼 이벤트
  menu.querySelectorAll('.ctx-move').forEach(btn => {
    btn.addEventListener('click', async () => {
      _hideCtxMenu();
      const toTabUid = btn.dataset.tab;
      const toTab    = Storage.getTabs().find(t => t.uid === toTabUid);
      const n        = await Storage.moveStocks(codes, toTabUid);
      // 이동된 종목은 현재 탭 캐시에서 제거
      codes.forEach(c => { delete AppState.watchData[c]; Charts.dispose(`spark-${c}`); });
      AppState.checkedCodes.clear();
      renderTabs(); renderList(); updateDeleteBtn();
      showToast(
        n > 0
          ? `✅ ${n}개 종목 → <b>${toTab?.name}</b> 이동 완료`
          : `이미 <b>${toTab?.name}</b>에 존재하는 종목입니다.`,
        n > 0 ? 'success' : 'warn'
      );
    });
  });

  // 복사 버튼 이벤트
  menu.querySelectorAll('.ctx-copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      _hideCtxMenu();
      const toTabUid = btn.dataset.tab;
      const toTab    = Storage.getTabs().find(t => t.uid === toTabUid);
      const n        = await Storage.copyStocks(codes, toTabUid);
      showToast(
        n > 0
          ? `✅ ${n}개 종목 → <b>${toTab?.name}</b> 복사 완료`
          : `이미 <b>${toTab?.name}</b>에 존재하는 종목입니다.`,
        n > 0 ? 'success' : 'warn'
      );
    });
  });

  // 위치 조정 (화면 밖으로 나가지 않도록)
  menu.style.display = 'block';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth,  vh = window.innerHeight;
  menu.style.left = Math.min(x, vw - mw - 8) + 'px';
  menu.style.top  = Math.min(y, vh - mh - 8) + 'px';
}

/** 선택된 종목들에 대한 일괄 이동/복사 드롭다운 토글 */
function _toggleBulkDropdown(type, anchorEl) {
  // 기존 열린 메뉴 닫기
  const existing = document.getElementById('bulkDropdown');
  if (existing) { existing.remove(); return; }

  const codes   = [...AppState.checkedCodes];
  if (!codes.length) return;

  const tabs    = Storage.getTabs();
  const othTabs = tabs.filter(t => t.uid !== Storage.getActiveTabId());
  if (!othTabs.length) { showToast('이동/복사할 다른 그룹이 없습니다.', 'warn'); return; }

  const dd = document.createElement('div');
  dd.id        = 'bulkDropdown';
  dd.className = 'bulk-dropdown';
  dd.innerHTML = othTabs.map(t => `
    <button class="bulk-dd-item" data-tab="${t.uid}">
      <i class="fas fa-${type === 'move' ? 'sign-out-alt' : 'clone'}"></i> ${t.name}
    </button>`).join('');

  dd.querySelectorAll('.bulk-dd-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      dd.remove();
      const toTabUid = btn.dataset.tab;
      const toTab    = Storage.getTabs().find(t => t.uid === toTabUid);
      let n;
      if (type === 'move') {
        n = await Storage.moveStocks(codes, toTabUid);
        codes.forEach(c => { delete AppState.watchData[c]; Charts.dispose(`spark-${c}`); });
        AppState.checkedCodes.clear();
        renderTabs(); renderList(); updateDeleteBtn();
      } else {
        n = await Storage.copyStocks(codes, toTabUid);
      }
      showToast(
        n > 0
          ? `✅ ${n}개 종목 → <b>${toTab?.name}</b> ${type === 'move' ? '이동' : '복사'} 완료`
          : `이미 <b>${toTab?.name}</b>에 존재하는 종목입니다.`,
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
  dd.style.top      = (rect.bottom + 4) + 'px';
  dd.style.left     = rect.left + 'px';
  document.body.appendChild(dd);
}

/** 각 행에 우클릭 이벤트 바인딩 */
function _bindRowContextMenu(row, stock) {
  row.addEventListener('contextmenu', e => {
    e.preventDefault();
    // 우클릭한 종목이 체크된 경우 → 체크된 전체 대상
    // 아닌 경우 → 우클릭 단일 종목
    const codes = AppState.checkedCodes.has(stock.code) && AppState.checkedCodes.size > 1
      ? [...AppState.checkedCodes]
      : [stock.code];
    const label = codes.length > 1
      ? `${codes.length}개 종목 선택`
      : `${stock.name || stock.code}`;
    _showCtxMenu(e.pageX, e.pageY, codes, label);
  });
}

/** 상단 이동/복사 버튼 초기화 */
function initMoveButtons() {
  const btnMove = document.getElementById('btnMoveSelected');
  const btnCopy = document.getElementById('btnCopySelected');
  if (btnMove) btnMove.addEventListener('click', () => _toggleBulkDropdown('move', btnMove));
  if (btnCopy) btnCopy.addEventListener('click', () => _toggleBulkDropdown('copy', btnCopy));

  // ── 순서 이동 버튼 ─────────────────────────────────────────────
  async function _moveOrder(direction) {
    if (!AppState.checkedCodes.size) return;
    const tab      = Storage.getActiveTab();
    if (!tab) return;
    const stocks   = [...tab.stocks];            // 현재 순서 배열
    const selected = new Set(AppState.checkedCodes);
    const codes    = stocks.map(s => s.code);    // 코드 순서

    if (direction === 'top') {
      // 선택 항목을 맨 앞으로: 선택된 것 먼저, 나머지 뒤에
      const sel   = codes.filter(c => selected.has(c));
      const rest  = codes.filter(c => !selected.has(c));
      codes.splice(0, codes.length, ...sel, ...rest);

    } else if (direction === 'bot') {
      // 선택 항목을 맨 뒤로
      const sel   = codes.filter(c => selected.has(c));
      const rest  = codes.filter(c => !selected.has(c));
      codes.splice(0, codes.length, ...rest, ...sel);

    } else if (direction === 'up') {
      // 선택 항목 각각 한 칸 위로 (이미 맨 위에 모여 있으면 정지)
      for (let i = 1; i < codes.length; i++) {
        if (selected.has(codes[i]) && !selected.has(codes[i - 1])) {
          [codes[i - 1], codes[i]] = [codes[i], codes[i - 1]];
        }
      }
    } else if (direction === 'down') {
      // 선택 항목 각각 한 칸 아래로 (이미 맨 아래에 모여 있으면 정지)
      for (let i = codes.length - 2; i >= 0; i--) {
        if (selected.has(codes[i]) && !selected.has(codes[i + 1])) {
          [codes[i], codes[i + 1]] = [codes[i + 1], codes[i]];
        }
      }
    }

    await Storage.reorderStocks(codes);
    renderList();
  }

  document.getElementById('btnMoveTop') ?.addEventListener('click', () => _moveOrder('top'));
  document.getElementById('btnMoveUp')  ?.addEventListener('click', () => _moveOrder('up'));
  document.getElementById('btnMoveDown')?.addEventListener('click', () => _moveOrder('down'));
  document.getElementById('btnMoveBot') ?.addEventListener('click', () => _moveOrder('bot'));
}

/* ══════════════════════════════════════════════
   새로고침 버튼
══════════════════════════════════════════════ */
function initRefreshBtn() {
  const btn = document.getElementById('btnRefresh');
  btn.addEventListener('click', async () => {
    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> 새로고침 중...';
    await doRefreshAll();
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-sync-alt"></i> 새로고침';
    showToast('전체 종목 업데이트 완료', 'success');
  });
}

/* ══════════════════════════════════════════════
   S&P500 동기화 버튼
══════════════════════════════════════════════ */
function initSP500Btn() {
  const btn = document.getElementById('btnSP500');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 동기화 중...';

    try {
      // ① 서버 API 호출 → bb_tabs에 S&P500 탭 UPSERT
      const res = await fetch('/api/sp500/sync', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // ② config 재로드 — 서버 데이터 최신화
      await Storage.init();

      // ③ S&P500 탭으로 전환
      const tabs = Storage.getTabs();
      const sp500Tab = tabs.find(t => t.name === 'S&P500');
      if (sp500Tab) {
        await Storage.setActiveTabId(sp500Tab.uid);
      }

      // ④ UI 갱신
      renderTabs();
      renderList();

      const msg = `S&P500 동기화 완료 — ${data.total}개 종목`
        + (data.added   ? ` (+${data.added} 신규)`   : '')
        + (data.removed ? ` (-${data.removed} 제외)` : '');
      showToast(msg, 'success');

    } catch (e) {
      console.error('[SP500] 동기화 실패:', e);
      showToast('S&P500 동기화 실패: ' + e.message, 'error');
    } finally {
      btn.disabled  = false;
      btn.innerHTML = '<i class="fas fa-chart-line"></i> S&amp;P';
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
  initAddTab();
  initSearch();
  initSortHeaders();
  initColResizers();
  initCheckAll();
  initDeleteBtn();
  initMoveButtons();
  initRefreshBtn();
  initSP500Btn();
  initModal();

  renderTabs();
  renderList();

  // 전체 탭 종목 주가 초기 로드
  const allStocks = [];
  const seen = new Set();
  Storage.getTabs().forEach(t => t.stocks.forEach(s => {
    if (!seen.has(s.code)) { seen.add(s.code); allStocks.push(s); }
  }));

  if (allStocks.length) {
    // watchData에 모든 종목 키 선점 (null)
    allStocks.forEach(s => {
      if (!Object.prototype.hasOwnProperty.call(AppState.watchData, s.code)) {
        AppState.watchData[s.code] = null;
      }
    });

    // 초기 로딩: POST /api/stock/batch (DB only, 서버 내부 병렬)
    // 로딩 표시 없음 — 종목별로 즉시 교체
    await API.fetchBatch(allStocks, AppState.candleCount, AppState.listInterval,
      (code, res, err) => {
        if (res) {
          AppState.watchData[code] = Indicators.analyzeAll(res);
          _refreshListItem(code);
        } else {
          console.warn(`[${code}] 초기 로드 실패:`, err?.message);
        }
      }
    );

    setLastUpdated();
    // watchData → AppState.fundamentals 동기화 (리스트 펀더멘털·섹터 표시)
    _syncFundamentalsFromWatchData();
    renderList();
  }
}

document.addEventListener('DOMContentLoaded', init);
