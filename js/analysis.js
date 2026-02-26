/**
 * analysis.js — 종목분석 탭 로직
 *
 * app.js의 완전한 복제본이되, 모든 DOM ID에 'an-' 접두사를 사용하고
 * 상태 객체(AnState)와 Storage 네임스페이스(an_tabs / an_settings)를
 * 관심종목 탭과 완전히 분리한다.
 *
 * 공통 유틸(showToast, showGlobalLoading, openModal, Charts, API,
 * Indicators, fmtPrice 등)은 app.js에서 선언된 것을 그대로 사용한다.
 */

/* ══════════════════════════════════════════════
   독립 상태
══════════════════════════════════════════════ */
const AnState = {
  candleCount:     52,
  previewInterval: '1d',
  listInterval:    '1d',
  previewData:  null,
  previewCode:  null,
  watchData:    {},
  fundamentals: {},
  sortCol:      null,
  sortDir:      'asc',
  checkedCodes: new Set(),
};

/* ══════════════════════════════════════════════
   Storage 네임스페이스 — 관심종목과 완전히 독립
   (bb_tabs_an / bb_settings_an 테이블 사용)
══════════════════════════════════════════════ */
const AnStorage = (() => {
  // ── 내부 상태 ──────────────────────────────
  let _tabs     = [];   // [{ uid, name, stocks:[] }]
  let _settings = {};   // { interval, activeTabId, ... }
  const SETTINGS_KEY = 'an_settings';
  const TABS_KEY     = 'an_tabs';

  // ── UID 생성 ────────────────────────────────
  function _uid() {
    return Math.random().toString(36).slice(2, 10) +
           Math.random().toString(36).slice(2, 10);
  }

  // ── REST 헬퍼 ────────────────────────────────
  async function _get(table) {
    const r = await fetch(`tables/${table}?limit=1000`);
    if (!r.ok) throw new Error(`GET ${table} HTTP ${r.status}`);
    return (await r.json()).data || [];
  }
  async function _post(table, body) {
    const r = await fetch(`tables/${table}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${table} HTTP ${r.status}`);
    return r.json();
  }
  async function _patch(table, id, body) {
    const r = await fetch(`tables/${table}/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`PATCH ${table}/${id} HTTP ${r.status}`);
    return r.json();
  }
  async function _del(table, id) {
    const r = await fetch(`tables/${table}/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`DELETE ${table}/${id} HTTP ${r.status}`);
  }

  // ── 탭 직렬화 / 역직렬화 ───────────────────
  function _serializeTab(tab) {
    return { id: tab.uid, name: tab.name, stocks: JSON.stringify(tab.stocks || []) };
  }
  function _deserializeTab(row) {
    let stocks = [];
    try { stocks = JSON.parse(row.stocks || '[]'); } catch (_) {}
    return { uid: row.id, name: row.name || '그룹1', stocks, _rowId: row.id };
  }

  // ── 초기화 ──────────────────────────────────
  async function init() {
    // 탭 로드
    try {
      const rows = await _get(TABS_KEY);
      _tabs = rows.map(_deserializeTab);
    } catch (_) { _tabs = []; }

    // 기본 탭 없으면 생성
    if (!_tabs.length) {
      const uid  = _uid();
      const row  = await _post(TABS_KEY, { id: uid, name: 'S&P 500', stocks: '[]' });
      _tabs = [{ uid, name: 'S&P 500', stocks: [], _rowId: row.id }];
    }

    // 설정 로드 + rowId 저장 (PATCH에 사용)
    try {
      const rows = await _get(SETTINGS_KEY);
      rows.forEach(r => {
        _settings[r.key] = r.value;
        _settingsRowIds[r.key] = r.id;  // PATCH용 rowId 저장
      });
    } catch (_) {}

    // activeTab 검증
    if (!_tabs.find(t => t.uid === _settings.activeTabId)) {
      _settings.activeTabId = _tabs[0].uid;
    }

    console.info(`[AnStorage] init 완료: 탭 ${_tabs.length}개, activeTab=${_settings.activeTabId}`);
  }

  // ── 탭 조회 ────────────────────────────────
  function getTabs()        { return _tabs; }
  function getActiveTabId() { return _settings.activeTabId || _tabs[0]?.uid; }
  function getActiveTab()   { return _tabs.find(t => t.uid === getActiveTabId()) || null; }
  function getWatchlist()   { return getActiveTab()?.stocks || []; }

  async function setActiveTabId(uid) {
    _settings.activeTabId = uid;
    await _syncSetting('activeTabId', uid);
  }

  // ── 탭 추가 ────────────────────────────────
  async function addTab(name) {
    const uid = _uid();
    const row = await _post(TABS_KEY, { id: uid, name, stocks: '[]' });
    _tabs.push({ uid, name, stocks: [], _rowId: row.id });
    await setActiveTabId(uid);
  }

  // ── 탭 삭제 ────────────────────────────────
  async function removeTab(uid) {
    const idx = _tabs.findIndex(t => t.uid === uid);
    if (idx === -1) return;
    try { await _del(TABS_KEY, _tabs[idx]._rowId || uid); } catch (_) {}
    _tabs.splice(idx, 1);
    if (getActiveTabId() === uid) {
      await setActiveTabId(_tabs[0]?.uid || '');
    }
  }

  // ── 탭 이름 변경 ────────────────────────────
  async function renameTab(uid, name) {
    const tab = _tabs.find(t => t.uid === uid);
    if (!tab) return;
    tab.name = name;
    await _patchTab(tab);
  }

  // ── 탭 순서 변경 ────────────────────────────
  async function reorderTabs(orderedUids) {
    const map = new Map(_tabs.map(t => [t.uid, t]));
    _tabs = orderedUids.map(uid => map.get(uid)).filter(Boolean);
    // 서버에 순서 반영 (각 탭에 sort_order 필드가 없으므로 이름만 재저장)
    // 실제로는 UI상 순서만 로컬에서 유지
  }

  // ── 종목 추가 ────────────────────────────────
  async function addStock(stock) {
    const tab = getActiveTab();
    if (!tab) return;
    const exists = tab.stocks.find(s => s.code === stock.code);
    if (exists) { showToast(`${stock.name || stock.code} 이미 등록됨`, 'warn'); return; }
    tab.stocks.push({ code: stock.code, name: stock.name || stock.code, market: stock.market || '' });
    await _patchTab(tab);
  }

  // ── 종목 삭제 ────────────────────────────────
  async function removeStocks(codes) {
    const tab = getActiveTab();
    if (!tab) return;
    const codeSet = new Set(codes);
    tab.stocks = tab.stocks.filter(s => !codeSet.has(s.code));
    await _patchTab(tab);
  }

  // ── 종목 순서 변경 ───────────────────────────
  async function reorderStocks(orderedCodes) {
    const tab = getActiveTab();
    if (!tab) return;
    const map = new Map(tab.stocks.map(s => [s.code, s]));
    tab.stocks = orderedCodes.map(c => map.get(c)).filter(Boolean);
    await _patchTab(tab);
  }

  // ── 종목 이동 ────────────────────────────────
  async function moveStocks(codes, toTabUid) {
    const from = getActiveTab();
    const to   = _tabs.find(t => t.uid === toTabUid);
    if (!from || !to) return 0;
    const codeSet = new Set(codes);
    let moved = 0;
    for (const code of codes) {
      const s = from.stocks.find(x => x.code === code);
      if (!s) continue;
      if (to.stocks.find(x => x.code === code)) continue;
      to.stocks.push({ ...s });
      moved++;
    }
    from.stocks = from.stocks.filter(s => !codeSet.has(s.code));
    await Promise.all([_patchTab(from), _patchTab(to)]);
    return moved;
  }

  // ── 종목 복사 ────────────────────────────────
  async function copyStocks(codes, toTabUid) {
    const from = getActiveTab();
    const to   = _tabs.find(t => t.uid === toTabUid);
    if (!from || !to) return 0;
    let copied = 0;
    for (const code of codes) {
      const s = from.stocks.find(x => x.code === code);
      if (!s) continue;
      if (to.stocks.find(x => x.code === code)) continue;
      to.stocks.push({ ...s });
      copied++;
    }
    await _patchTab(to);
    return copied;
  }

  // ── 이름 교정 ────────────────────────────────
  async function updateStockName(code, name) {
    let changed = false;
    _tabs.forEach(tab => {
      const s = tab.stocks.find(x => x.code === code);
      if (s && s.name !== name) { s.name = name; changed = true; }
    });
    if (!changed) return;
    const affected = _tabs.filter(tab => tab.stocks.find(x => x.code === code));
    await Promise.all(affected.map(tab => _patchTab(tab)));
  }

  // ── 인터벌 ────────────────────────────────
  function getInterval() { return _settings.interval || '1d'; }
  async function setInterval(v) {
    _settings.interval = v;
    await _syncSetting('interval', v);
  }

  // ── 내부 헬퍼 ────────────────────────────────
  async function _patchTab(tab) {
    try {
      await _patch(TABS_KEY, tab._rowId || tab.uid, _serializeTab(tab));
    } catch (e) {
      console.warn('[AnStorage] 탭 저장 실패:', e.message);
    }
  }

  let _settingsRowIds = {};
  async function _syncSetting(key, value) {
    try {
      if (_settingsRowIds[key]) {
        await _patch(SETTINGS_KEY, _settingsRowIds[key], { key, value });
      } else {
        const row = await _post(SETTINGS_KEY, { id: `an_${key}`, key, value });
        _settingsRowIds[key] = row.id;
      }
    } catch (e) {
      console.warn('[AnStorage] 설정 저장 실패:', e?.message);
    }
  }

  return {
    init, getTabs, getActiveTabId, getActiveTab, getWatchlist,
    setActiveTabId, addTab, removeTab, renameTab, reorderTabs,
    addStock, removeStocks, reorderStocks, moveStocks, copyStocks,
    updateStockName, getInterval, setInterval,
  };
})();

