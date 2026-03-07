/**
 * backtest.js — 백테스팅 시뮬레이션 엔진 및 UI 핸들러
 */

const BacktestUI = {
    selectedStocks: [{ code: 'CASH', name: '현금', ticker: 'CASH', weight: 20 }], // { code, name, ticker, weight }
    scenarios: {},      // { name: config }

    init() {
        this.loadScenarios();
        this.bindEvents();
        this.initTabSelect();
        this.renderStockList(); // Make sure initial selectedStocks (like CASH) are rendered
        this.updateWeightSum();
        this.initInputFormatting();
        this.updatePeriodHint();
    },

    initInputFormatting() {
        const caps = [document.getElementById('btInitialCapital')];
        caps.forEach(inp => {
            inp.addEventListener('input', (e) => {
                let v = e.target.value.replace(/,/g, '');
                if (!isNaN(v) && v !== '') {
                    e.target.value = Number(v).toLocaleString();
                }
            });
            if (inp.value) inp.value = Number(inp.value.replace(/,/g, '')).toLocaleString();
        });

        const periodInp = document.getElementById('btPeriodMonths');
        if (periodInp) {
            periodInp.addEventListener('input', () => this.updatePeriodHint());
        }
    },

    updatePeriodHint() {
        const inp = document.getElementById('btPeriodMonths');
        const hint = document.getElementById('btPeriodDateHint');
        if (!inp || !hint) return;
        const months = Math.max(1, parseInt(inp.value) || 12);
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
        const fmt = d => `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
        hint.textContent = `${fmt(start)} ~`;
    },

    loadScenarios() {
        const saved = localStorage.getItem('bt_scenarios');
        this.scenarios = saved ? JSON.parse(saved) : {};
        this.renderScenarioSelect();
    },

    saveScenarios() {
        localStorage.setItem('bt_scenarios', JSON.stringify(this.scenarios));
        this.renderScenarioSelect();
    },

    renderScenarioSelect() {
        const sel = document.getElementById('btScenarioSelect');
        const current = sel.value;
        sel.innerHTML = '<option value="">-- 시나리오 선택 --</option>';
        Object.keys(this.scenarios).sort().forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
        });
        sel.value = current;
    },

    initTabSelect() {
        const tabs = Storage.getTabs();
        const sel = document.getElementById('btTabSelect');
        sel.innerHTML = '<option value="">-- 그룹 선택 --</option>';
        tabs.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.uid;
            opt.textContent = t.name;
            sel.appendChild(opt);
        });

        sel.addEventListener('change', (e) => {
            this.renderStockPicker(e.target.value);
        });
    },

    renderStockPicker(tabUid) {
        const area = document.getElementById('btStockPickArea');
        if (!tabUid) {
            area.innerHTML = '<p class="empty-hint">그룹을 먼저 선택하세요.</p>';
            return;
        }

        const stocks = Storage.getWatchlist(tabUid);
        if (stocks.length === 0) {
            area.innerHTML = '<p class="empty-hint">그룹에 등록된 종목이 없습니다.</p>';
            return;
        }

        area.innerHTML = '';

        // --- 현금 항목 고정 노출 (토글 체크박스) ---
        const cashItem = document.createElement('label');
        cashItem.className = 'stock-pick-item';
        const isCashSelected = this.selectedStocks.some(ss => ss.code === 'CASH');
        if (isCashSelected) cashItem.classList.add('active');
        cashItem.innerHTML = `
        <input type="checkbox" value="CASH" ${isCashSelected ? 'checked' : ''} />
        <span>현금</span>
        `;
        cashItem.querySelector('input').addEventListener('change', (e) => {
            if (e.target.checked) {
                const already = this.selectedStocks.find(ss => ss.code === 'CASH');
                if (!already) {
                    this.selectedStocks.unshift({
                        code: 'CASH',
                        name: '현금',
                        ticker: 'CASH',
                        weight: 20
                    });
                }
                cashItem.classList.add('active');
            } else {
                this.selectedStocks = this.selectedStocks.filter(ss => ss.code !== 'CASH');
                cashItem.classList.remove('active');
            }
            this.autoDistributeWeights();
            this.updateRebalanceTypeByStockCount();
            this.renderStockList();
            this.updateWeightSum();
        });
        area.appendChild(cashItem);
        // ------------------------------------------

        stocks.forEach(s => {
            const item = document.createElement('label');
            item.className = 'stock-pick-item';
            const isSelected = this.selectedStocks.some(ss => ss.code === s.code);
            if (isSelected) item.classList.add('active');

            item.innerHTML = `
        <input type="checkbox" value="${s.code}" ${isSelected ? 'checked' : ''} />
        <span>${s.name}</span>
      `;

            item.querySelector('input').addEventListener('change', (e) => {
                if (e.target.checked) {
                    const already = this.selectedStocks.find(ss => ss.code === s.code);
                    if (!already) {
                        this.selectedStocks.push({
                            code: s.code,
                            name: s.name,
                            ticker: s.ticker || s.code,
                            weight: 0
                        });
                    }
                    item.classList.add('active');
                } else {
                    this.selectedStocks = this.selectedStocks.filter(ss => ss.code !== s.code);
                    item.classList.remove('active');
                }
                this.autoDistributeWeights();
                this.updateRebalanceTypeByStockCount();
                this.renderStockList();
                this.updateWeightSum();
            });

            area.appendChild(item);
        });
    },

    autoDistributeWeights() {
        const cashObj = this.selectedStocks.find(s => s.code === 'CASH');
        const cashWeight = cashObj ? cashObj.weight : 0;

        const stocks = this.selectedStocks.filter(s => s.code !== 'CASH');
        const count = stocks.length;
        if (count === 0) return;

        const remaining = 100 - cashWeight;
        const equalWeight = Math.floor(remaining / count);
        const remainder = remaining - (equalWeight * count);

        stocks.forEach((s, idx) => {
            s.weight = (idx === count - 1) ? equalWeight + remainder : equalWeight;
        });
    },

    updateRebalanceTypeByStockCount() {
        const rTypeSelected = document.querySelector('input[name="rebalanceType"]:checked');
        if (!rTypeSelected) return;
        const currentType = rTypeSelected.value;
        const count = this.selectedStocks.length;

        if (count === 1 && currentType !== 'none') {
            const rad = document.querySelector('input[name="rebalanceType"][value="none"]');
            if (rad) {
                rad.checked = true;
                rad.dispatchEvent(new Event('change'));
            }
        } else if (count >= 2 && currentType === 'none') {
            const rad = document.querySelector('input[name="rebalanceType"][value="deviation"]');
            if (rad) {
                rad.checked = true;
                rad.dispatchEvent(new Event('change'));
            }
        }
    },

    bindEvents() {
        document.getElementById('btScenarioSelect').addEventListener('change', (e) => {
            if (e.target.value) this.loadScenarioByName(e.target.value);
        });

        document.getElementById('btnBtSaveScenario').addEventListener('click', () => {
            const name = prompt('저장할 시나리오 이름을 입력하세요:');
            if (!name) return;
            this.scenarios[name] = this.getCurrentConfig();
            this.saveScenarios();
            document.getElementById('btScenarioSelect').value = name;
            showToast(`시나리오 "${name}" 저장 완료`, 'success');
        });

        document.getElementById('btnBtDeleteScenario').addEventListener('click', () => {
            const name = document.getElementById('btScenarioSelect').value;
            if (!name) return;
            if (confirm(`시나리오 "${name}"을 삭제하시겠습니까?`)) {
                delete this.scenarios[name];
                this.saveScenarios();
                showToast('삭제되었습니다.');
            }
        });

        document.querySelectorAll('input[name="rebalanceType"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const type = e.target.value;
                document.getElementById('rebalancePeriodRow').style.display = type === 'period' ? 'flex' : 'none';
                document.getElementById('rebalanceDeviationRow').style.display = type === 'deviation' ? 'flex' : 'none';
            });
        });

        // Trigger on load for initial visibility
        const currentRType = document.querySelector('input[name="rebalanceType"]:checked');
        if (currentRType) currentRType.dispatchEvent(new Event('change'));



        document.getElementById('btnRunBacktest').addEventListener('click', () => this.runSimulation());
    },

    getCurrentConfig() {
        return {
            initialCapital: document.getElementById('btInitialCapital').value,
            feeRate: document.getElementById('btFeeRate').value,
            taxRate: document.getElementById('btTaxRate').value,
            periodMonths: document.getElementById('btPeriodMonths').value,
            stocks: this.selectedStocks,
            rebalanceType: document.querySelector('input[name="rebalanceType"]:checked').value,
            rebalancePeriod: document.getElementById('btRebalancePeriod').value,
            rebalanceThreshold: document.getElementById('btRebalanceThreshold').value,
        };
    },

    loadScenarioByName(name) {
        const config = this.scenarios[name];
        if (!config) return;

        document.getElementById('btInitialCapital').value = config.initialCapital;
        document.getElementById('btFeeRate').value = config.feeRate || 0.015;
        document.getElementById('btTaxRate').value = config.taxRate || 0.20;
        document.getElementById('btPeriodMonths').value = config.periodMonths || 12;
        this.updatePeriodHint();

        let loadedStocks = config.stocks || [];
        if (!loadedStocks.find(s => s.code === 'CASH')) {
            loadedStocks.unshift({ code: 'CASH', name: '현금', ticker: 'CASH', weight: 0 });
        }
        this.selectedStocks = loadedStocks;

        const rType = document.querySelector(`input[name="rebalanceType"][value="${config.rebalanceType}"]`);
        if (rType) {
            rType.checked = true;
            rType.dispatchEvent(new Event('change'));
        }
        document.getElementById('btRebalancePeriod').value = config.rebalancePeriod;
        document.getElementById('btRebalanceThreshold').value = config.rebalanceThreshold;

        this.renderStockList();
        this.updateWeightSum();
        document.getElementById('btTabSelect').value = '';
        this.renderStockPicker('');
        this.updateRebalanceTypeByStockCount();
    },

    renderStockList() {
        const container = document.getElementById('btStockList');
        container.innerHTML = '';

        this.selectedStocks.forEach((s, idx) => {
            const item = document.createElement('div');
            item.className = 'bt-stock-item';
            item.innerHTML = `
        <div class="stock-info">
          <span class="name">${s.name}</span>
          <span class="code">${s.ticker === 'CASH' ? '-' : s.ticker}</span>
        </div>
        <input type="number" class="weight-input" value="${s.weight}" min="0" max="100" data-idx="${idx}" />
        <span class="unit-text">%</span>
        <i class="fas fa-times btn-remove-stock" data-idx="${idx}"></i>
      `;

            item.querySelector('.weight-input').addEventListener('input', (e) => {
                this.selectedStocks[idx].weight = Number(e.target.value) || 0;
                this.updateWeightSum();
            });

            const removeBtn = item.querySelector('.btn-remove-stock');
            if (removeBtn) {
                removeBtn.addEventListener('click', () => {
                    this.selectedStocks.splice(idx, 1);
                    this.autoDistributeWeights();
                    this.updateRebalanceTypeByStockCount();
                    this.renderStockList();
                    this.renderStockPicker(document.getElementById('btTabSelect').value);
                    this.updateWeightSum();
                });
            }

            container.appendChild(item);
        });
    },

    updateWeightSum() {
        const sum = this.selectedStocks.reduce((acc, s) => acc + s.weight, 0);
        const sumEl = document.getElementById('btWeightSum');
        const fillEl = document.getElementById('btWeightSumFill');
        const btn = document.getElementById('btnRunBacktest');

        sumEl.textContent = sum + '%';
        fillEl.style.width = Math.min(sum, 100) + '%';

        if (sum === 100) {
            sumEl.style.color = '#10b981';
            fillEl.className = 'sum-fill ok';
            btn.disabled = this.selectedStocks.length === 0;
        } else {
            sumEl.style.color = sum > 100 ? '#ef4444' : '#94a3b8';
            fillEl.className = 'sum-fill' + (sum > 100 ? ' error' : '');
            btn.disabled = true;
        }
    },

    async runSimulation() {
        const initialCapital = Number(document.getElementById('btInitialCapital').value.replace(/,/g, ''));
        const feeRate = Number(document.getElementById('btFeeRate').value) / 100;
        const taxRate = Number(document.getElementById('btTaxRate').value) / 100;
        const periodMonths = Math.max(1, parseInt(document.getElementById('btPeriodMonths').value) || 12);

        // 시작 날짜 계산 (현재로부터 N개월 전)
        const now = new Date();
        const periodStart = new Date(now.getFullYear(), now.getMonth() - periodMonths, now.getDate());
        const periodStartStr = periodStart.toISOString().substring(0, 10);

        // 필요한 거래일 수 추정 (1개월 ≈ 23거래일, 여유분 포함)
        const candleCount = Math.ceil(periodMonths * 23) + 30;

        const rebalanceType = document.querySelector('input[name="rebalanceType"]:checked').value;
        const rebalancePeriod = document.getElementById('btRebalancePeriod').value;
        const rebalanceThreshold = Number(document.getElementById('btRebalanceThreshold').value);

        if (this.selectedStocks.length === 0) return;

        document.getElementById('btLoading').style.display = 'flex';
        document.getElementById('btLoadingProgress').textContent = '데이터 수집 중...';

        try {
            const stocksToFetch = this.selectedStocks.filter(s => s.code !== 'CASH');
            const batchData = await API.fetchBatch(
                stocksToFetch.map(s => ({ code: s.code, ticker: s.ticker })),
                candleCount,
                '1d'
            );

            let benchmarkHistory = [];
            let sp500History = [];
            try {
                const sp500 = await API.fetchStock('^GSPC', 300, '1d', 'US');
                sp500History = sp500.allCandles || [];
                const bmk = await API.fetchStock('000001.SS', 300, '1d', 'US');
                const ks200 = await API.fetchStock('^KS200', 300, '1d', 'KS');
                benchmarkHistory = ks200.allCandles || [];
                if (benchmarkHistory.length === 0 && bmk.allCandles) benchmarkHistory = bmk.allCandles;
            } catch (e) {
                console.warn('벤치마크 데이터 로드 실패:', e);
            }

            const historyMap = {};
            const actualStocks = [];

            batchData.forEach((res, i) => {
                if (res && res.allCandles && res.allCandles.length > 0) {
                    const s = stocksToFetch[i];
                    historyMap[s.ticker] = res.allCandles;
                    actualStocks.push(s);
                }
            });

            if (actualStocks.length === 0) throw new Error('데이터를 가져올 수 있는 종목이 없습니다.');

            let commonDates = [];
            const tickers = Object.keys(historyMap);
            if (tickers.length > 0) {
                const firstTicker = tickers[0];
                commonDates = historyMap[firstTicker].map(h => h.date);
                for (const ticker of tickers) {
                    const dates = new Set(historyMap[ticker].map(h => h.date));
                    commonDates = commonDates.filter(d => dates.has(d));
                }
                commonDates.sort();

                // 기간 필터링: periodStartStr 이후 날짜만 사용
                commonDates = commonDates.filter(d => d >= periodStartStr);

                if (commonDates.length < 10) throw new Error(`공통 데이터 구간이 너무 짧습니다. (기간: ${periodMonths}개월, ${periodStartStr} 이후 데이터 부족)`);
            }

            const cashObj = this.selectedStocks.find(s => s.code === 'CASH');
            if (cashObj && commonDates.length > 0) {
                actualStocks.push(cashObj);
                historyMap['CASH'] = commonDates.map(d => ({ date: d, close: 1 }));
            }

            document.getElementById('btLoadingProgress').textContent = `시뮬레이션 진행 중... (${commonDates.length}거래일)`;

            const engine = new BacktestEngine({
                initialCapital,
                feeRate,
                taxRate,
                strategy: {
                    stocks: actualStocks,
                    rebalanceType,
                    rebalancePeriod,
                    rebalanceThreshold
                },
                dates: commonDates,
                historyMap,
                benchmarkHistory,
                sp500History
            });

            const result = engine.run();
            this.displayResults(result);

        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            document.getElementById('btLoading').style.display = 'none';
        }
    },

    displayResults(result) {
        document.getElementById('btEmptyState').style.display = 'none';
        document.getElementById('btResultState').style.display = 'block';

        document.getElementById('resTotalReturn').textContent = fmtPct(result.totalReturn * 100);
        document.getElementById('resTotalReturn').className = 'value ' + (result.totalReturn >= 0 ? 'up' : 'down');
        document.getElementById('resTotalProfit').textContent = fmt(Math.round(result.totalProfit)) + (result.currency || ' 원');
        document.getElementById('resCAGR').textContent = fmtPct(result.cagr * 100);
        document.getElementById('resMDD').textContent = fmtPct(result.mdd * 100);
        const rankHtml = (val, thresholds, inverse = false) => {
            const [b, ng, g] = thresholds;
            let rank = 'Bad'; let col = '#ef4444'; // red
            if (val >= g) { rank = 'Great'; col = '#10b981'; } // green
            else if (val >= ng) { rank = 'Good'; col = '#3b82f6'; } // blue
            else if (val >= b) { rank = 'Fair'; col = '#f59e0b'; } // yellow
            return `<span style="font-size:14px;font-weight:700;">${val.toFixed(2)}</span> <span style="font-size:10px;font-weight:600;padding:2px 4px;border-radius:4px;background-color:${col}33;color:${col};margin-left:4px;">${rank}</span>`;
        };

        // thresholds = [Bad cutoff, Not Good cutoff, Good cutoff]
        document.getElementById('resSharpe').innerHTML = rankHtml(result.sharpe, [0, 0.5, 1.0]);
        document.getElementById('resSortino').innerHTML = rankHtml(result.sortino, [0, 0.75, 1.5]);
        document.getElementById('resCalmar').innerHTML = rankHtml(result.calmar, [0, 0.5, 1.0]);
        document.getElementById('resIR').innerHTML = rankHtml(result.infoRatio, [-0.5, 0, 0.5]);

        const logBody = document.getElementById('btLogBody');
        logBody.innerHTML = '';

        const logs = result.logs;
        logs.forEach(log => {
            const tr = document.createElement('tr');
            let typeClass = '';
            switch (log.type) {
                case '매수':
                case '추가 매수': typeClass = 'buy'; break;
                case '매도':
                case '일부 매도': typeClass = 'sell'; break;
                case '리밸런싱': typeClass = 'rebalance'; break;
                case '현금 투입': typeClass = 'cash-in'; break;
                case '현금 회수': typeClass = 'cash-out'; break;
                case '최종 결과': typeClass = 'final-result'; break;
            }
            const pnlPct = (log.pnlPct || 0) * 100;
            const pnlClass = pnlPct >= 0 ? 'up' : 'down';

            tr.innerHTML = `
        <td>${log.date}</td>
        <td><span class="bt-log-type ${typeClass}">${log.type}</span></td>
        <td>
           <span style="font-weight:600; margin-right:8px;">${log.msg}</span>
           ${this.renderLogEvalDetail(log.evals)}
        </td>
        <td class="${pnlClass}">${fmtPct(pnlPct)}</td>
        <td>${fmt(Math.round(log.value))}</td>
      `;
            logBody.appendChild(tr);
        });

        this.renderMainChart(result);
    },

    renderLogEvalDetail(evals) {
        if (!evals) return '';
        let html = '<span class="log-eval-detail" style="display:inline-flex; flex-wrap:wrap; gap:8px; align-items:center;">';
        for (const [ticker, data] of Object.entries(evals)) {
            const pnl = data.pnlPct * 100;
            const cls = pnl >= 0 ? 'profit' : 'loss';
            let valStr = '';
            if (data.beforeVal !== undefined && data.afterVal !== undefined && Math.abs(data.beforeVal - data.afterVal) > 1) {
                const bwStr = (data.beforeWeight !== undefined && data.beforeWeight > 0) ? ` <span style="font-size:10px;color:var(--text-muted)">(${data.beforeWeight.toFixed(1)}%)</span>` : '';
                const awStr = (data.afterWeight !== undefined) ? ` <span style="font-size:10px;color:var(--text-muted)">(${data.afterWeight.toFixed(1)}%)</span>` : '';
                valStr = `${fmt(Math.round(data.beforeVal))}원${bwStr} <i class="fas fa-arrow-right" style="font-size:10px;margin:0 4px;color:var(--text-muted)"></i> ${fmt(Math.round(data.afterVal))}원${awStr}`;
            } else {
                const val = data.afterVal !== undefined ? data.afterVal : data.val;
                valStr = `${fmt(Math.round(val))}원`;
            }
            html += `<span class="eval-item">
            <b style="color:var(--text-primary)">${ticker}</b>: ${valStr} <small class="${cls}">(${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%)</small>
          </span>`;
        }
        html += '</span>';
        return html;
    },

    renderMainChart(result) {
        const chartDom = document.getElementById('btMainChart');
        const myChart = echarts.init(chartDom);
        const seriesData = result.dailyReturns.map(r => (r * 100).toFixed(2));
        const bmkData = result.benchmarkReturns.map(r => (r * 100).toFixed(2));
        const sp500Data = result.sp500Returns.map(r => (r * 100).toFixed(2));
        const dates = result.dates;

        const option = {
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                formatter: (params) => {
                    let html = `${params[0].name}<br/>`;
                    params.forEach(p => {
                        const color = p.color;
                        html += `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:5px;"></span>`;
                        html += `${p.seriesName}: <b>${p.value}%</b><br/>`;
                    });
                    return html;
                }
            },
            legend: { show: false },
            grid: { top: '5%', left: '3%', right: '4%', bottom: '3%', containLabel: true },
            xAxis: {
                type: 'category',
                data: dates,
                axisLine: { lineStyle: { color: '#2a3f5f' } },
                axisLabel: { color: '#94a3b8', fontSize: 10 }
            },
            yAxis: {
                type: 'value',
                axisLabel: { formatter: '{value}%', color: '#94a3b8' },
                splitLine: { lineStyle: { color: '#1e3050' } }
            },
            series: [
                {
                    name: '내 포트폴리오', type: 'line', data: seriesData, smooth: true, showSymbol: false,
                    lineStyle: { color: '#3b82f6', width: 3 },
                    areaStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(59, 130, 246, 0.3)' },
                            { offset: 1, color: 'rgba(59, 130, 246, 0)' }
                        ])
                    }
                },
                {
                    name: 'KOSPI 200', type: 'line', data: bmkData, smooth: true, showSymbol: false,
                    lineStyle: { color: '#64748b', width: 1.5, type: 'dashed' },
                },
                {
                    name: 'S&P 500', type: 'line', data: sp500Data, smooth: true, showSymbol: false,
                    lineStyle: { color: '#ef4444', width: 1.5, type: 'dashed' },
                }
            ]
        };
        myChart.setOption(option);
        window.addEventListener('resize', () => myChart.resize());
    }
};

