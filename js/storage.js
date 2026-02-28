/**
 * storage.js — /api/config 기반 데이터 관리
 *
 * 이전의 /tables/* REST 4개 → GET/POST /api/config 2개로 통합.
 *
 * 읽기: GET  /api/config  → { tabs, settings }
 * 쓰기: POST /api/config  → { tabs?, settings? }
 *
 * 설정 키: active_tab / preview_interval / list_interval
 */
const Storage = (() => {

  /* ─── 메모리 캐시 ─── */
  let _tabs = [];    // [{ uid, name, sort_order, stocks[] }]
  let _settings = {};    // { key: value }  (string → string)
  let _activeTab = null;

  /* ─── REST 헬퍼 ─── */
  async function _getConfig() {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`GET /api/config → ${res.status}`);
    return res.json();   // { tabs, settings }
  }

  async function _postConfig(body) {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST /api/config → ${res.status}`);
    return res.json();
  }

  /* ─── 탭 전체 서버 저장 ─── */
  async function _saveTabs() {
    try {
      await _postConfig({ tabs: _tabs });
    } catch (e) {
      console.warn('[Storage] 탭 저장 실패:', e.message);
    }
  }

  /* ─── 설정 저장 ─── */
  async function _saveSetting(key, value) {
    const str = String(value);
    _settings[key] = str;
    try {
      await _postConfig({ settings: { [key]: str } });
    } catch (e) {
      console.warn(`[Storage] 설정 저장 실패 (${key}):`, e.message);
    }
  }

  /* ─── 초기 로드 (앱 시작 1회) ─── */
  async function init() {
    let cfg;
    try {
      cfg = await _getConfig();
    } catch (e) {
      console.error('[Storage] /api/config 로드 실패:', e.message);
      cfg = { tabs: [], settings: {} };
    }

    _tabs = (cfg.tabs || []).map(t => ({
      uid: t.uid,
      name: t.name || '기본',
      sort_order: t.sort_order ?? 0,
      stocks: Array.isArray(t.stocks) ? t.stocks : [],
    })).sort((a, b) => a.sort_order - b.sort_order);

    if (!_tabs.length) {
      // 기본 탭 생성
      const newTab = { uid: crypto.randomUUID(), name: '기본', sort_order: 0, stocks: [] };
      _tabs = [newTab];
      await _saveTabs();
    }

    _settings = cfg.settings || {};

    const savedActive = _settings['active_tab'];
    const validTab = _tabs.find(t => t.uid === savedActive);
    _activeTab = validTab ? savedActive : _tabs[0]?.uid;

    /* 구버전 LocalStorage → 서버 1회 마이그레이션 */
    await _migrateLocalStorage();

    console.info(`[Storage] init 완료: 탭 ${_tabs.length}개, activeTab=${_activeTab}`);
  }

  /* ─── LocalStorage 마이그레이션 ─── */
  async function _migrateLocalStorage() {
    try {
      const raw = localStorage.getItem('bb_tabs');
      if (!raw) return;
      const oldTabs = JSON.parse(raw);
      if (!Array.isArray(oldTabs) || !oldTabs.length) return;
      if (_tabs.length === 1 && _tabs[0].stocks.length === 0) {
        _tabs = oldTabs.map((ot, i) => ({
          uid: crypto.randomUUID(),
          name: ot.name || (i === 0 ? '기본' : `그룹${i + 1}`),
          sort_order: i,
          stocks: ot.stocks || [],
        }));
        await _saveTabs();
        console.info('[Storage] LocalStorage 마이그레이션 완료');
      }
    } catch (e) {
      console.warn('[Storage] 마이그레이션 실패:', e.message);
    } finally {
      ['bb_tabs', 'bb_active_tab', 'bb_candle_count', 'bb_interval', 'bb_watchlist', 'bb_period',
        'bb_fundamentals_v1', 'bb_fundamentals_ts_v1']
        .forEach(k => { try { localStorage.removeItem(k); } catch { } });
    }
  }

  /* ─── 탭 API ─── */
  function getTabs() { return _tabs; }
  function getActiveTabId() { return _activeTab || _tabs[0]?.uid; }
  function getActiveTab() { return _tabs.find(t => t.uid === getActiveTabId()) || _tabs[0]; }

  async function setActiveTabId(uid) {
    _activeTab = uid;
    await _saveSetting('active_tab', uid);
  }

  async function addTab(name) {
    const maxOrder = _tabs.reduce((m, t) => Math.max(m, t.sort_order ?? 0), -1);
    const tab = { uid: crypto.randomUUID(), name: name || '새 그룹', sort_order: maxOrder + 1, stocks: [] };
    _tabs.push(tab);
    await _saveTabs();
    await setActiveTabId(tab.uid);
    return tab;
  }

  async function renameTab(uid, name) {
    const tab = _tabs.find(t => t.uid === uid);
    if (!tab) return;
    tab.name = name;
    await _saveTabs();
  }

  async function removeTab(uid) {
    if (_tabs.length <= 1) return false;
    _tabs = _tabs.filter(t => t.uid !== uid);
    await _saveTabs();
    if (getActiveTabId() === uid) await setActiveTabId(_tabs[0]?.uid);
    return true;
  }

  async function reorderTabs(orderedUids) {
    const map = Object.fromEntries(_tabs.map(t => [t.uid, t]));
    _tabs = orderedUids.map(uid => map[uid]).filter(Boolean);
    _tabs.forEach((t, i) => { t.sort_order = i; });
    await _saveTabs();
  }

  /* ─── 종목 API ─── */
  function getWatchlist(tabUid) {
    const id = tabUid || getActiveTabId();
    const tab = _tabs.find(t => t.uid === id);
    return tab ? [...(tab.stocks || [])] : [];
  }

  async function addStock(stock, tabUid) {
    const tab = _tabs.find(t => t.uid === (tabUid || getActiveTabId()));
    if (!tab) return false;
    if (!tab.stocks) tab.stocks = [];
    tab.stocks.push({ code: stock.code, name: stock.name, market: stock.market || 'KS' });
    await _saveTabs();
    return true;
  }

  async function removeStocks(codes, tabUid) {
    const tab = _tabs.find(t => t.uid === (tabUid || getActiveTabId()));
    if (!tab) return;
    const set = new Set(Array.isArray(codes) ? codes : [codes]);
    tab.stocks = (tab.stocks || []).filter(s => !set.has(s.code));
    await _saveTabs();
  }

  async function copyStocks(codes, toTabUid) {
    const fromTab = _tabs.find(t => t.uid === getActiveTabId());
    const toTab = _tabs.find(t => t.uid === toTabUid);
    if (!fromTab || !toTab || fromTab.uid === toTab.uid) return 0;
    const set = new Set(Array.isArray(codes) ? codes : [codes]);
    const already = new Set((toTab.stocks || []).map(s => s.code));
    let count = 0;
    (fromTab.stocks || []).forEach(s => {
      if (set.has(s.code) && !already.has(s.code)) {
        if (!toTab.stocks) toTab.stocks = [];
        toTab.stocks.push({ code: s.code, name: s.name, market: s.market || 'KS' });
        already.add(s.code);
        count++;
      }
    });
    if (count) await _saveTabs();
    return count;
  }

  async function moveStocks(codes, toTabUid) {
    const fromTab = _tabs.find(t => t.uid === getActiveTabId());
    const toTab = _tabs.find(t => t.uid === toTabUid);
    if (!fromTab || !toTab || fromTab.uid === toTab.uid) return 0;
    const set = new Set(Array.isArray(codes) ? codes : [codes]);
    const already = new Set((toTab.stocks || []).map(s => s.code));
    let count = 0;
    (fromTab.stocks || []).forEach(s => {
      if (set.has(s.code) && !already.has(s.code)) {
        if (!toTab.stocks) toTab.stocks = [];
        toTab.stocks.push({ code: s.code, name: s.name, market: s.market || 'KS' });
        already.add(s.code);
        count++;
      }
    });
    fromTab.stocks = (fromTab.stocks || []).filter(s => !set.has(s.code));
    await _saveTabs();
    return count;
  }

  async function reorderStocks(orderedCodes, tabUid) {
    const tab = _tabs.find(t => t.uid === (tabUid || getActiveTabId()));
    if (!tab) return;
    const remaining = [...(tab.stocks || [])];
    tab.stocks = orderedCodes.map(code => {
      const idx = remaining.findIndex(s => s.code === code);
      return idx === -1 ? null : remaining.splice(idx, 1)[0];
    }).filter(Boolean);
    await _saveTabs();
  }

  async function updateStockName(code, newName) {
    if (!code || !newName) return;
    let changed = false;
    for (const tab of _tabs) {
      const stock = (tab.stocks || []).find(s => s.code === code);
      if (stock && stock.name !== newName) {
        stock.name = newName;
        changed = true;
      }
    }
    if (changed) await _saveTabs();
    return changed;
  }

  /* ─── 설정 API ─── */
  function getPreviewInterval() {
    const val = _settings['preview_interval'] || _settings['interval'];
    return val === '1wk' ? '1wk' : '1d';
  }
  async function setPreviewInterval(v) {
    await _saveSetting('preview_interval', v === '1wk' ? '1wk' : '1d');
  }

  function getListInterval() {
    const val = _settings['list_interval'] || _settings['interval'];
    return val === '1wk' ? '1wk' : '1d';
  }
  async function setListInterval(v) {
    await _saveSetting('list_interval', v === '1wk' ? '1wk' : '1d');
  }

  function getCandleCount() {
    const v = parseInt(_settings['candle_count'], 10);
    return [10, 20, 30, 40, 50].includes(v) ? v : 40;
  }
  async function setCandleCount(n) {
    await _saveSetting('candle_count', n);
  }

  /* ─── 펀더멘털 (하위 호환 shim — 기능 없음, app.js가 watchData에서 직접 읽음) ─── */
  function getFundamentals() { return {}; }
  async function saveFundamental() { }

  /* ─── 호환 shim ─── */
  function saveTabs() { }

  return {
    init,
    getTabs, getActiveTabId, setActiveTabId, getActiveTab,
    addTab, renameTab, removeTab, reorderTabs, saveTabs,
    getWatchlist, addStock, removeStocks, reorderStocks, copyStocks, moveStocks, updateStockName,
    getCandleCount, setCandleCount, getPreviewInterval, setPreviewInterval, getListInterval, setListInterval,
    getFundamentals, saveFundamental,
  };
})();