/* ══════════════════════════════════════════════
   펀더멘털 서버 저장 (관심종목과 같은 bb_fundamentals 테이블 공유)
══════════════════════════════════════════════ */
async function _anSaveFundamentalToServer(code, data) {
  const hasValue = data.trailingPE != null || data.eps != null || data.beta != null;
  if (!hasValue) return;
  try {
    await Storage.saveFundamental(code, {
      trailingPE: data.trailingPE, eps: data.eps, beta: data.beta,
      fetchedAt: Date.now(), fetchFailed: false,
    });
  } catch(e) {
    console.warn(`[An 펀더멘털 저장 실패] ${code}:`, e.message);
  }
}

/* ══════════════════════════════════════════════
   DOM 헬퍼 — 'an-' 접두사 ID 조회
══════════════════════════════════════════════ */
function _anEl(id) { return document.getElementById('an-' + id); }

/* ══════════════════════════════════════════════
   일봉/주봉 토글
══════════════════════════════════════════════ */
function anInitHeaderControls() {
  AnState.previewInterval = AnStorage.getInterval();
  const container = _anEl('intervalToggle');
  if (!container) return;
  container.querySelectorAll('.interval-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.interval === AnState.previewInterval);
    btn.addEventListener('click', async () => {
      if (AnState.previewInterval === btn.dataset.interval) return;
      AnState.previewInterval = btn.dataset.interval;
      await AnStorage.setInterval(AnState.previewInterval);
      container.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (AnState.previewCode) anDoSearch(AnState.previewCode);
    });
  });
  AnState.candleCount = 52;
}