class BacktestEngine {
    constructor({ initialCapital, feeRate, taxRate, strategy, dates, historyMap, benchmarkHistory, sp500History }) {
        this.initialCapital = initialCapital;
        this.feeRate = feeRate;
        this.taxRate = taxRate;
        this.strategy = strategy;
        if (this.strategy.stocks.length === 1) {
            this.strategy.rebalanceType = 'none';
        }
        this.dates = dates;
        this.historyMap = historyMap;
        this.benchmarkHistory = benchmarkHistory;
        this.sp500History = sp500History || [];

        // ------------------------------------------------------------------
        // 날짜→종가 Map 사전 구축 (O(n) 배열 탐색 → O(1) Map 조회)
        // historyMap[ticker] 배열을 Map<date, close>로 변환
        // ------------------------------------------------------------------
        this.historyDateMaps = {};
        for (const ticker in this.historyMap) {
            this.historyDateMaps[ticker] = new Map(
                this.historyMap[ticker].map(h => [h.date, h.close])
            );
        }
        // 벤치마크 Map
        this.benchmarkMap = new Map(
            this.benchmarkHistory.map(h => [h.date, h.close])
        );
        this.sp500Map = new Map(
            this.sp500History.map(h => [h.date, h.close])
        );

        // ------------------------------------------------------------------
        // currentCash 회계 방식 설명:
        //   - CASH 종목은 holdings['CASH'].qty 에서 관리 (1원=1주)
        //   - this.currentCash 는 '잔여 미할당 현금 + 누적 수수료/세금 차감'
        //   - 최초 배분 후: currentCash ≈ 0 (수수료만큼 음수 가능)
        //   - 포트폴리오 총액 = this.currentCash + Σ(holdings[*].qty × price)
        // ------------------------------------------------------------------
        this.currentCash = initialCapital;
        this.peakValue = 0;
        this.troughValue = Infinity;
        this.totalCost = 0;

        this.holdings = {};
        this.strategy.stocks.forEach(s => {
            this.holdings[s.ticker] = { qty: 0, weight: s.weight / 100, startPrice: 0 };
        });

        this.results = {
            dates: [],
            dailyValues: [],
            dailyReturns: [],
            benchmarkReturns: [],
            sp500Returns: [],
            logs: [],
            initialCapital,
            initialWeights: { ...this.holdings }
        };
    }

