/**
 * storage.js — 서버 Table API 기반 데이터 관리
 * 모든 기기/브라우저에서 동일 데이터 공유
 *
 * 테이블:
 *   bb_tabs         : { id(서버UUID), name, sort_order, stocks(JSON문자열) }
 *   bb_settings     : { id(서버UUID), key(설정키), value }
 *   bb_fundamentals : { id=ticker, ticker, trailing_pe, eps, beta,
 *                       fetched_at, fetch_failed }
 *
 * 설정 키: active_tab / candle_count / interval
 *
 * 중요: _saveSetting은 항상 서버의 실제 데이터 기준으로 upsert한다.
 *        메모리 캐시만 보고 POST/PATCH를 결정하면 다기기 환경에서 중복이 생긴다.
 */
const Storage = (() => {

  /* ─── 메모리 캐시 ─── */
  let _tabs         = [];   // [{ uid, name, sort_order, stocks[] }]
  let _settings     = {};   // { key: { uid, value } }  uid = 서버 row id
  let _activeTab    = null; // tab uid
  let _initDone     = false;
  let _fundamentals = {};   // ticker → { trailingPE, eps, beta, fetchedAt, fetchFailed }

  /* ─── REST 헬퍼 ─── */
  async function _req(method, path, body) {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (method === 'DELETE') return res.status;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${method} ${path} → ${res.status} ${txt.slice(0, 120)}`);
    }
    return res.json();
  }

  const _get   = (tbl, qs = '') => _req('GET',   `tables/${tbl}?limit=500${qs ? '&' + qs : ''}`);
  const _post  = (tbl, body)    => _req('POST',  `tables/${tbl}`, body);
  const _patch = (tbl, id, b)   => _req('PATCH', `tables/${tbl}/${id}`, b);
  const _del   = (tbl, id)      => _req('DELETE', `tables/${tbl}/${id}`);

  /* ─── 내부 헬퍼 ─── */
  function _parseJSON(raw, fallback) {
    if (Array.isArray(raw)) return raw;
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  const _sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ─── 초기 로드 (앱 시작 1회) ─── */
  async function init() {
    /* ① 탭 로드 — 최대 3회 재시도 */
    let tabRows = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await _get('bb_tabs');
        tabRows = res.data || [];
        break;
      } catch (e) {
        console.warn(`[Storage] bb_tabs 로드 실패 (${attempt + 1}/3):`, e.message);
        if (attempt < 2) await _sleep(800);
      }
    }

    _tabs = tabRows
      .map(r => ({
        uid:        r.id,
        name:       r.name || '기본',
        sort_order: r.sort_order ?? 0,
        stocks:     _parseJSON(r.stocks, []),
      }))
      .sort((a, b) => a.sort_order - b.sort_order);

    /* 탭 없으면 기본 탭 생성 */
    if (!_tabs.length) {
      try {
        const row = await _post('bb_tabs', { name: '기본', sort_order: 0, stocks: '[]' });
        _tabs = [{ uid: row.id, name: '기본', sort_order: 0, stocks: [] }];
      } catch (e) {
        console.error('[Storage] 기본 탭 생성 실패:', e.message);
        _tabs = [{ uid: 'local_tmp_' + Date.now(), name: '기본', sort_order: 0, stocks: [] }];
      }
    }

    /* ② 설정 로드 — 서버에서 전체 가져와 key 기준으로 캐시 구성 */
    await _loadSettings();

    /* ③ active_tab 검증 */
    const savedActive = _settings['active_tab']?.value;
    const validTab = _tabs.find(t => t.uid === savedActive);
    _activeTab = validTab ? savedActive : _tabs[0]?.uid;

    /* ④ 펀더멘털 로드 */
    await _loadFundamentals();

    /* ⑤ 구버전 LocalStorage → 서버 1회 마이그레이션 */
    await _migrateLocalStorage();

    _initDone = true;
    console.info(`[Storage] init 완료: 탭 ${_tabs.length}개, 설정 ${Object.keys(_settings).length}개, activeTab=${_activeTab}`);
  }

  /* 설정 전체 로드 (key 기준 중복 제거) */
  async function _loadSettings() {
    let rows = [];
    try {
      const res = await _get('bb_settings');
      rows = res.data || [];
    } catch (e) {
      console.warn('[Storage] bb_settings 로드 실패:', e.message);
    }

    _settings = {};
    // key 기준으로 마지막 항목 우선 (중복이 있을 경우 가장 최신 값 사용)
    rows.forEach(r => {
      const k = (r.key && r.key !== r.id) ? r.key : null;
      if (!k) return; // key 필드 없는 row는 무시
      // 같은 key가 여러 개면 마지막 것을 사용 (서버 반환 순서 = 생성 순서)
      _settings[k] = { uid: r.id, value: r.value ?? '' };
    });

    // 중복 key 서버 정리 (백그라운드)
    _cleanDuplicateSettings(rows).catch(() => {});
  }

  /* 중복 settings key 백그라운드 정리 */
  async function _cleanDuplicateSettings(rows) {
    const keyFirst = {}; // key → 보존할 첫 번째 id
    const toDelete = [];
    rows.forEach(r => {
      const k = (r.key && r.key !== r.id) ? r.key : null;
      if (!k) return;
      if (keyFirst[k]) {
        toDelete.push(r.id); // 중복 → 삭제 대상
      } else {
        keyFirst[k] = r.id;
      }
    });
    for (const id of toDelete) {
      try { await _del('bb_settings', id); } catch {}
    }
    if (toDelete.length) {
      console.info(`[Storage] 중복 설정 ${toDelete.length}개 정리 완료`);
    }
  }

  /* ─── 펀더멘털 로드 ─── */
  async function _loadFundamentals() {
    try {
      const res = await _get('bb_fundamentals');
      const rows = res.data || [];
      _fundamentals = {};
      rows.forEach(r => {
        if (!r.ticker) return;
        _fundamentals[r.ticker] = {
          trailingPE:  r.trailing_pe  ?? null,
          eps:         r.eps          ?? null,
          beta:        r.beta         ?? null,
          fetchedAt:   r.fetched_at   ?? 0,
          fetchFailed: r.fetch_failed ?? false,
          _rowId:      r.id,
        };
      });
      console.info(`[Storage] 펀더멘털 ${Object.keys(_fundamentals).length}건 로드`);
    } catch (e) {
      console.warn('[Storage] 펀더멘털 로드 실패:', e.message);
    }
  }

  /* ─── 펀더멘털 조회 (앱 → Storage) ─── */
  // 전체 맵 반환: { ticker → fundData }
  function getFundamentals() {
    return { ..._fundamentals };
  }

  /* ─── 펀더멘털 저장/갱신 (upsert) ───────────────────────────────
   * ticker 기준 upsert:
   *   - 메모리에 _rowId 있음 → PATCH
   *   - 없음 → POST (id = ticker 로 지정)
   * ─────────────────────────────────────────────────────────────── */
  async function saveFundamental(ticker, data) {
    const key    = ticker.toUpperCase();
    const cached = _fundamentals[key];
    const payload = {
      ticker:       key,
      trailing_pe:  data.trailingPE ?? null,
      eps:          data.eps        ?? null,
      beta:         data.beta       ?? null,
      fetched_at:   data.fetchedAt  ?? Date.now(),
      fetch_failed: data.fetchFailed ?? false,
    };

    try {
      if (cached?._rowId) {
        // 기존 row PATCH
        await _patch('bb_fundamentals', cached._rowId, payload);
        _fundamentals[key] = { ...data, _rowId: cached._rowId };
      } else {
        // 신규 POST — id를 ticker로 지정 (서버가 UUID 대신 사용)
        const row = await _post('bb_fundamentals', { id: key, ...payload });
        _fundamentals[key] = { ...data, _rowId: row.id };
      }
    } catch (e) {
      console.warn(`[Storage] 펀더멘털 저장 실패 (${key}):`, e.message);
      // 서버 저장 실패해도 메모리는 업데이트 (앱 표시는 유지)
      _fundamentals[key] = { ...data, _rowId: cached?._rowId ?? null };
    }
  }

  /* ─── LocalStorage 마이그레이션 ─── */
  async function _migrateLocalStorage() {
    try {
      const raw = localStorage.getItem('bb_tabs');
      if (!raw) return;
      const oldTabs = JSON.parse(raw);
      if (!Array.isArray(oldTabs) || !oldTabs.length) return;
      if (_tabs.length === 1 && _tabs[0].stocks.length === 0) {
        for (let i = 0; i < oldTabs.length; i++) {
          const ot = oldTabs[i];
          if (i === 0) {
            _tabs[0].name   = ot.name || '기본';
            _tabs[0].stocks = ot.stocks || [];
            await _patchTab(_tabs[0]);
          } else {
            const row = await _post('bb_tabs', {
              name: ot.name || `그룹${i + 1}`,
              sort_order: i,
              stocks: JSON.stringify(ot.stocks || []),
            });
            _tabs.push({ uid: row.id, name: ot.name || `그룹${i+1}`, sort_order: i, stocks: ot.stocks || [] });
          }
        }
        console.info('[Storage] LocalStorage 마이그레이션 완료');
      }
    } catch (e) {
      console.warn('[Storage] 마이그레이션 실패:', e.message);
    } finally {
      ['bb_tabs','bb_active_tab','bb_candle_count','bb_interval','bb_watchlist','bb_period',
       'bb_fundamentals_v1','bb_fundamentals_ts_v1']
        .forEach(k => { try { localStorage.removeItem(k); } catch {} });
    }
  }

  /* ─── 탭 서버 저장 ─── */
  async function _patchTab(tab) {
    if (!tab.uid || tab.uid.startsWith('local_tmp_')) return;
    try {
      await _patch('bb_tabs', tab.uid, {
        name:       tab.name,
        sort_order: tab.sort_order,
        stocks:     JSON.stringify(tab.stocks),
      });
    } catch (e) {
      console.warn('[Storage] 탭 저장 실패:', e.message);
    }
  }

  /* ─── 설정 저장 (안전한 upsert) ─────────────────────────────
   * 전략:
   *   1. 메모리 캐시에 해당 key가 있으면 → PATCH
   *   2. 없으면 → POST
   *   3. PATCH가 404 실패하면 → 캐시 재로드 후 재결정
   * 이렇게 하면 다기기 환경에서 중복 POST가 발생하지 않는다.
   ─────────────────────────────────────────────────────────── */
  async function _saveSetting(key, value) {
    const str = String(value);

    if (_settings[key]?.uid) {
      // 캐시에 있음 → PATCH 시도
      try {
        await _patch('bb_settings', _settings[key].uid, { value: str });
        _settings[key].value = str;
        return;
      } catch (e) {
        // 404: 서버에 해당 row가 없음 → 캐시 오염. 재로드 후 다시 시도
        console.warn(`[Storage] 설정 PATCH 실패 (${key}):`, e.message);
        await _loadSettings();
      }
    }

    if (_settings[key]?.uid) {
      // 재로드 후 있으면 PATCH
      try {
        await _patch('bb_settings', _settings[key].uid, { value: str });
        _settings[key].value = str;
        return;
      } catch (e) {
        console.warn(`[Storage] 재시도 PATCH 실패 (${key}):`, e.message);
      }
    } else {
      // 서버에도 없음 → POST
      try {
        const row = await _post('bb_settings', { key, value: str });
        _settings[key] = { uid: row.id, value: str };
        return;
      } catch (e) {
        console.warn(`[Storage] 설정 POST 실패 (${key}):`, e.message);
        // 실패해도 메모리 캐시는 업데이트 (앱은 계속 동작)
        _settings[key] = { uid: null, value: str };
      }
    }
  }

  /* ─── 탭 API ─── */
  function getTabs()        { return _tabs; }
  function getActiveTabId() { return _activeTab || _tabs[0]?.uid; }
  function getActiveTab()   { return _tabs.find(t => t.uid === getActiveTabId()) || _tabs[0]; }

  async function setActiveTabId(uid) {
    _activeTab = uid;
    await _saveSetting('active_tab', uid);
  }

  async function addTab(name) {
    const maxOrder = _tabs.reduce((m, t) => Math.max(m, t.sort_order ?? 0), -1);
    try {
      const row = await _post('bb_tabs', { name: name || '새 그룹', sort_order: maxOrder + 1, stocks: '[]' });
      const tab = { uid: row.id, name: row.name || name, sort_order: maxOrder + 1, stocks: [] };
      _tabs.push(tab);
      await setActiveTabId(tab.uid);
      return tab;
    } catch (e) {
      console.error('[Storage] 탭 추가 실패:', e.message);
      throw e;
    }
  }

  async function renameTab(uid, name) {
    const tab = _tabs.find(t => t.uid === uid);
    if (!tab) return;
    tab.name = name;
    await _patchTab(tab);
  }

  async function removeTab(uid) {
    if (_tabs.length <= 1) return false;
    _tabs = _tabs.filter(t => t.uid !== uid);
    try { await _del('bb_tabs', uid); } catch (e) { console.warn('[Storage] 탭 삭제 실패:', e.message); }
    if (getActiveTabId() === uid) await setActiveTabId(_tabs[0]?.uid);
    return true;
  }

  async function reorderTabs(orderedUids) {
    const map = Object.fromEntries(_tabs.map(t => [t.uid, t]));
    _tabs = orderedUids.map(uid => map[uid]).filter(Boolean);
    _tabs.forEach((t, i) => { t.sort_order = i; });
    await Promise.all(_tabs.map(t => _patchTab(t)));
  }

  /* ─── 종목 API ─── */
  function getWatchlist(tabUid) {
    const id  = tabUid || getActiveTabId();
    const tab = _tabs.find(t => t.uid === id);
    return tab ? [...(tab.stocks || [])] : [];
  }

  async function addStock(stock, tabUid) {
    const tab = _tabs.find(t => t.uid === (tabUid || getActiveTabId()));
    if (!tab) return false;
    if (!tab.stocks) tab.stocks = [];
    tab.stocks.push({
      code:   stock.code,
      name:   stock.name,
      market: stock.market || 'KS',
    });
    await _patchTab(tab);
    return true;
  }

  async function removeStocks(codes, tabUid) {
    const tab = _tabs.find(t => t.uid === (tabUid || getActiveTabId()));
    if (!tab) return;
    const set = new Set(Array.isArray(codes) ? codes : [codes]);
    tab.stocks = (tab.stocks || []).filter(s => !set.has(s.code));
    await _patchTab(tab);
  }

  /* ── 종목 복사: 현재 탭 → 대상 탭 (이미 있으면 스킵) ── */
  async function copyStocks(codes, toTabUid) {
    const fromTab = _tabs.find(t => t.uid === getActiveTabId());
    const toTab   = _tabs.find(t => t.uid === toTabUid);
    if (!fromTab || !toTab || fromTab.uid === toTab.uid) return 0;
    const set     = new Set(Array.isArray(codes) ? codes : [codes]);
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
    if (count) await _patchTab(toTab);
    return count;
  }

  /* ── 종목 이동: 현재 탭에서 제거 → 대상 탭에 추가 (이미 있으면 이동 탭에서만 제거) ── */
  async function moveStocks(codes, toTabUid) {
    const fromTab = _tabs.find(t => t.uid === getActiveTabId());
    const toTab   = _tabs.find(t => t.uid === toTabUid);
    if (!fromTab || !toTab || fromTab.uid === toTab.uid) return 0;
    const set     = new Set(Array.isArray(codes) ? codes : [codes]);
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
    // 원본 탭에서 제거 (대상 탭에 이미 있던 것 포함, 선택된 것 모두 제거)
    fromTab.stocks = (fromTab.stocks || []).filter(s => !set.has(s.code));
    await Promise.all([_patchTab(fromTab), count ? _patchTab(toTab) : Promise.resolve()]);
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
    await _patchTab(tab);
  }

  /* ── 종목 이름 교정: 깨진 이름을 API 정제 이름으로 갱신 ── */
  async function updateStockName(code, newName) {
    if (!code || !newName) return;
    let changed = false;
    for (const tab of _tabs) {
      const stock = (tab.stocks || []).find(s => s.code === code);
      if (stock && stock.name !== newName) {
        stock.name = newName;
        await _patchTab(tab);
        changed = true;
      }
    }
    return changed;
  }

  /* ─── 설정 API ─── */
  function getCandleCount() {
    const v = parseInt(_settings['candle_count']?.value, 10);
    return [10, 20, 30, 40, 50].includes(v) ? v : 40;
  }
  async function setCandleCount(n) {
    await _saveSetting('candle_count', n);
  }

  function getInterval() {
    return _settings['interval']?.value === '1wk' ? '1wk' : '1d';
  }
  async function setInterval(v) {
    await _saveSetting('interval', v === '1wk' ? '1wk' : '1d');
  }

  /* ─── 호환 shim ─── */
  function saveTabs() {}

  return {
    init,
    getTabs, getActiveTabId, setActiveTabId, getActiveTab,
    addTab, renameTab, removeTab, reorderTabs, saveTabs,
    getWatchlist, addStock, removeStocks, reorderStocks, copyStocks, moveStocks, updateStockName,
    getCandleCount, setCandleCount, getInterval, setInterval,
    getFundamentals, saveFundamental,
  };
})();
