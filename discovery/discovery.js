/**
 * discovery.js — 종목발굴 시뮬레이션 엔진 및 UI 핸들러
 */

/**
 * DiscoveryGASolver: 유전자 알고리즘 기반 포트폴리오 발굴 엔진
 */
class DiscoveryGASolver {
    constructor(pool, config) {
        this.pool = pool;
        this.config = config;
        this.population = [];
        this.generations = config.generations || 40;
        this.popSize = config.popSize || 60;
        this.stockReturns = {};
        this.dates = [];
    }

    async prepareData(periodMonths) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth() - periodMonths, now.getDate());
        const startStr = start.toISOString().substring(0, 10);
        const candleCount = Math.ceil(periodMonths * 23) + 30;

        const batchData = await API.fetchBatch(
            this.pool.map(s => ({ code: s.code, market: s.market })),
            candleCount,
            '1d'
        );

        let commonDates = null;
        batchData.forEach((res) => {
            if (res && res.allCandles && res.allCandles.length > 10) {
                const dates = res.allCandles.map(c => c.date).filter(d => d >= startStr);
                if (!commonDates) commonDates = dates;
                else commonDates = commonDates.filter(d => dates.includes(d));
            }
        });

        if (!commonDates || commonDates.length < 5) throw new Error("공통 데이터 구간이 부족합니다.");
        this.dates = commonDates.sort();

        this.pool.forEach((s, i) => {
            const res = batchData[i];
            if (res && res.allCandles) {
                s.ticker = res.ticker; // Save ticker from API response
                const dateMap = new Map(res.allCandles.map(c => [c.date, c.close]));
                const returns = new Float64Array(this.dates.length - 1);
                for (let j = 1; j < this.dates.length; j++) {
                    const curr = dateMap.get(this.dates[j]);
                    const prev = dateMap.get(this.dates[j - 1]);
                    if (curr && prev) returns[j - 1] = (curr / prev) - 1;
                }
                this.stockReturns[s.code] = returns;
            }
        });

        this.pool = this.pool.filter(s => this.stockReturns[s.code]);
    }

    initPopulation() {
        this.population = [];
        for (let i = 0; i < this.popSize; i++) {
            this.population.push(this.getRandomIndividual());
        }
    }

    getRandomIndividual() {
        const genes = [];
        const poolIndices = Array.from({ length: this.pool.length }, (_, i) => i);
        for (let i = 0; i < this.config.targetCount; i++) {
            if (poolIndices.length === 0) break;
            const idx = Math.floor(Math.random() * poolIndices.length);
            genes.push(poolIndices.splice(idx, 1)[0]);
        }
        return { genes, fitness: -Infinity, stats: null };
    }

    evaluate(individual) {
        const n = this.dates.length - 1;
        const stockCount = individual.genes.length;
        if (stockCount === 0) return;

        const cashWeight = (this.config.cashWeight || 0) / 100;
        const stockWeight = (1 - cashWeight) / stockCount;

        const portReturns = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let dailyRet = 0;
            individual.genes.forEach(gIdx => {
                const code = this.pool[gIdx].code;
                dailyRet += this.stockReturns[code][i] * stockWeight;
            });
            portReturns[i] = dailyRet;
        }

        let cumulative = 1, peak = 1, mdd = 0, sumRet = 0;
        for (let i = 0; i < n; i++) {
            const r = portReturns[i];
            cumulative *= (1 + r);
            sumRet += r;
            if (cumulative > peak) peak = cumulative;
            const dd = (cumulative / peak) - 1;
            if (dd < mdd) mdd = dd;
        }

        const avgRet = sumRet / n;
        let varSum = 0, downVarSum = 0;
        for (let i = 0; i < n; i++) {
            const r = portReturns[i];
            varSum += Math.pow(r - avgRet, 2);
            if (r < 0) downVarSum += Math.pow(r, 2);
        }
        const stdDev = Math.sqrt(varSum / n);
        const downStdDev = Math.sqrt(downVarSum / n);
        const annRet = avgRet * 252;
        const annVol = stdDev * Math.sqrt(252);
        const annDownVol = downStdDev * Math.sqrt(252);

        const sharpe = annVol > 0 ? annRet / annVol : 0;
        const sortino = annDownVol > 0 ? annRet / annDownVol : 0;
        const romad = Math.abs(mdd) > 0 ? (cumulative - 1) / Math.abs(mdd) : (cumulative - 1);
        const absReturn = cumulative - 1;

        let fitness = 0;
        switch (this.config.metric) {
            case 'return': fitness = absReturn; break;
            case 'romad': fitness = romad; break;
            case 'sortino': fitness = sortino; break;
            case 'sharpe':
            default: fitness = sharpe; break;
        }

        individual.fitness = fitness;
        individual.stats = { fitness, absReturn, mdd, sharpe, sortino, romad };
    }

    evolve() {
        const newPop = [];
        this.population.sort((a, b) => b.fitness - a.fitness);
        newPop.push(this.population[0]);
        newPop.push(this.population[1]);
        while (newPop.length < this.popSize) {
            const p1 = this.tournament();
            const p2 = this.tournament();
            const child = this.crossover(p1, p2);
            this.mutate(child);
            newPop.push(child);
        }
        this.population = newPop;
    }

    tournament() {
        const i1 = this.population[Math.floor(Math.random() * this.popSize)];
        const i2 = this.population[Math.floor(Math.random() * this.popSize)];
        if (!i1 || !i2) return this.population[0];
        return i1.fitness > i2.fitness ? i1 : i2;
    }

    crossover(p1, p2) {
        const genes = [];
        const set = new Set();
        for (let i = 0; i < this.config.targetCount; i++) {
            const g = Math.random() > 0.5 ? p1.genes[i] : p2.genes[i];
            if (!set.has(g)) { genes.push(g); set.add(g); }
        }
        while (genes.length < this.config.targetCount) {
            const rg = Math.floor(Math.random() * this.pool.length);
            if (!set.has(rg)) { genes.push(rg); set.add(rg); }
        }
        return { genes, fitness: -Infinity };
    }

    mutate(ind) {
        if (Math.random() < 0.1) {
            const idx = Math.floor(Math.random() * ind.genes.length);
            let rg;
            const currentGenes = new Set(ind.genes);
            do { rg = Math.floor(Math.random() * this.pool.length); } while (currentGenes.has(rg));
            ind.genes[idx] = rg;
        }
    }

    async solve(onProgress) {
        this.initPopulation();
        const hallOfFame = new Map();

        const recordHoF = (ind) => {
            if (ind.fitness !== -Infinity && ind.stats) {
                const key = [...ind.genes].sort((a, b) => a - b).join(',');
                if (!hallOfFame.has(key) || ind.fitness > hallOfFame.get(key).fitness) {
                    hallOfFame.set(key, { ...ind, genes: [...ind.genes], stats: { ...ind.stats } });
                }
            }
        };

        for (let g = 0; g < this.generations; g++) {
            this.population.forEach(ind => {
                if (ind.fitness === -Infinity) this.evaluate(ind);
                recordHoF(ind);
            });
            if (onProgress) onProgress(g + 1, this.generations);
            this.evolve();
        }

        this.population.forEach(ind => {
            if (ind.fitness === -Infinity) this.evaluate(ind);
            recordHoF(ind);
        });

        const allUnique = Array.from(hallOfFame.values());
        allUnique.sort((a, b) => b.fitness - a.fitness);

        return allUnique.slice(0, 50);
    }
}