/* ══════════════════════════════════════════════
   탭 관리
══════════════════════════════════════════════ */
function anRenderTabs() {
  const tabs     = AnStorage.getTabs();
  const activeId = AnStorage.getActiveTabId();
  const listEl   = _anEl('tabList');
  if (!listEl) return;
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
      await AnStorage.setActiveTabId(tab.uid);
      AnState.checkedCodes.clear();
      anRenderTabs(); anRenderList(); anUpdateStockCount();
    });

    el.querySelector('.tab-label').addEventListener('dblclick', e => {
      e.stopPropagation();
      anStartTabRename(tab.uid, el.querySelector('.tab-label'));
    });

    el.querySelector('.tab-close').addEventListener('click', async e => {
      e.stopPropagation();
      if (AnStorage.getTabs().length <= 1) { showToast('마지막 탭은 삭제할 수 없습니다.', 'warn'); return; }
      if (!confirm(`"${tab.name}" 탭을 삭제하시겠습니까?\n(탭 내 종목도 모두 삭제됩니다)`)) return;
      await AnStorage.removeTab(tab.uid);
      anRenderTabs(); anRenderList(); anUpdateStockCount();
      showToast(`"${tab.name}" 탭이 삭제되었습니다.`, 'info');
    });

    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData('an-tab-id', tab.uid);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging-tab');
    });
    el.addEventListener('dragend',  () => el.classList.remove('dragging-tab'));
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over-tab'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over-tab'));
    el.addEventListener('drop', async e => {
      e.preventDefault(); el.classList.remove('drag-over-tab');
      const fromId = e.dataTransfer.getData('an-tab-id');
      if (!fromId || fromId === tab.uid) return;
      const ordered = AnStorage.getTabs().map(t => t.uid);
      const fi = ordered.indexOf(fromId), ti = ordered.indexOf(tab.uid);
      ordered.splice(fi, 1); ordered.splice(ti, 0, fromId);
      await AnStorage.reorderTabs(ordered); anRenderTabs();
    });

    listEl.appendChild(el);
  });
}

function anStartTabRename(tabId, labelEl) {
  const input = _anEl('tabRenameInput');
  if (!input) return;
  const rect  = labelEl.getBoundingClientRect();
  input.value = labelEl.textContent;
  input.style.cssText = `display:block;position:fixed;left:${rect.left}px;top:${rect.top}px;` +
                        `width:${Math.max(80, rect.width + 20)}px;z-index:2000;`;
  input.focus(); input.select();
  const finish = async () => {
    const val = input.value.trim();
    if (val) await AnStorage.renameTab(tabId, val);
    input.style.display = 'none';
    input.removeEventListener('blur', finish);
    input.removeEventListener('keydown', onKey);
    anRenderTabs();
  };
  const onKey = e => {
    if (e.key === 'Enter') finish();
    if (e.key === 'Escape') { input.style.display = 'none'; anRenderTabs(); }
  };
  input.addEventListener('blur', finish, { once: true });
  input.addEventListener('keydown', onKey);
}

function anInitAddTab() {
  const btn = _anEl('btnAddTab');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const name = prompt('새 그룹 이름:', `그룹${AnStorage.getTabs().length + 1}`);
    if (name === null) return;
    await AnStorage.addTab(name.trim() || `그룹${AnStorage.getTabs().length}`);
    anRenderTabs(); anRenderList(); anUpdateStockCount();
  });
}

/* ══════════════════════════════════════════════
   검색 & 미리보기
══════════════════════════════════════════════ */
function anInitSearch() {
  const inp = _anEl('stockInput');
  if (!inp) return;
  inp.addEventListener('input', () => {
    const v = inp.value.trim();
    inp.dataset.market = !v ? '' : /^\d+$/.test(v) ? 'KRX' : 'US';
  });

  _anEl('btnSearch').addEventListener('click', () => {
    const raw = inp.value.trim();
    if (!raw) { anShowSearchError('종목코드 또는 티커를 입력하세요.'); return; }
    anDoSearch(raw);
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') _anEl('btnSearch').click();
  });

  _anEl('btnRegister').addEventListener('click', async () => {
    if (!AnState.previewData) return;
    const { code, name, market } = AnState.previewData;
    await AnStorage.addStock({ code, name, market });
    AnState.watchData[code] = AnState.previewData;
    anRenderList(); anUpdateStockCount();
    showToast(`✅ <b>${name}</b> 등록 완료!`, 'success');
  });
}

async function anDoSearch(input) {
  anHidePreview(); anHideSearchError(); anShowSearchLoading(true);
  AnState.previewCode = input.toUpperCase();
  try {
    const raw      = await API.fetchStock(input, AnState.candleCount, AnState.previewInterval);
    const analyzed = Indicators.analyzeAll(raw);
    AnState.previewCode = analyzed.code;
    AnState.previewData = analyzed;
    if (Object.prototype.hasOwnProperty.call(AnState.watchData, analyzed.code)) {
      AnState.watchData[analyzed.code] = analyzed;
      _anRefreshListItem(analyzed.code);
      _anFixStockNameIfNeeded(analyzed.code, analyzed.name);
    }
    anRenderPreview(analyzed);
  } catch (err) {
    AnState.previewCode = null;
    anShowSearchError(err.message || '데이터를 가져오는 데 실패했습니다.');
  } finally {
    anShowSearchLoading(false);
  }
}

/* ══════════════════════════════════════════════
   상관관계
══════════════════════════════════════════════ */
function _anCalcCorrelations(targetCode) {
  const targetData = AnState.watchData[targetCode];
  if (!targetData?.allCandles?.length) return null;
  const tab = AnStorage.getActiveTab();
  if (!tab) return null;
  const others = tab.stocks.filter(s => s.code !== targetCode);
  if (!others.length) return null;

  const results = [];
  for (const s of others) {
    const d = AnState.watchData[s.code];
    if (!d?.allCandles?.length) continue;
    const r = _pearson(targetData.allCandles, d.allCandles); // app.js의 _pearson 재사용
    if (r === null) continue;
    results.push({ code: s.code, name: d.name || s.name || s.code, r });
  }
  if (!results.length) return null;
  results.sort((a, b) => b.r - a.r);

  const posCode = results[0].code;
  const negCode = results[results.length - 1].code;
  const neuCandidates = results.filter(x => x.code !== posCode && x.code !== negCode);
  const neuPool = neuCandidates.length ? neuCandidates : results;
  const neu = neuPool.reduce((best, x) => Math.abs(x.r) < Math.abs(best.r) ? x : best);

  return { pos: results[0], neu, neg: results[results.length - 1] };
}

function anRenderCorrSection(targetCode) {
  const sec = _anEl('corrSection');
  if (!sec) return;
  const result = _anCalcCorrelations(targetCode);
  if (!result) { sec.style.display = 'none'; return; }

  const { pos, neu, neg } = result;
  const barColor = r => r >= 0 ? 'var(--up)' : 'var(--down)';
  const rFmt     = r => (r >= 0 ? '+' : '') + r.toFixed(2);

  const makeRow = (item, badgeClass, badgeText) => {
    const row   = document.createElement('div');
    row.className = 'corr-row';
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
      _anEl('stockInput').value = item.code;
      anDoSearch(item.code);
    };
    nameEl.addEventListener('click', onClick);
    codeEl.addEventListener('click', onClick);
    row.append(badge, score, nameEl, codeEl);
    return row;
  };

  sec.innerHTML = '';
  sec.appendChild(makeRow(pos, 'corr-badge-pos', '양'));
  sec.appendChild(makeRow(neu, 'corr-badge-neu', '중'));
  sec.appendChild(makeRow(neg, 'corr-badge-neg', '음'));
  sec.style.display = 'flex';
}