    /**
     * 특정 날짜의 종목 종가를 O(1)로 반환.
     * 해당 날짜 데이터가 없으면 0을 반환.
     */
    getPrice(ticker, date) {
        const map = this.historyDateMaps[ticker];
        if (!map) return 0;
        return map.get(date) || 0;
    }

    run() {
        const startDate = this.dates[0];

        // 벤치마크 초기 종가 설정
        const bmkStartClose = this.benchmarkMap.get(startDate) || 0;
        const bmkStart = bmkStartClose > 0 ? bmkStartClose : (this.benchmarkHistory.length > 0 ? this.benchmarkHistory[0].close : 0);
        let bmkPrevClose = bmkStart;

        // S&P 500 초기 종가 설정
        const sp500StartClose = this.sp500Map.get(startDate) || 0;
        const spStart = sp500StartClose > 0 ? sp500StartClose : (this.sp500History.length > 0 ? this.sp500History[0].close : 0);
        let spPrevClose = spStart;

        this.rebalance(startDate, "최초 매수 (초기 구성)", 0, true);

        let initialPortfolioValue = this.currentCash;
        for (const ticker in this.holdings) {
            initialPortfolioValue += this.holdings[ticker].qty * (this.holdings[ticker].currentPrice || 0);
        }

        this.peakValue = initialPortfolioValue;
        this.troughValue = initialPortfolioValue;

        this.results.dates.push(startDate);
        this.results.dailyValues.push(initialPortfolioValue);
        this.results.dailyReturns.push((initialPortfolioValue / this.initialCapital) - 1);
        this.results.benchmarkReturns.push(0);
        this.results.sp500Returns.push(0);

        for (let i = 1; i < this.dates.length; i++) {
            const date = this.dates[i];
            const prevDate = this.dates[i - 1];

            // 포트폴리오 총액 = 잔여 현금 + Σ(보유수량 × 당일 종가)
            let portfolioValue = this.currentCash;
            for (const ticker in this.holdings) {
                const h = this.holdings[ticker];
                // O(1) Map 조회로 당일 종가 업데이트
                const price = this.getPrice(ticker, date);
                if (price > 0) h.currentPrice = price;
                portfolioValue += h.qty * h.currentPrice;
            }

            if (portfolioValue > this.peakValue) {
                this.peakValue = portfolioValue;
                this.troughValue = Infinity;
            } else {
                if (portfolioValue < this.troughValue) this.troughValue = portfolioValue;
            }

            if (this.strategy.rebalanceType === 'period') {
                if (this.isRebalanceDay(date, prevDate)) {
                    this.rebalance(date, "정기 리밸런싱");
                    portfolioValue = this.currentCash;
                    for (const ticker in this.holdings) portfolioValue += this.holdings[ticker].qty * this.holdings[ticker].currentPrice;
                }
            } else if (this.strategy.rebalanceType === 'deviation') {
                if (this.checkDeviation(portfolioValue)) {
                    this.rebalance(date, "상시 편차 리밸런싱");
                    portfolioValue = this.currentCash;
                    for (const ticker in this.holdings) portfolioValue += this.holdings[ticker].qty * this.holdings[ticker].currentPrice;
                }
            }
            // rebalanceType === 'none' -> do nothing

            this.results.dates.push(date);
            this.results.dailyValues.push(portfolioValue);

            const totalInvested = this.initialCapital;
            this.results.dailyReturns.push((portfolioValue / totalInvested) - 1);

            if (bmkStart > 0) {
                // O(1) 벤치마크 Map 조회 - 누락된 날짜는 이전 종가 유지
                const bmkPrice = this.benchmarkMap.get(date) || bmkPrevClose;
                bmkPrevClose = bmkPrice;
                this.results.benchmarkReturns.push((bmkPrice / bmkStart) - 1);
            } else {
                this.results.benchmarkReturns.push(0);
            }

            if (spStart > 0) {
                const spPrice = this.sp500Map.get(date) || spPrevClose;
                spPrevClose = spPrice;
                this.results.sp500Returns.push((spPrice / spStart) - 1);
            } else {
                this.results.sp500Returns.push(0);
            }
        }

        // --- 최종 결과 로그 추가 ---
        const lastDate = this.dates[this.dates.length - 1];
        let finalPortfolioValue = this.currentCash;
        const finalEvals = {};
        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            const val = h.qty * (h.currentPrice || 0);
            finalPortfolioValue += val;
            finalEvals[ticker] = {
                afterVal: val,
                pnlPct: h.startPrice > 0 ? (h.currentPrice / h.startPrice) - 1 : 0
            };
        }
        for (const ticker in finalEvals) {
            finalEvals[ticker].afterWeight = finalPortfolioValue > 0 ? (finalEvals[ticker].afterVal / finalPortfolioValue) * 100 : 0;
        }
        const finalPnlPct = (finalPortfolioValue / this.initialCapital) - 1;
        this.addLog(lastDate, '최종 결과', '백테스트 종료 (최종 평가 금액)', finalPortfolioValue, finalEvals, finalPnlPct);
        // ------------------------