const DiscoveryUI = {
    selectedStocks: [{ code: 'CASH', name: '현금', ticker: 'CASH', weight: 20 }],
    scenarios: {},
    discoveredResults: [],

    init() {
        this.loadScenarios();
        this.bindEvents();
        this.initTabSelect();
        this.renderStockList();
        this.updateWeightSum();
        this.initInputFormatting();
    },

    initInputFormatting() {
        const caps = [document.getElementById('dsInitialCapital')];
        caps.forEach(inp => {
            if (!inp) return;
            inp.addEventListener('input', (e) => {
                let v = e.target.value.replace(/,/g, '');
                if (!isNaN(v) && v !== '') e.target.value = Number(v).toLocaleString();
            });
            if (inp.value) inp.value = Number(inp.value.replace(/,/g, '')).toLocaleString();
        });
    },

    loadScenarios() {
        const saved = localStorage.getItem('ds_scenarios');
        this.scenarios = saved ? JSON.parse(saved) : {};
        this.renderScenarioSelect();
    },

    saveScenarios() {
        localStorage.setItem('ds_scenarios', JSON.stringify(this.scenarios));
        this.renderScenarioSelect();
    },

    renderScenarioSelect() {
        const sel = document.getElementById('dsScenarioSelect');
        if (!sel) return;
        const current = sel.value;
        sel.innerHTML = '<option value="">선택 안함</option>';
        Object.keys(this.scenarios).sort().forEach(name => {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name; sel.appendChild(opt);
        });
        sel.value = current;
    },

    initTabSelect() {
        const tabs = Storage.getTabs();
        const sel = document.getElementById('dsTabSelect');
        if (!sel) return;
        sel.innerHTML = '<option value="">전체 종목 대상 발굴</option>';
        tabs.forEach(t => { const opt = document.createElement('option'); opt.value = t.uid; opt.textContent = t.name; sel.appendChild(opt); });
        this.renderStockPicker(sel.value);
        sel.addEventListener('change', (e) => this.renderStockPicker(e.target.value));
    },

    renderStockPicker(tabUid) {
        const area = document.getElementById('dsStockPickArea');
        if (!area) return;
        if (!tabUid) {
            area.innerHTML = '<p class="empty-hint" style="padding:10px;">전체 등록된 종목을 대상으로 발굴합니다.<br>(그룹 선택 시 해당 그룹 내에서 발굴)</p>';
            return;
        }
        const stocks = Storage.getWatchlist(tabUid);
        if (stocks.length === 0) { area.innerHTML = '<p class="empty-hint">그룹에 등록된 종목이 없습니다.</p>'; return; }
        area.innerHTML = '<label class="stock-pick-item active"><span>현금</span></label>';
        stocks.forEach(s => {
            const item = document.createElement('label');
            item.className = 'stock-pick-item';
            item.innerHTML = `<span>${s.name}</span>`;
            area.appendChild(item);
        });
    },

    bindEvents() {
        document.getElementById('dsScenarioSelect')?.addEventListener('change', (e) => { if (e.target.value) this.loadScenarioByName(e.target.value); });
        document.getElementById('btnDsSaveScenario')?.addEventListener('click', () => {
            const name = prompt('저장할 시나리오 이름을 입력하세요:');
            if (name) { this.scenarios[name] = this.getCurrentConfig(); this.saveScenarios(); showToast('저장되었습니다.', 'success'); }
        });
        document.getElementById('btnDsDeleteScenario')?.addEventListener('click', () => {
            const name = document.getElementById('dsScenarioSelect').value;
            if (name && confirm(`"${name}" 삭제하시겠습니까?`)) { delete this.scenarios[name]; this.saveScenarios(); showToast('삭제되었습니다.'); }
        });
        document.querySelectorAll('input[name="rebalanceType"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const type = e.target.value;
                const pRow = document.getElementById('rebalancePeriodRow'), dRow = document.getElementById('rebalanceDeviationRow');
                if (pRow) pRow.style.display = type === 'period' ? 'flex' : 'none';
                if (dRow) dRow.style.display = type === 'deviation' ? 'flex' : 'none';
            });
        });
        document.getElementById('btnRunDiscovery')?.addEventListener('click', () => this.runDiscovery());
    },

    getCurrentConfig() {
        return {
            initialCapital: document.getElementById('dsInitialCapital').value,
            feeRate: document.getElementById('dsFeeRate').value,
            taxRate: document.getElementById('dsTaxRate').value,
            periodMonths: document.getElementById('dsPeriodMonths').value,
            rebalanceType: document.querySelector('input[name="rebalanceType"]:checked').value,
            rebalancePeriod: document.getElementById('dsRebalancePeriod').value,
            rebalanceThreshold: document.getElementById('dsRebalanceThreshold').value,
            metric: document.querySelector('input[name="dsMetric"]:checked').value,
            targetCount: document.getElementById('dsTargetStockCount').value,
        };
    },

    loadScenarioByName(name) {
        const config = this.scenarios[name];
        if (!config) return;
        document.getElementById('dsInitialCapital').value = config.initialCapital;
        document.getElementById('dsFeeRate').value = config.feeRate;
        document.getElementById('dsTaxRate').value = config.taxRate;
        document.getElementById('dsPeriodMonths').value = config.periodMonths;
        const rType = document.querySelector(`input[name="rebalanceType"][value="${config.rebalanceType}"]`);
        if (rType) { rType.checked = true; rType.dispatchEvent(new Event('change')); }
        const mType = document.querySelector(`input[name="dsMetric"][value="${config.metric}"]`);
        if (mType) mType.checked = true;
        document.getElementById('dsTargetStockCount').value = config.targetCount;
        this.updateWeightSum();
    },

    renderStockList() {
        const container = document.getElementById('dsStockList');
        if (!container) return;
        container.innerHTML = '';
        const s = this.selectedStocks.find(s => s.code === 'CASH') || { name: '현금', weight: 20 };
        const item = document.createElement('div');
        item.className = 'ds-stock-item';
        item.innerHTML = `
            <span class="ds-stock-name">${s.name} (고정)</span>
            <div class="ds-flex-row" style="gap: 4px; align-items: center;">
                <input type="number" id="dsCashWeight" class="weight-input" value="${s.weight}" min="0" max="100" />
                <span class="unit-text">%</span>
            </div>
        `;
        item.querySelector('#dsCashWeight').addEventListener('input', (e) => {
            const cash = this.selectedStocks.find(ss => ss.code === 'CASH');
            if (cash) cash.weight = Number(e.target.value) || 0;
            this.updateWeightSum();
        });
        container.appendChild(item);
    },

    updateWeightSum() {
        const cashW = Number(document.getElementById('dsCashWeight')?.value) || 0;
        const sumEl = document.getElementById('dsWeightSum'), fillEl = document.getElementById('dsWeightSumFill');
        if (sumEl) sumEl.textContent = cashW + '% + 종목군';
        if (fillEl) fillEl.style.width = '100%';

        // 시작 버튼 활성화
        const btn = document.getElementById('btnRunDiscovery');
        if (btn) btn.disabled = false;
    },

    async runDiscovery() {
        const config = this.getCurrentConfig();
        const periodMonths = parseInt(config.periodMonths) || 12;
        const cashWeight = this.selectedStocks.find(s => s.code === 'CASH')?.weight || 20;

        let pool = [];
        const tabUid = document.getElementById('dsTabSelect').value;
        if (tabUid) { pool = Storage.getWatchlist(tabUid); }
        else { const tabs = Storage.getTabs(); const uniqueStocks = new Map(); tabs.forEach(t => Storage.getWatchlist(t.uid).forEach(s => uniqueStocks.set(s.code, s))); pool = Array.from(uniqueStocks.values()); }

        if (pool.length < parseInt(config.targetCount)) { showToast(`대상 종목이 부족합니다.`, 'error'); return; }

        document.getElementById('dsLoading').style.display = 'flex';
        document.getElementById('dsLoadingProgress').textContent = '데이터 준비 중...';

        const btn = document.getElementById('btnRunDiscovery');
        if (btn) btn.disabled = true;

        try {
            const solver = new DiscoveryGASolver(pool, {
                targetCount: parseInt(config.targetCount),
                metric: config.metric,
                cashWeight: cashWeight,
                generations: 50,
                popSize: 100
            });
            await solver.prepareData(periodMonths);
            this.discoveredResults = await solver.solve((gen, total) => {
                document.getElementById('dsLoadingProgress').textContent = `최적 포트폴리오 탐색 중... (${gen}/${total})`;
            });
            this.displayDiscoveryList(this.discoveredResults, config.metric, solver.pool, solver.config);
            showToast('종목 발굴 완료', 'success');
        } catch (err) { showToast(err.message, 'error'); }
        finally {
            document.getElementById('dsLoading').style.display = 'none';
            if (btn) btn.disabled = false;
        }
    },

    displayDiscoveryList(results, metricKey, solverPool, solverConfig) {
        document.getElementById('dsEmptyState').style.display = 'none';
        document.getElementById('dsResultState').style.display = 'block';
        const metricNames = { return: '수익률', sharpe: '샤프지수', romad: 'RoMAD', sortino: '소르티노' };
        document.getElementById('thMetricValue').textContent = metricNames[metricKey];
        const logBody = document.getElementById('dsLogBody');
        logBody.innerHTML = '';

        results.forEach((res, idx) => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.className = 'ds-res-row';

            const comboNamesHtml = res.genes.map(gIdx => {
                const s = solverPool[gIdx];
                return `<span class="ds-stock-ticker" data-gidx="${gIdx}" title="${s.name}">${s.ticker}</span>`;
            }).join('');

            const retVal = res.stats.absReturn * 100;
            tr.innerHTML = `
                <td>${idx + 1}</td>
                <td style="text-align:left;">${comboNamesHtml}</td>
                <td style="color:var(--accent); font-weight:700;">${res.stats.fitness.toFixed(2)}</td>
                <td class="${retVal >= 0 ? 'up' : 'down'}">${fmtPct(retVal)}</td>
                <td class="down">${fmtPct(res.stats.mdd * 100)}</td>
                <td><button class="ds-btn outline" style="height:22px; padding:0 8px; font-size:11px;">분석</button></td>
            `;

            tr.addEventListener('click', () => {
                document.querySelectorAll('.ds-res-row').forEach(r => r.classList.remove('active'));
                tr.classList.add('active');
                this.runDetailedBacktest(res, solverPool, solverConfig);
            });

            tr.querySelectorAll('.ds-stock-ticker').forEach(span => {
                span.addEventListener('click', (e) => {
                    e.stopPropagation();
                    document.querySelectorAll('.ds-res-row').forEach(r => r.classList.remove('active'));
                    tr.classList.add('active');
                    const gIdx = parseInt(span.getAttribute('data-gidx'));
                    this.runSingleStockBacktest(gIdx, solverPool, solverConfig);
                });
            });

            logBody.appendChild(tr);
        });
        if (results.length > 0) this.runDetailedBacktest(results[0], solverPool, solverConfig);
    },

    async runDetailedBacktest(res, solverPool, solverConfig) {
        const cashWeight = solverConfig.cashWeight;
        const stockWeight = (100 - cashWeight) / res.genes.length;
        const stocks = res.genes.map(gIdx => { const s = solverPool[gIdx]; return { code: s.code, name: s.name, ticker: s.ticker, weight: stockWeight }; });
        stocks.unshift({ code: 'CASH', name: '현금', ticker: 'CASH', weight: cashWeight });
        this.selectedStocks = stocks;
        const config = this.getCurrentConfig();
        await this.executeSimulationInternal(
            Number(config.initialCapital.replace(/,/g, '')),
            Number(config.feeRate) / 100,
            Number(config.taxRate) / 100,
            parseInt(config.periodMonths),
            stocks,
            config
        );
    },

    async runSingleStockBacktest(gIdx, solverPool, solverConfig) {
        const cashWeight = solverConfig.cashWeight || 0;
        const stockWeight = 100 - cashWeight;
        const s = solverPool[gIdx];
        const stocks = [
            { code: 'CASH', name: '현금', ticker: 'CASH', weight: cashWeight },
            { code: s.code, name: s.name, ticker: s.ticker, weight: stockWeight }
        ];
        this.selectedStocks = stocks;
        const config = this.getCurrentConfig();
        await this.executeSimulationInternal(
            Number(config.initialCapital.replace(/,/g, '')),
            Number(config.feeRate) / 100,
            Number(config.taxRate) / 100,
            parseInt(config.periodMonths),
            stocks,
            config
        );
    },

    async executeSimulationInternal(initialCapital, feeRate, taxRate, periodMonths, stocks, config) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth() - periodMonths, now.getDate());
        const startStr = start.toISOString().substring(0, 10);
        document.getElementById('dsLoading').style.display = 'flex';
        document.getElementById('dsLoadingProgress').textContent = '상세 데이터 로드...';

        try {
            const stocksToFetch = stocks.filter(s => s.code !== 'CASH');
            const candleCount = Math.ceil(periodMonths * 23) + 30;
            const batchData = await API.fetchBatch(stocksToFetch.map(s => ({ code: s.code, ticker: s.ticker })), candleCount, '1d');

            let bHistory = [], spHistory = [];
            try {
                const bmk = await API.fetchStock('^KS200', 300, '1d', 'KS'); bHistory = bmk.allCandles || [];
                const sp = await API.fetchStock('^GSPC', 300, '1d', 'US'); spHistory = sp.allCandles || [];
            } catch (e) { }

            const historyMap = {};
            batchData.forEach((res, i) => { if (res?.allCandles?.length > 0) historyMap[stocksToFetch[i].ticker] = res.allCandles; });

            let commonDates = [];
            const tickers = Object.keys(historyMap);
            if (tickers.length > 0) {
                commonDates = historyMap[tickers[0]].map(h => h.date);
                tickers.forEach(t => {
                    const dates = new Set(historyMap[t].map(h => h.date));
                    commonDates = commonDates.filter(d => dates.has(d));
                });
                commonDates = commonDates.filter(d => d >= startStr).sort();
            }
            if (stocks.some(s => s.code === 'CASH')) historyMap['CASH'] = commonDates.map(d => ({ date: d, close: 1 }));

            const engine = new DiscoveryEngine({
                initialCapital, feeRate, taxRate,
                strategy: { stocks, rebalanceType: config.rebalanceType, rebalancePeriod: config.rebalancePeriod, rebalanceThreshold: config.rebalanceThreshold },
                dates: commonDates, historyMap, benchmarkHistory: bHistory, sp500History: spHistory
            });
            this.displayBacktestResults(engine.run());
        } catch (err) { showToast(err.message, 'error'); }
        finally { document.getElementById('dsLoading').style.display = 'none'; }
    },

    displayBacktestResults(result) {
        document.getElementById('resTotalReturn').textContent = fmtPct(result.totalReturn * 100);
        document.getElementById('resTotalReturn').className = 'value ' + (result.totalReturn >= 0 ? 'up' : 'down');
        document.getElementById('resTotalProfit').textContent = fmt(Math.round(result.totalProfit)) + ' 원';
        document.getElementById('resCAGR').textContent = fmtPct(result.cagr * 100);
        document.getElementById('resMDD').textContent = fmtPct(result.mdd * 100);

        const rankHtml = (val, ths) => {
            let rank = 'Fair', col = '#f59e0b';
            if (val >= ths[2]) { rank = 'Great'; col = '#10b981'; }
            else if (val >= ths[1]) { rank = 'Good'; col = '#3b82f6'; }
            return `<span style="font-size:14px;font-weight:700;">${val.toFixed(2)}</span> <span style="font-size:10px;font-weight:600;padding:2px 4px;border-radius:4px;background-color:${col}33;color:${col};margin-left:4px;">${rank}</span>`;
        };

        document.getElementById('resSharpe').innerHTML = rankHtml(result.sharpe, [0, 0.5, 1.0]);
        document.getElementById('resSortino').innerHTML = rankHtml(result.sortino, [0, 0.75, 1.5]);
        document.getElementById('resCalmar').innerHTML = rankHtml(result.calmar, [0, 0.5, 1.0]);
        document.getElementById('resIR').innerHTML = rankHtml(result.infoRatio, [-0.5, 0, 0.5]);
        this.renderMainChart(result);
    },

    renderMainChart(result) {
        const chartDom = document.getElementById('dsMainChart');
        if (!chartDom) return;
        const myChart = echarts.getInstanceByDom(chartDom) || echarts.init(chartDom);
        myChart.setOption({
            animation: false, backgroundColor: 'transparent',
            tooltip: { trigger: 'axis' },
            grid: { top: '5%', left: '3%', right: '4%', bottom: '5%', containLabel: true },
            xAxis: { type: 'category', data: result.dates, axisLabel: { color: '#94a3b8', fontSize: 10 } },
            yAxis: { type: 'value', axisLabel: { formatter: '{value}%', color: '#94a3b8' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.03)' } } },
            series: [
                { name: '내 포트폴리오', type: 'line', data: result.dailyReturns.map(r => (r * 100).toFixed(2)), smooth: true, showSymbol: false, lineStyle: { color: '#3b82f6', width: 2.5 } },
                { name: 'KOSPI 200', type: 'line', data: result.benchmarkReturns.map(r => (r * 100).toFixed(2)), smooth: true, showSymbol: false, lineStyle: { color: 'rgba(148,163,184,0.5)', width: 1.5, type: 'dashed' } }
            ]
        }, true);
    }
};