/* ══════════════════════════════════════════════
   미리보기 렌더링
══════════════════════════════════════════════ */
function anRenderPreview(data) {
  const { name, code, market, currentPrice, isUS, interval,
          todayChange, todayChangePct, change, changePct,
          bb, alert: al } = data;

  _anEl('previewName').textContent  = name;
  _anEl('previewCode').textContent  = data.ticker;
  _anEl('previewPrice').textContent = fmtPrice(currentPrice, isUS);
  _anEl('previewIntervalBadge').textContent = interval === '1wk' ? '주봉' : '일봉';

  const todayEl = _anEl('previewTodayChange');
  if (todayEl) {
    todayEl.textContent = `${fmtChg(todayChange, isUS)} (${fmtPct(todayChangePct)})`;
    todayEl.className   = 'preview-today-chg ' + (todayChange >= 0 ? 'up' : 'down');
  }
  const periodLbl = _anEl('previewPeriodLabel');
  if (periodLbl) {
    periodLbl.textContent = interval === '1wk'
      ? `${AnState.candleCount}주` : `${AnState.candleCount}일`;
  }
  const chgEl = _anEl('previewChange');
  if (chgEl) {
    chgEl.textContent = `${fmtChg(change, isUS)} (${fmtPct(changePct)})`;
    chgEl.className   = 'preview-change ' + (change >= 0 ? 'up' : 'down');
  }
  const alertEl = _anEl('previewAlert');
  if (alertEl) {
    alertEl.textContent = al.stars;
    alertEl.className   = `preview-alert alert-lv${al.level}`;
  }

  if (bb) {
    const pct  = (al.ratio * 100).toFixed(1);
    const fill = _anEl('previewBBFill');
    if (fill) { fill.style.width = pct + '%'; fill.className = `bb-bar-fill lv${al.level}`; }
    const marker = _anEl('previewBBMarker');
    if (marker) marker.style.left = pct + '%';

    const setBBBand = (pctId, priceId, band) => {
      const pctEl   = _anEl(pctId);
      const priceEl = _anEl(priceId);
      if (!pctEl && !priceEl) return;
      const v   = ((band - currentPrice) / currentPrice) * 100;
      const cls = v >= 0 ? 'pct-up' : 'pct-down';
      if (pctEl)   { pctEl.textContent   = (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; pctEl.className   = 'bb-pct-val ' + cls; }
      if (priceEl) { priceEl.textContent = fmtPrice(band, isUS);                      priceEl.className = 'bb-pct-price ' + cls; }
    };
    setBBBand('previewBBUpperPct',  'previewBBUpperPrice',  bb.upper);
    setBBBand('previewBBMiddlePct', 'previewBBMiddlePrice', bb.middle);
    setBBBand('previewBBLowerPct',  'previewBBLowerPrice',  bb.lower);
  }

  _anEl('leftPanelTitle').innerHTML =
    `<i class="fas fa-chart-area"></i> ${name} ` +
    `<small style="font-size:11px;color:var(--text-muted)">${data.ticker}</small>`;

  const regBtn = _anEl('btnRegister');
  regBtn.disabled = false;
  regBtn.innerHTML = '<i class="fas fa-plus-circle"></i> 등록';
  regBtn.style.display = 'flex';
  _anEl('previewCard').style.display = 'flex';

  anRenderCorrSection(data.code);

  ['eomSection', 'rsiStochSection'].forEach(id => {
    const el = _anEl(id);
    if (el) el.style.display = 'block';
  });

  setTimeout(() => {
    Charts.renderMini('an-previewChart', data);
    Charts.renderEOM('an-eomChart', data);
    Charts.renderRSIStoch('an-rsiStochChart', data);
  }, 50);
}

async function anShowStockPreview(code) {
  const cached = AnState.watchData[code];
  _anEl('stockInput').value = cached?.ticker || code;
  if (cached) {
    AnState.previewCode = code;
    AnState.previewData = cached;
    anRenderPreview(cached);
    _anBgRefreshStock(cached.ticker || code, code);
    return;
  }
  anDoSearch(code);
}

async function _anBgRefreshStock(input, registeredCode) {
  try {
    const raw      = await API.fetchStock(input, AnState.candleCount, AnState.listInterval);
    const analyzed = Indicators.analyzeAll(raw);
    const code     = registeredCode || analyzed.code;
    if (Object.prototype.hasOwnProperty.call(AnState.watchData, code)) {
      AnState.watchData[code] = analyzed;
      _anRefreshListItem(code);
      _anFixStockNameIfNeeded(code, analyzed.name);
    }
  } catch (_) {}
}

function anHidePreview() {
  _anEl('previewCard').style.display = 'none';
  const regBtn = _anEl('btnRegister');
  regBtn.style.display = 'none'; regBtn.disabled = true;
  _anEl('leftPanelTitle').innerHTML = '<i class="fas fa-search"></i> 종목 검색';
  ['eomSection', 'rsiStochSection'].forEach(id => {
    const el = _anEl(id);
    if (el) el.style.display = 'none';
  });
  Charts.dispose('an-eomChart');
  Charts.dispose('an-rsiStochChart');
}
function anShowSearchError(msg) {
  _anEl('searchErrorMsg').textContent = msg;
  _anEl('searchError').style.display = 'flex';
}
function anHideSearchError()    { _anEl('searchError').style.display = 'none'; }
function anShowSearchLoading(v) { _anEl('searchLoading').style.display = v ? 'flex' : 'none'; }

/* ══════════════════════════════════════════════
   전체 새로고침
══════════════════════════════════════════════ */
async function anDoRefreshAll() {
  const allCodes  = new Set();
  const allStocks = [];
  AnStorage.getTabs().forEach(tab => {
    tab.stocks.forEach(s => {
      if (!allCodes.has(s.code)) { allCodes.add(s.code); allStocks.push(s); }
    });
  });
  if (!allStocks.length) return;

  const total  = allStocks.length;
  let done     = 0;
  const loadEl = _anEl('listLoading');
  const setMsg = msg => { const s = loadEl?.querySelector('span'); if (s) s.textContent = msg; };
  if (loadEl) loadEl.style.display = 'flex';
  setMsg(`데이터 로드 중... (0/${total})`);

  allStocks.forEach(s => {
    if (!Object.prototype.hasOwnProperty.call(AnState.watchData, s.code))
      AnState.watchData[s.code] = null;
  });

  await API.fetchMultiple(allStocks, AnState.candleCount, AnState.listInterval, (code, res, err) => {
    done++;
    if (res) {
      const analyzed = Indicators.analyzeAll(res);
      AnState.watchData[code] = analyzed;
      _anRefreshListItem(code);
      if (analyzed.name) _anFixStockNameIfNeeded(code, analyzed.name);
    } else {
      console.warn(`[An][${code}] 조회 실패:`, err?.message);
    }
    setMsg(`데이터 로드 중... (${done}/${total})`);
  });

  if (loadEl) loadEl.style.display = 'none';
  anRenderList();
  if (AnState.previewCode && AnState.watchData[AnState.previewCode]) {
    AnState.previewData = AnState.watchData[AnState.previewCode];
    anRenderPreview(AnState.previewData);
  }

  _anFetchAllFundamentals(allStocks).catch(e => console.warn('[An 펀더멘털 bg]', e?.message));
}

/* ══════════════════════════════════════════════
   펀더멘털 배치 조회
══════════════════════════════════════════════ */
const _AN_EMPTY_FUND = Object.freeze({ trailingPE: null, eps: null, beta: null });

async function _anFetchAllFundamentals(stocks) {
  if (!stocks.length) return;

  const seen = new Set();
  const uniq = stocks.filter(s => {
    const key = s.code.toUpperCase().replace(/\.(KS|KQ)$/, '');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  const tickers       = uniq.map(s => s.code.toUpperCase());
  const stockByTicker = new Map(uniq.map(s => [s.code.toUpperCase(), s]));
  const total  = tickers.length;
  const CHUNK  = 10;
  const chunks = [];
  for (let i = 0; i < total; i += CHUNK) chunks.push(tickers.slice(i, i + CHUNK));

  console.log(`[An 펀더멘털] 배치 시작 ${total}건 → ${chunks.length}청크`);

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const batchResult = await API.fetchFundamentalsBatch(chunk);
    for (const ticker of chunk) {
      const s        = stockByTicker.get(ticker);
      const cacheKey = ticker.replace(/\.(KS|KQ)$/, '');
      const data     = batchResult.get(ticker) ?? { ..._AN_EMPTY_FUND, _fetchFailed: true };
      if (!data._fetchFailed) {
        const fd = { ...data };
        AnState.fundamentals[s.code]   = fd;
        AnState.fundamentals[cacheKey] = fd;
        if (/^\d{5,6}$/.test(cacheKey)) AnState.fundamentals[cacheKey + '.KS'] = fd;
        _anRefreshListItem(s.code);
        _anSaveFundamentalToServer(cacheKey, fd);
      }
    }
    console.log(`[An 펀더멘털] 청크 ${ci + 1}/${chunks.length} 완료`);
  }
}

function _anFixStockNameIfNeeded(code, cleanName) {
  if (!cleanName) return;
  AnStorage.updateStockName(code, cleanName).catch(e =>
    console.warn('[An 이름교정]', code, e?.message)
  );
}

/* ══════════════════════════════════════════════
   리스트 렌더링
══════════════════════════════════════════════ */
function anRenderList() {
  const watchlist = AnStorage.getWatchlist();
  const listEl    = _anEl('stockList');
  const emptyEl   = _anEl('emptyState');
  anUpdateStockCount();
  if (!listEl) return;

  if (!watchlist.length) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = 'flex';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  let sorted = [...watchlist];
  if (AnState.sortCol) sorted = _anSortList(sorted, AnState.sortCol, AnState.sortDir);

  listEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  sorted.forEach(stock => {
    const data = AnState.watchData[stock.code];
    frag.appendChild(_anBuildListItem(stock, data));
  });
  listEl.appendChild(frag);

  AnState.checkedCodes.forEach(code => {
    const cb = document.getElementById(`an-cb-${code}`);
    if (cb) cb.checked = true;
  });
  if (AnState.previewCode) _anHighlightActiveRow(AnState.previewCode);
  anUpdateDeleteBtn();
}

function _anBuildListItem(stock, data) {
  const item = document.createElement('div');
  item.className    = 'stock-item an-item';
  item.dataset.code = stock.code;

  const al   = data?.alert || { level: 0, stars: '', label: '--', ratio: 0.5 };
  if (al.ratio == null) al.ratio = 0.5;
  const isUS = data?.isUS ?? (stock.market === 'US');

  const priceStr     = data ? fmtPrice(data.currentPrice, isUS) : '--';
  const todayPctVal  = data?.todayChangePct ?? 0;
  const todayChgVal  = data?.todayChange    ?? 0;
  const todayStr     = data ? fmtPct(todayPctVal) : '--';
  const todayUpDown  = data ? (todayChgVal >= 0 ? 'up' : 'down') : '';
  const periodPctVal = data?.changePct ?? 0;
  const periodChgVal = data?.change    ?? 0;
  const periodStr    = data ? fmtPct(periodPctVal) : '--';
  const periodUpDown = data ? (periodChgVal >= 0 ? 'up' : 'down') : '';
  const bbPct        = (al.ratio * 100).toFixed(1);

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
    bbUpperPct = u.str; bbUpperCls = u.cls;
    bbMiddlePct = m.str; bbMiddleCls = m.cls;
    bbLowerPct = l.str; bbLowerCls = l.cls;
  }

  const fd      = AnState.fundamentals[stock.code] || {};
  const trailPE = fmtFundNum(fd.trailingPE);
  const epsVal  = fmtFundNum(fd.eps);
  const betaVal = fmtFundNum(fd.beta);
  const betaCls = fd.beta != null ? (fd.beta >= 1 ? 'fund-up' : 'fund-down') : '';

  item.innerHTML = `
    <div class="col-check">
      <input type="checkbox" id="an-cb-${stock.code}" data-code="${stock.code}" />
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
    <div class="col-trail-pe fund-val">${trailPE}</div>
    <div class="col-eps      fund-val">${epsVal}</div>
    <div class="col-beta     fund-val ${betaCls}">${betaVal}</div>
    <div class="col-action">
      <button class="btn-detail" data-code="${stock.code}" title="상세 차트">
        <i class="fas fa-chart-bar"></i>
      </button>
    </div>`;

  // querySelector에서 특수문자(. / 등) 포함된 코드 안전 처리
  const cbEl = document.getElementById(`an-cb-${stock.code}`);
  if (cbEl) cbEl.addEventListener('change', e => {
    if (e.target.checked) AnState.checkedCodes.add(stock.code);
    else AnState.checkedCodes.delete(stock.code);
    _anSyncCheckAll(); anUpdateDeleteBtn();
  });
  const detailBtn = item.querySelector('.btn-detail');
  if (detailBtn) detailBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (data) openModal(data); // app.js의 openModal 재사용
  });
  item.addEventListener('click', e => {
    if (e.target.closest('input[type="checkbox"]')) return;
    if (e.target.closest('.btn-detail')) return;
    anShowStockPreview(stock.code);
    _anHighlightActiveRow(stock.code);
  });
  return item;
}

