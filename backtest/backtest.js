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
        sel.innerHTML = '';
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
        sel.innerHTML = ''; // Start clean

        if (tabs.length === 0) {
            sel.innerHTML = '<option value="">그룹 없음</option>';
            return;
        }

        tabs.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.uid;
            opt.textContent = t.name;
            sel.appendChild(opt);
        });

        // Select the first group by default
        sel.value = tabs[0].uid;
        this.renderStockPicker(tabs[0].uid);

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
        cashItem.innerHTML = `<span>현금</span>`;
        cashItem.addEventListener('click', () => {
            const isCashSelected = this.selectedStocks.some(ss => ss.code === 'CASH');
            if (!isCashSelected) {
                this.selectedStocks.unshift({
                    code: 'CASH',
                    name: '현금',
                    ticker: 'CASH',
                    weight: 20
                });
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

            item.innerHTML = `<span>${s.name}</span>`;
            item.addEventListener('click', () => {
                const isSelected = this.selectedStocks.some(ss => ss.code === s.code);
                if (!isSelected) {
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
        <span class="bt-stock-name">${s.name}</span>
        <div class="bt-flex-row" style="gap: 4px; align-items: center;">
            <input type="number" class="weight-input" value="${s.weight}" min="0" max="100" data-idx="${idx}" />
            <span class="unit-text">%</span>
            <i class="fas fa-times btn-remove-stock" data-idx="${idx}" style="margin-left: 4px;"></i>
        </div>
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

        if (sumEl) sumEl.textContent = sum + '%';
        if (fillEl) fillEl.style.width = Math.min(sum, 100) + '%';

        if (sum === 100) {
            if (sumEl) sumEl.style.color = '#10b981';
            if (fillEl) fillEl.className = 'sum-fill ok';
            btn.disabled = this.selectedStocks.length === 0;
        } else {
            if (sumEl) sumEl.style.color = sum > 100 ? '#ef4444' : '#94a3b8';
            if (fillEl) fillEl.className = 'sum-fill' + (sum > 100 ? ' error' : '');
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

        const btn = document.getElementById('btnRunBacktest');
        const originalBtnText = btn.textContent;
        btn.disabled = true;
        btn.classList.add('loading');
        btn.textContent = '데이터 수집 중...';

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
                // 벤치마크 데이터는 주식 데이터와 동일하게 candleCount만큼 요청하여 차트 끊김 방지
                const sp500 = await API.fetchStock('^GSPC', candleCount, '1d', 'US');
                sp500History = sp500.allCandles || [];
                const bmk = await API.fetchStock('000001.SS', candleCount, '1d', 'US');
                const ks200 = await API.fetchStock('^KS200', candleCount, '1d', 'KS');
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

            btn.textContent = `시뮬레이션 진행 중... (${commonDates.length}거래일)`;

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
            btn.disabled = false;
            btn.classList.remove('loading');
            btn.textContent = originalBtnText;
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

            let displayMsg = '';
            if (log.type === '매수') {
                displayMsg = '최초 매수';
            } else if (log.type === '리밸런싱') {
                const match = log.msg.match(/\(비용: (.*?)\)/);
                displayMsg = match ? match[1] : log.msg;
            } else {
                displayMsg = log.msg;
            }

            tr.innerHTML = `
        <td>${log.date}</td>
        <td><span class="bt-log-type ${typeClass}">${log.type}</span></td>
        <td style="font-weight:600;">${displayMsg}</td>
        <td>${this.renderLogEvalDetail(log.evals, log.triggerTicker)}</td>
        <td class="${pnlClass}">${fmtPct(pnlPct)}</td>
        <td>${fmt(Math.round(log.value))}</td>
      `;
            logBody.appendChild(tr);
        });

        this.renderMainChart(result);
    },

    renderLogEvalDetail(evals, triggerTicker = null) {
        if (!evals) return '';

        if (triggerTicker && evals[triggerTicker]) {
            // 리밸런싱 유도(트리거) 종목 표시 (리밸런싱 전 비중 기준)
            const data = evals[triggerTicker];
            const stock = this.selectedStocks.find(s => s.ticker === triggerTicker || s.code === triggerTicker);
            const displayName = stock ? stock.name : triggerTicker;
            const weight = data.beforeWeight || 0;
            return `<span style="color:var(--text-primary); font-weight:600;">${displayName}(${weight.toFixed(1)}%)</span>`;
        } else {
            // 최초 매수 시 전체 비중 표시 (리밸런싱 후 비중 기준)
            const items = [];
            const tickers = Object.keys(evals).filter(t => t !== 'CASH');
            tickers.sort((a, b) => (evals[b].afterVal || 0) - (evals[a].afterVal || 0));

            tickers.forEach(t => {
                const data = evals[t];
                const stock = this.selectedStocks.find(s => s.ticker === t || s.code === t);
                const displayName = stock ? stock.name : t;
                const weight = data.afterWeight || 0;
                if (weight > 0.1) items.push(`${displayName}(${weight.toFixed(1)}%)`);
            });

            const cashData = evals['CASH'];
            const cw = cashData ? (cashData.afterWeight || 0) : 0;
            if (cw > 0.1) items.push(`현금(${cw.toFixed(1)}%)`);

            return `<span style="color:var(--text-primary); font-weight:600;">${items.join(' ')}</span>`;
        }
    },

    renderMainChart(result) {
        const chartDom = document.getElementById('btMainChart');
        const myChart = echarts.init(chartDom);
        const seriesData = result.dailyReturns.map(r => (r * 100).toFixed(2));
        const bmkData = result.benchmarkReturns.map(r => (r * 100).toFixed(2));
        const sp500Data = result.sp500Returns.map(r => (r * 100).toFixed(2));
        const dates = result.dates;

        const option = {
            animation: false,
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
                axisLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
                axisLabel: { color: '#94a3b8', fontSize: 10 },
                axisTick: { show: false }
            },
            yAxis: {
                type: 'value',
                axisLabel: { formatter: '{value}%', color: '#94a3b8' },
                splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } }
            },
            series: [
                {
                    name: '내 포트폴리오', type: 'line', data: seriesData, smooth: true, showSymbol: false,
                    lineStyle: { color: '#3b82f6', width: 2.5 },
                    areaStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(59, 130, 246, 0.2)' },
                            { offset: 1, color: 'rgba(59, 130, 246, 0)' }
                        ])
                    }
                },
                {
                    name: 'KOSPI 200', type: 'line', data: bmkData, smooth: true, showSymbol: false,
                    lineStyle: { color: 'rgba(148, 163, 184, 0.5)', width: 1.5, type: 'dashed' },
                },
                {
                    name: 'S&P 500', type: 'line', data: sp500Data, smooth: true, showSymbol: false,
                    lineStyle: { color: 'rgba(239, 68, 68, 0.4)', width: 1.5, type: 'dashed' },
                }
            ],
            grid: { top: '5%', left: '3%', right: '4%', bottom: '5%', containLabel: true }
        };
        myChart.setOption(option);
        window.addEventListener('resize', () => myChart.resize());
    }
};

class BacktestEngine extends BaseBacktestEngine {
    constructor(params) {
        super(params);
        if (this.strategy.stocks.length === 1) {
            this.strategy.rebalanceType = 'none';
        }
        this.results.sp500Returns = [];
    }

    run() {
        // BaseEngine의 run을 그대로 사용 (리밸런싱 로직 중복 방지)
        const stats = super.run();

        // S&P 500 데이터 추가 (백테스트 탭 전용)
        const start = this.dates[0];
        const sStart = this.sp500Map.get(start) || 1;
        this.results.sp500Returns = this.dates.map(date => {
            return ((this.sp500Map.get(date) || sStart) / sStart) - 1;
        });

        return stats;
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