class DiscoveryEngine {
    constructor({ initialCapital, feeRate, taxRate, strategy, dates, historyMap, benchmarkHistory, sp500History }) {
        this.initialCapital = initialCapital; this.feeRate = feeRate; this.taxRate = taxRate; this.strategy = strategy;
        this.dates = dates; this.historyMap = historyMap; this.benchmarkHistory = benchmarkHistory; this.sp500History = sp500History || [];
        this.historyDateMaps = {};
        for (const t in this.historyMap) this.historyDateMaps[t] = new Map(this.historyMap[t].map(h => [h.date, h.close]));
        this.benchmarkMap = new Map(this.benchmarkHistory.map(h => [h.date, h.close]));
        this.sp500Map = new Map(this.sp500History.map(h => [h.date, h.close]));
        this.currentCash = initialCapital; this.peakValue = 0; this.totalCost = 0;
        this.holdings = {};
        this.strategy.stocks.forEach(s => { this.holdings[s.ticker] = { qty: 0, weight: s.weight / 100, startPrice: 0 }; });
        this.results = { dates: [], dailyValues: [], dailyReturns: [], benchmarkReturns: [], logs: [], initialCapital };
    }

    getPrice(ticker, date) { const m = this.historyDateMaps[ticker]; return m ? (m.get(date) || 0) : 0; }