function _anHighlightActiveRow(code) {
  // an-item 클래스로 범위 한정 — 관심종목 행과 충돌 방지
  document.querySelectorAll('.an-item').forEach(el =>
    el.classList.toggle('row-active', el.dataset.code === code)
  );
}

function anUpdateStockCount() {
  const el = _anEl('stockCount');
  if (el) el.textContent = AnStorage.getWatchlist().length;
}

function _anRefreshListItem(code) {
  const el = document.querySelector(`.an-item[data-code="${code}"]`);
  if (!el) return;

  const data = AnState.watchData[code];
  if (data?.name) { const ne = el.querySelector('.item-name'); if (ne) ne.textContent = data.name; }
  if (data?.ticker) { const ce = el.querySelector('.item-code'); if (ce) ce.textContent = data.ticker; }

  const fd = AnState.fundamentals[code] || {};
  const _set = (sel, val, cls) => {
    const e2 = el.querySelector(sel);
    if (!e2) return;
    e2.textContent = val;
    if (cls !== undefined) e2.className = `fund-val ${cls}`;
  };
  _set('.col-trail-pe', fmtFundNum(fd.trailingPE));
  _set('.col-eps',      fmtFundNum(fd.eps));
  _set('.col-beta',     fmtFundNum(fd.beta),
    fd.beta != null ? (fd.beta >= 1 ? 'fund-up' : 'fund-down') : '');

  if (!data) return;

  const al   = data.alert || { level: 0, stars: '', label: '--', ratio: 0.5 };
  const isUS = data.isUS;

  const alertEl = el.querySelector('.col-alert');
  if (alertEl) alertEl.innerHTML =
    al.level === 2 ? `<span class="star-badge lv2">★★</span>`
    : al.level === 1 ? `<span class="star-badge lv1">★</span>`
    : '<span class="no-alert">—</span>';

  const priceEl = el.querySelector('.col-price');
  if (priceEl) priceEl.innerHTML = `<span class="item-price">${fmtPrice(data.currentPrice, isUS)}</span>`;

  const todayEl = el.querySelector('.col-today-chg');
  if (todayEl) {
    todayEl.textContent = fmtPct(data.todayChangePct ?? 0);
    todayEl.className   = `col-today-chg ${(data.todayChange ?? 0) >= 0 ? 'up' : 'down'}`;
  }
  const chgEl = el.querySelector('.col-change');
  if (chgEl) {
    chgEl.textContent = fmtPct(data.changePct ?? 0);
    chgEl.className   = `col-change ${(data.change ?? 0) >= 0 ? 'up' : 'down'}`;
  }

  const bbFill = el.querySelector('.bb-pos-fill');
  if (bbFill) {
    bbFill.style.width = (al.ratio * 100).toFixed(1) + '%';
    bbFill.className   = `bb-pos-fill lv${al.level}`;
  }
  const bbMarker = el.querySelector('.bb-pos-marker');
  if (bbMarker) bbMarker.style.left = (al.ratio * 100).toFixed(1) + '%';

  if (data.bb && data.currentPrice) {
    const cur = data.currentPrice;
    const calcPct = (band) => {
      const v = ((band - cur) / cur) * 100;
      return { str: (v >= 0 ? '+' : '') + v.toFixed(2) + '%', cls: v >= 0 ? 'pct-up' : 'pct-down' };
    };
    const pctItems = el.querySelectorAll('.bb-band-pct-item');
    const vals = [calcPct(data.bb.lower), calcPct(data.bb.middle), calcPct(data.bb.upper)];
    pctItems.forEach((itm, i) => {
      const valEl = itm.querySelector('.bb-band-pct-val');
      if (valEl) { valEl.textContent = vals[i].str; valEl.className = `bb-band-pct-val ${vals[i].cls}`; }
    });
  }
}