        return this.calculateFinalStats();
    }

    isRebalanceDay(date, prevDate) {
        const d = new Date(date), pd = new Date(prevDate);
        switch (this.strategy.rebalancePeriod) {
            case '1wk': {
                // 월요일 기준 주 시작일을 계산해 비교
                // 이전 방식(getDay() < pd.getDay())은 공휴일로 인해
                // 같은 주 내 요일이 역전되는 경우 리밸런싱을 누락하는 버그가 있었음
                const weekStart = (dt) => {
                    const day = new Date(dt);
                    const offset = (day.getDay() + 6) % 7; // Mon=0, Tue=1, ... Sun=6
                    day.setDate(day.getDate() - offset);
                    return day.toISOString().substring(0, 10);
                };
                return weekStart(d) !== weekStart(pd);
            }
            case '1mo': return d.getMonth() !== pd.getMonth() || d.getFullYear() !== pd.getFullYear();
            case '3mo': {
                const quarterChanged = Math.floor(d.getMonth() / 3) !== Math.floor(pd.getMonth() / 3);
                const yearChanged = d.getFullYear() !== pd.getFullYear();
                return quarterChanged || yearChanged;
            }
            case '1yr': return d.getFullYear() !== pd.getFullYear();
            default: return false;
        }
    }

    checkDeviation(totalValue) {
        if (totalValue <= 0) return false;
        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            const actualWeight = (h.qty * h.currentPrice) / totalValue;
            if (Math.abs(actualWeight - h.weight) > (this.strategy.rebalanceThreshold / 100)) return true;
        }
        return false;
    }

    rebalance(date, reason, withdrawAmount = 0, isInitial = false, logTypeOverride = null) {
        // 현재 포트폴리오 총액 산출 (잔여 현금 + 보유 종목 평가액)
        let currentTotal = this.currentCash;
        const beforeVals = {};
        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            // O(1) Map 조회로 당일 종가 업데이트
            const price = this.getPrice(ticker, date);
            if (price > 0) h.currentPrice = price;
            const bVal = h.qty * (h.currentPrice || 0);
            beforeVals[ticker] = bVal;
            currentTotal += bVal;
        }

        const targetTotal = currentTotal - withdrawAmount;
        let costThisTime = 0;

        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            if (h.currentPrice <= 0) continue;
            const targetVal = targetTotal * h.weight;
            // CASH: qty = 금액 그 자체 (1원=1주)
            // 주식:  qty = floor(목표금액 / 현재가) — 호가 단위 무시한 근사치
            const targetQty = ticker === 'CASH' ? targetVal : Math.floor(targetVal / h.currentPrice);
            const diff = targetQty - h.qty;
            if (diff !== 0) {
                const tradeAmt = Math.abs(diff * h.currentPrice);
                if (ticker !== 'CASH') {
                    // 매수/매도 수수료
                    costThisTime += tradeAmt * this.feeRate;
                    // 매도 시 거래세 (한국 증권거래세: 모든 매도에 적용)
                    // 양도소득세가 목적이라면 손실 매도 제외 로직 별도 추가 필요
                    if (diff < 0) costThisTime += tradeAmt * this.taxRate;
                }
                h.qty = targetQty;
            }
            if (isInitial && ticker !== 'CASH') h.startPrice = h.currentPrice;
            if (isInitial && ticker === 'CASH') h.startPrice = 1;
        }

        this.totalCost += costThisTime;

        let newTotalStockValue = 0;
        const evals = {};
        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            const val = h.qty * (h.currentPrice || 0);
            newTotalStockValue += val;
            evals[ticker] = {
                beforeVal: isInitial ? 0 : beforeVals[ticker],
                beforeWeight: isInitial ? 0 : (beforeVals[ticker] / currentTotal) * 100,
                afterVal: val,
                pnlPct: h.startPrice > 0 ? (h.currentPrice / h.startPrice) - 1 : 0
            };
        }

        // 잔여 현금 = 목표 총액 - 수수료/세금 - 주식+현금 포지션 평가액
        // ⚠️ 수수료로 인해 소폭 음수가 될 수 있음 (회계적으로 정상 — 비용 차감 표현)
        this.currentCash = targetTotal - costThisTime - newTotalStockValue;

        const finalPortfolioValue = this.currentCash + newTotalStockValue;
        const invested = this.initialCapital;
        const pnlPct = (finalPortfolioValue / invested) - 1;

        for (const ticker in evals) {
            evals[ticker].afterWeight = (evals[ticker].afterVal / finalPortfolioValue) * 100;
        }

        let logType = isInitial ? '매수' : '리밸런싱';
        if (logTypeOverride) {
            logType = logTypeOverride;
        } else if (!isInitial && Object.keys(this.holdings).length === 1) {
            logType = withdrawAmount > 0 ? '일부 매도' : '추가 매수';
        }

        this.addLog(date, logType, `${reason} (비용: ${fmt(Math.round(costThisTime))}원)`, finalPortfolioValue, evals, pnlPct);
    }

    addLog(date, type, msg, value, evals, pnlPct = 0) {
        this.results.logs.push({ date, type, msg, value, evals, pnlPct });
    }

    calculateFinalStats() {
        const values = this.results.dailyValues;
        const initial = this.initialCapital;
        const last = values[values.length - 1];
        const totalInvested = this.initialCapital;
        const totalReturn = (last / totalInvested) - 1;
        let peak = 0, maxDD = 0;
        values.forEach(v => {
            if (v > peak) peak = v;
            const dd = (v / peak) - 1;
            if (dd < maxDD) maxDD = dd;
        });
        // CAGR: 실제 달력 기간(일수) 기반으로 연수 계산
        const firstDate = new Date(this.results.dates[0]);
        const lastDate = new Date(this.results.dates[this.results.dates.length - 1]);
        const years = Math.max((lastDate - firstDate) / (365.25 * 24 * 3600 * 1000), 1 / 252);
        const cagr = Math.pow(last / totalInvested, 1 / years) - 1;
        const covReturns = [];
        let downReturns = [];
        let bmkAvgRet = 0;
        let excessReturns = [];
        const returns = [];

        for (let i = 1; i < values.length; i++) {
            const r = (values[i] / values[i - 1]) - 1;
            returns.push(r);
            if (r < 0) downReturns.push(r);

            const bmkRet = this.results.benchmarkReturns[i];
            // Recover actual daily benchmark return, benchmarkReturns array stores cumulative returns
            // So we need to reconstruct daily excess returns for Info Ratio.
            // But benchmarkReturns is already calculated. We can just use daily difference in benchmark.
        }

        // recalculate benchmark daily return
        if (this.benchmarkHistory && this.benchmarkHistory.length > 0) {
            const bReturns = [];
            // 전체 히스토리 첫 캔들이 아닌, 실제 백테스팅 시작일 종가를 기준으로 사용
            let bStart = this.benchmarkMap.get(this.results.dates[0]) || this.benchmarkHistory[0].close;
            for (let i = 1; i < this.results.dates.length; i++) {
                const bDailyCurrent = this.benchmarkMap.get(this.results.dates[i]) || bStart;
                const bDailyPrev = this.benchmarkMap.get(this.results.dates[i - 1]) || bStart;
                const bDailyRet = (bDailyCurrent / bDailyPrev) - 1;
                bReturns.push(bDailyRet);
                excessReturns.push(returns[i - 1] - bDailyRet);
            }
        } else {
            for (let i = 1; i < values.length; i++) excessReturns.push(returns[i - 1]);
        }

        const avgRet = returns.length > 0 ? (returns.reduce((a, b) => a + b, 0) / returns.length) : 0;
        // 표본표준편차(N-1) 사용 — Sharpe/Sortino가 과대계상되지 않도록
        const stdDev = returns.length > 1 ? (Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - avgRet, 2), 0) / (returns.length - 1))) : 1;

        // Downside deviation (for Sortino) — MAR = 0 기준 (표준 공식)
        // min(r,0)^2 의 평균 제곱근: 손실 수익률만 패널티, 기준점은 항상 0
        const downStdDev = returns.length > 1
            ? (Math.sqrt(returns.reduce((acc, r) => acc + Math.pow(Math.min(r, 0), 2), 0) / (returns.length - 1)) || 1)
            : 1;

        // Tracking error (for Info Ratio)
        const avgExcessRet = excessReturns.length > 0 ? (excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length) : 0;
        const trackingError = excessReturns.length > 1 ? (Math.sqrt(excessReturns.reduce((a, b) => a + Math.pow(b - avgExcessRet, 2), 0) / (excessReturns.length - 1))) : 1;

        const sharpe = stdDev > 0 ? (avgRet / stdDev) * Math.sqrt(252) : 0;
        const sortino = downStdDev > 0 ? (avgRet / downStdDev) * Math.sqrt(252) : 0;
        const calmar = maxDD < 0 ? cagr / Math.abs(maxDD) : 0;
        const infoRatio = trackingError > 0 ? (avgExcessRet / trackingError) * Math.sqrt(252) : 0;

        return { ...this.results, totalReturn, totalProfit: last - totalInvested, mdd: maxDD, cagr, sharpe, sortino, calmar, infoRatio };
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await Storage.init();
        BacktestUI.init();
    } catch (err) {
        console.error('Storage initialization failed:', err);
        showToast('데이터 초기화 실패: ' + err.message, 'error');
    }
});