    run() {
        const start = this.dates[0];
        this.rebalance(start, "최초 매수", 0, true);
        this.dates.forEach(date => {
            const val = this.calculateTotalValue(date);
            this.results.dates.push(date);
            this.results.dailyValues.push(val);
            this.results.dailyReturns.push((val / this.initialCapital) - 1);

            // Re-calc benchmark cumulative
            const bStart = this.benchmarkMap.get(this.dates[0]) || 1;
            const bCurr = this.benchmarkMap.get(date) || bStart;
            this.results.benchmarkReturns.push((bCurr / bStart) - 1);

            if (this.strategy.rebalanceType === 'period' && this.shouldRebalance(date)) this.rebalance(date, "정기 리밸런싱");
            else if (this.strategy.rebalanceType === 'deviation') {
                const trigger = this.checkDeviation(val);
                if (trigger) this.rebalance(date, "비중 이탈 리밸런싱", 0, false, null, trigger);
            }
        });
        return this.calculateFinalStats();
    }

    calculateTotalValue(date) {
        let total = this.currentCash;
        for (const t in this.holdings) {
            const p = this.getPrice(t, date);
            if (p > 0) this.holdings[t].currentPrice = p;
            total += this.holdings[t].qty * (this.holdings[t].currentPrice || 0);
        }
        return total;
    }