/* ══════════════════════════════════════════════
   정렬
══════════════════════════════════════════════ */
function anInitSortHeaders() {
  // tab-analysis 컨테이너 내의 sort-col만 선택 — 관심종목 헤더와 충돌 방지
  const container = document.getElementById('tab-analysis');
  if (!container) return;
  container.querySelectorAll('.sort-col').forEach(span => {
    span.addEventListener('click', e => {
      e.stopPropagation();
      const col = span.dataset.col;
      if (AnState.sortCol === col) AnState.sortDir = AnState.sortDir === 'asc' ? 'desc' : 'asc';
      else { AnState.sortCol = col; AnState.sortDir = col === 'alert' ? 'desc' : 'asc'; }
      _anUpdateSortIcons(); anRenderList();
    });
  });
}

function _anSortList(list, col, dir) {
  return [...list].sort((a, b) => {
    const da = AnState.watchData[a.code], db = AnState.watchData[b.code];
    let va, vb;
    switch (col) {
      case 'alert':    va = da?.alert?.level    ?? -1;       vb = db?.alert?.level    ?? -1;       break;
      case 'name':     va = (da?.name || a.code).toLowerCase(); vb = (db?.name || b.code).toLowerCase(); break;
      case 'price':    va = da?.currentPrice    ?? -Infinity; vb = db?.currentPrice    ?? -Infinity; break;
      case 'todayChg': va = da?.todayChangePct  ?? -Infinity; vb = db?.todayChangePct  ?? -Infinity; break;
      case 'change':   va = da?.changePct       ?? -Infinity; vb = db?.changePct       ?? -Infinity; break;
      case 'bbRatio':  va = da?.bbRatio         ?? -1;       vb = db?.bbRatio         ?? -1;       break;
      case 'trailPE':  va = AnState.fundamentals[a.code]?.trailingPE ?? -Infinity; vb = AnState.fundamentals[b.code]?.trailingPE ?? -Infinity; break;
      case 'eps':      va = AnState.fundamentals[a.code]?.eps        ?? -Infinity; vb = AnState.fundamentals[b.code]?.eps        ?? -Infinity; break;
      case 'beta':     va = AnState.fundamentals[a.code]?.beta       ?? -Infinity; vb = AnState.fundamentals[b.code]?.beta       ?? -Infinity; break;
      default: return 0;
    }
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ?  1 : -1;
    return 0;
  });
}