    shouldRebalance(date) {
        const d = new Date(date), pd = new Date(this.results.dates[this.results.dates.length - 2] || date);
        switch (this.strategy.rebalancePeriod) {
            case '1mo': return d.getMonth() !== pd.getMonth();
            case '1yr': return d.getFullYear() !== pd.getFullYear();
            default: return false;
        }
    }

    checkDeviation(total) {
        for (const t in this.holdings) {
            const h = this.holdings[t];
            const weight = (h.qty * h.currentPrice) / total;
            if (Math.abs(weight - h.weight) > (this.strategy.rebalanceThreshold / 100)) return t;
        }
        return null;
    }

    rebalance(date, reason, withdraw = 0, isInitial = false) {
        let total = this.currentCash;
        for (const t in this.holdings) {
            const p = this.getPrice(t, date); if (p > 0) this.holdings[t].currentPrice = p;
            total += this.holdings[t].qty * (this.holdings[t].currentPrice || 0);
        }
        const target = total - withdraw;
        let cost = 0, stockVal = 0;
        for (const t in this.holdings) {
            const h = this.holdings[t]; if (h.currentPrice <= 0) continue;
            const tQty = t === 'CASH' ? (target * h.weight) : Math.floor((target * h.weight) / h.currentPrice);
            const diff = tQty - h.qty;
            if (diff !== 0 && t !== 'CASH') {
                cost += Math.abs(diff * h.currentPrice) * (this.feeRate + (diff < 0 ? this.taxRate : 0));
            }
            h.qty = tQty; if (isInitial) h.startPrice = h.currentPrice || 1;
            stockVal += h.qty * h.currentPrice;
        }
        this.currentCash = target - cost - stockVal;
    }

    calculateFinalStats() {
        const vals = this.results.dailyValues;
        const last = vals[vals.length - 1];
        const totalReturn = (last / this.initialCapital) - 1;
        let peak = 0, mdd = 0;
        vals.forEach(v => { if (v > peak) peak = v; const dd = (v / peak) - 1; if (dd < mdd) mdd = dd; });
        const start = new Date(this.results.dates[0]), end = new Date(this.results.dates[this.results.dates.length - 1]);
        const years = Math.max((end - start) / (365.25 * 24 * 3600 * 1000), 0.01);
        const cagr = Math.pow(last / this.initialCapital, 1 / years) - 1;
        const returns = [];
        for (let i = 1; i < vals.length; i++) returns.push((vals[i] / vals[i - 1]) - 1);
        const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
        const std = Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / (returns.length - 1));
        const dstd = Math.sqrt(returns.reduce((a, b) => a + Math.pow(Math.min(b, 0), 2), 0) / (returns.length - 1)) || 1;
        const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;
        const sortino = dstd > 0 ? (avg / dstd) * Math.sqrt(252) : 0;
        const calmar = Math.abs(mdd) > 0 ? cagr / Math.abs(mdd) : 0;
        return { ...this.results, totalReturn, totalProfit: last - this.initialCapital, mdd, cagr, sharpe, sortino, calmar, infoRatio: 0 };
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    try { await Storage.init(); DiscoveryUI.init(); }
    catch (err) { console.error(err); showToast('초기화 실패', 'error'); }
});