function _anUpdateSortIcons() {
  const container = document.getElementById('tab-analysis');
  if (!container) return;
  container.querySelectorAll('.sort-col').forEach(th => {
    const col = th.dataset.col;
    const el  = th.querySelector('.sort-icon');
    if (!el) return;
    el.innerHTML = AnState.sortCol === col
      ? (AnState.sortDir === 'asc'
          ? '<i class="fas fa-sort-up active-sort"></i>'
          : '<i class="fas fa-sort-down active-sort"></i>')
      : '<i class="fas fa-sort"></i>';
  });
}

/* ══════════════════════════════════════════════
   컬럼 리사이저
══════════════════════════════════════════════ */
function anInitColResizers() {
  const CSS = {
    'an-alert':'--col-alert','an-name':'--col-name','an-price':'--col-price',
    'an-todayChg':'--col-today-chg','an-change':'--col-change','an-bbRatio':'--col-bb',
    'an-trailPE':'--col-trail-pe','an-eps':'--col-eps','an-beta':'--col-beta',
  };
  const MIN = { 'an-alert':48,'an-name':70,'an-price':70,'an-todayChg':60,'an-change':60,
                'an-bbRatio':120,'an-trailPE':40,'an-eps':40,'an-beta':40 };
  const container = document.getElementById('tab-analysis');
  if (!container) return;

  container.querySelectorAll('.col-resizer').forEach(h => {
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
function anInitCheckAll() {
  const cb = _anEl('checkAll');
  if (!cb) return;
  cb.addEventListener('change', e => {
    AnStorage.getWatchlist().forEach(s => {
      const c = document.getElementById(`an-cb-${s.code}`);
      if (c) c.checked = e.target.checked;
      if (e.target.checked) AnState.checkedCodes.add(s.code);
      else AnState.checkedCodes.delete(s.code);
    });
    anUpdateDeleteBtn();
  });
}
function _anSyncCheckAll() {
  const total   = AnStorage.getWatchlist().length;
  const checked = AnState.checkedCodes.size;
  const cb = _anEl('checkAll');
  if (!cb) return;
  cb.checked       = total > 0 && checked === total;
  cb.indeterminate = checked > 0 && checked < total;
}
function anUpdateDeleteBtn() {
  const n   = AnState.checkedCodes.size;
  const btn = _anEl('btnDeleteSelected');
  if (!btn) return;
  btn.disabled  = n === 0;
  btn.innerHTML = `<i class="fas fa-trash-alt"></i> 선택 삭제${n > 0 ? ` (${n})` : ''}`;

  const hasMultiTab = AnStorage.getTabs().length > 1;
  const btnMove = _anEl('btnMoveSelected');
  const btnCopy = _anEl('btnCopySelected');
  if (btnMove) btnMove.disabled = n === 0 || !hasMultiTab;
  if (btnCopy) btnCopy.disabled = n === 0 || !hasMultiTab;

  const dis = n === 0;
  ['btnMoveTop','btnMoveUp','btnMoveDown','btnMoveBot'].forEach(id => {
    const b = _anEl(id);
    if (b) b.disabled = dis;
  });
}
function anInitDeleteBtn() {
  const btn = _anEl('btnDeleteSelected');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!AnState.checkedCodes.size) return;
    const names = [...AnState.checkedCodes].map(c => AnState.watchData[c]?.name || c).join(', ');
    if (!confirm(`[${names}] 을(를) 삭제하시겠습니까?`)) return;
    AnState.checkedCodes.forEach(code => {
      delete AnState.watchData[code];
      Charts.dispose(`an-spark-${code}`);
      if (AnState.previewCode === code) {
        anHidePreview();
        AnState.previewCode = null;
        AnState.previewData = null;
        _anEl('stockInput').value = '';
      }
    });
    await AnStorage.removeStocks([...AnState.checkedCodes]);
    AnState.checkedCodes.clear();
    anUpdateDeleteBtn(); anRenderList();
    showToast('삭제 완료', 'info');
  });
}

/* ══════════════════════════════════════════════
   이동 / 복사 버튼
══════════════════════════════════════════════ */
function anInitMoveButtons() {
  const btnMove = _anEl('btnMoveSelected');
  const btnCopy = _anEl('btnCopySelected');
  if (btnMove) btnMove.addEventListener('click', () => _anToggleBulkDropdown('move', btnMove));
  if (btnCopy) btnCopy.addEventListener('click', () => _anToggleBulkDropdown('copy', btnCopy));

  async function _anMoveOrder(direction) {
    if (!AnState.checkedCodes.size) return;
    const tab = AnStorage.getActiveTab();
    if (!tab) return;
    const stocks   = [...tab.stocks];
    const selected = new Set(AnState.checkedCodes);
    const codes    = stocks.map(s => s.code);

    if (direction === 'top') {
      const sel = codes.filter(c => selected.has(c));
      const rest = codes.filter(c => !selected.has(c));
      codes.splice(0, codes.length, ...sel, ...rest);
    } else if (direction === 'bot') {
      const sel = codes.filter(c => selected.has(c));
      const rest = codes.filter(c => !selected.has(c));
      codes.splice(0, codes.length, ...rest, ...sel);
    } else if (direction === 'up') {
      for (let i = 1; i < codes.length; i++) {
        if (selected.has(codes[i]) && !selected.has(codes[i - 1]))
          [codes[i - 1], codes[i]] = [codes[i], codes[i - 1]];
      }
    } else if (direction === 'down') {
      for (let i = codes.length - 2; i >= 0; i--) {
        if (selected.has(codes[i]) && !selected.has(codes[i + 1]))
          [codes[i], codes[i + 1]] = [codes[i + 1], codes[i]];
      }
    }
    await AnStorage.reorderStocks(codes);
    anRenderList();
  }

  _anEl('btnMoveTop') ?.addEventListener('click', () => _anMoveOrder('top'));
  _anEl('btnMoveUp')  ?.addEventListener('click', () => _anMoveOrder('up'));
  _anEl('btnMoveDown')?.addEventListener('click', () => _anMoveOrder('down'));
  _anEl('btnMoveBot') ?.addEventListener('click', () => _anMoveOrder('bot'));
}

function _anToggleBulkDropdown(type, anchorEl) {
  const existing = document.getElementById('an-bulkDropdown');
  if (existing) { existing.remove(); return; }
  const codes   = [...AnState.checkedCodes];
  if (!codes.length) return;
  const tabs    = AnStorage.getTabs();
  const othTabs = tabs.filter(t => t.uid !== AnStorage.getActiveTabId());
  if (!othTabs.length) { showToast('이동/복사할 다른 그룹이 없습니다.', 'warn'); return; }

  const dd = document.createElement('div');
  dd.id        = 'an-bulkDropdown';
  dd.className = 'bulk-dropdown';
  dd.innerHTML = othTabs.map(t => `
    <button class="bulk-dd-item" data-tab="${t.uid}">
      <i class="fas fa-${type === 'move' ? 'sign-out-alt' : 'clone'}"></i> ${t.name}
    </button>`).join('');

  dd.querySelectorAll('.bulk-dd-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      dd.remove();
      const toTabUid = btn.dataset.tab;
      const toTab    = AnStorage.getTabs().find(t => t.uid === toTabUid);
      let n;
      if (type === 'move') {
        n = await AnStorage.moveStocks(codes, toTabUid);
        codes.forEach(c => { delete AnState.watchData[c]; Charts.dispose(`an-spark-${c}`); });
        AnState.checkedCodes.clear();
        anRenderTabs(); anRenderList(); anUpdateDeleteBtn();
      } else {
        n = await AnStorage.copyStocks(codes, toTabUid);
      }
      showToast(
        n > 0 ? `✅ ${n}개 종목 → <b>${toTab?.name}</b> ${type === 'move' ? '이동' : '복사'} 완료`
               : `이미 <b>${toTab?.name}</b>에 존재하는 종목입니다.`,
        n > 0 ? 'success' : 'warn'
      );
    });
  });

  const outsideClick = e => {
    if (!dd.contains(e.target) && e.target !== anchorEl) {
      dd.remove(); document.removeEventListener('click', outsideClick, true);
    }
  };
  document.addEventListener('click', outsideClick, true);
  const rect = anchorEl.getBoundingClientRect();
  dd.style.cssText = `position:fixed;top:${rect.bottom + 4}px;left:${rect.left}px;`;
  document.body.appendChild(dd);
}

/* ══════════════════════════════════════════════
   새로고침 버튼
══════════════════════════════════════════════ */
function anInitRefreshBtn() {
  const btn = _anEl('btnRefresh');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled  = true;
    btn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> 새로고침 중...';
    await anDoRefreshAll();
    btn.disabled  = false;
    btn.innerHTML = '<i class="fas fa-sync-alt"></i> 새로고침';
    showToast('전체 종목 업데이트 완료', 'success');
  });
}

/* ══════════════════════════════════════════════
   종목분석 탭 초기화 — 최상위 탭 전환 시 1회 실행
══════════════════════════════════════════════ */
let _anInitialized = false;

async function initAnalysisTab() {
  if (_anInitialized) return;
  _anInitialized = true;

  try { await AnStorage.init(); }
  catch (e) { console.error('[Analysis] AnStorage 초기화 실패:', e); }

  anInitHeaderControls();
  anInitAddTab();
  anInitSearch();
  anInitSortHeaders();
  anInitColResizers();
  anInitCheckAll();
  anInitDeleteBtn();
  anInitMoveButtons();
  anInitRefreshBtn();

  anRenderTabs();
  anRenderList();

  // 전체 탭 종목 주가 초기 로드 (app.js init과 동일한 방식)
  const allStocks = [];
  const seen = new Set();
  AnStorage.getTabs().forEach(t => t.stocks.forEach(s => {
    if (!seen.has(s.code)) { seen.add(s.code); allStocks.push(s); }
  }));

  if (allStocks.length) {
    const total  = allStocks.length;
    let done     = 0;
    const loadEl = _anEl('listLoading');
    const setMsg = msg => { const s = loadEl?.querySelector('span'); if (s) s.textContent = msg; };
    if (loadEl) loadEl.style.display = 'flex';
    setMsg(`데이터 로드 중... (0/${total})`);

    allStocks.forEach(s => {
      if (!Object.prototype.hasOwnProperty.call(AnState.watchData, s.code))
        AnState.watchData[s.code] = null;
    });

    await API.fetchMultipleFast(allStocks, AnState.candleCount, AnState.listInterval, (code, res, err) => {
      done++;
      if (res) {
        AnState.watchData[code] = Indicators.analyzeAll(res);
        _anRefreshListItem(code);
      } else {
        console.warn(`[An][${code}] 초기 로드 실패:`, err?.message);
      }
      setMsg(`데이터 로드 중... (${done}/${total})`);
    });

    if (loadEl) loadEl.style.display = 'none';
    anRenderList();

    _anFetchAllFundamentals(allStocks).catch(e => console.warn('[An 펀더멘털 bg]', e?.message));
  }

  console.log('[Analysis] 종목분석 탭 초기화 완료');
}

/* ══════════════════════════════════════════════
   최상위 탭 전환 훅
══════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const analysisBtn = document.querySelector('.app-tab[data-tab="analysis"]');
  if (analysisBtn) {
    analysisBtn.addEventListener('click', () => {
      initAnalysisTab();
    });
  }
});
