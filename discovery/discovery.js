/**
 * discovery.js — 종목발굴 시뮬레이션 엔진 및 UI 핸들러
 */

/**
 * DiscoveryPSOSolver: 입자 군집 최적화(PSO) 기반 포트폴리오 발굴 엔진
 *
 * - 연속 공간에서 속도/위치를 업데이트한 후 이산화(반올림)하여 종목 인덱스로 변환
 * - 관성 가중치 선형 감소(wMax→wMin)로 초기 탐색 → 후기 수렴 자동 조절
 * - 모든 입자의 모든 반복 조합을 아카이브에 기록하여 TOP 50 추출
 */
class DiscoveryPSOSolver {
    constructor(pool, config) {
        this.pool = pool;
        this.config = config;
        this.swarmSize = config.swarmSize || 150;
        this.maxIter = config.maxIter || 100;
        this.wMax = config.wMax ?? 1.1;
        this.wMin = config.wMin ?? 0.5;
        this.c1 = config.c1 ?? 1.5;
        this.c2 = config.c2 ?? 1.5;
        this.mutProb = config.mutProb ?? 0.25;
        this.swarm = [];
        this.gBest = null;
        this.stockReturns = {};
        this.dates = [];
    }

    // ──────────────────────────────────────────────
    // 데이터 준비 (기존 GA와 동일)
    // ──────────────────────────────────────────────
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

        // [복구] 가장 긴 날짜 배열을 기준으로 설정 (신규주에 의해 기간이 짤리는 현상 방지)
        let maxDates = [];
        batchData.forEach(res => {
            if (res && res.allCandles) {
                const dates = res.allCandles.map(c => c.date).filter(d => d >= startStr);
                if (dates.length > maxDates.length) maxDates = dates;
            }
        });
        this.dates = maxDates.sort();

        // 최소 90% 이상의 데이터가 있는 종목만 사용
        const requiredCount = Math.floor(this.dates.length * 0.9);
        this.stockCache = {};
        this.candleMaps = {};
        const validPool = [];

        this.pool.forEach((s, i) => {
            const res = batchData[i];
            if (res && res.allCandles) {
                const candleMap = new Map(res.allCandles.map(c => [c.date, c.close]));
                const sPrice = candleMap.get(this.dates[0]);
                const ePrice = candleMap.get(this.dates[this.dates.length - 1]);
                const existingCount = res.allCandles.filter(c => c.date >= startStr).length;

                if (sPrice && ePrice && existingCount >= requiredCount) {
                    s.ticker = res.ticker;
                    let peak = 1, mdd = 0;
                    const dayReturns = [];
                    let lastPrice = sPrice;

                    this.dates.forEach(d => {
                        const curr = candleMap.get(d) || lastPrice;
                        const dailyRet = (curr / lastPrice) - 1;
                        dayReturns.push(dailyRet);
                        const currentNav = curr / sPrice;
                        if (currentNav > peak) peak = currentNav;
                        const dd = (currentNav / peak) - 1;
                        if (dd < mdd) mdd = dd;
                        lastPrice = curr;
                    });

                    this.stockCache[s.code] = {
                        totalReturn: (ePrice / sPrice) - 1,
                        mdd: mdd,
                        dayReturns: dayReturns,
                        correlations: res.correlations // Store correlation info
                    };
                    this.candleMaps[s.code] = candleMap;
                    validPool.push(s);
                }
            }
        });

        this.pool = validPool.sort((a, b) => (this.stockCache[b.code].totalReturn - this.stockCache[a.code].totalReturn));
        if (this.pool.length === 0) throw new Error("전체 분석 기간의 데이터를 90% 이상 보유한 종목이 없습니다.");
    }

    // ──────────────────────────────────────────────
    // 군집 초기화
    // ──────────────────────────────────────────────
    initSwarm() {
        this.swarm = [];
        const poolSize = this.pool.length;
        const dim = this.config.targetCount;
        this.vMax = poolSize * 0.3;

        // 1. [Elite Seeding] 0번 입자는 항상 현재 풀에서 가장 수익률이 높은 상위 종목들로 구성
        const eliteIndices = [];
        for (let i = 0; i < Math.min(dim, poolSize); i++) eliteIndices.push(i);
        const eliteParticle = {
            position: eliteIndices.map(idx => idx),
            velocity: new Array(dim).fill(0),
            genes: [...eliteIndices],
            pBest: [...eliteIndices],
            pBestFit: -Infinity,
            fitness: -Infinity,
            stats: null
        };
        this.swarm.push(eliteParticle);

        // 2. [Correlation Seeding] 상관관계 옵션이 켜져 있으면 일부 입자를 음의 상관관계 조합으로 초기화
        let startIdx = 1;
        if (this.config.useCorrelation) {
            const numCorrSeeds = Math.floor(this.swarmSize * 0.25); // 25% 정도는 상관관계 기반으로 시딩
            const codeToIndexMap = new Map(this.pool.map((s, idx) => [s.code, idx]));

            for (let i = 0; i < numCorrSeeds; i++) {
                const indices = [];
                const used = new Set();

                // [유형] 상위 수익률 종목 + 그 종목과 가장 상관관계가 낮은 종목을 50/50으로 믹스
                // 상위 20% 이내에서 앵커(Anchor) 종목을 랜덤하게 선택
                const anchorRange = Math.max(1, Math.floor(poolSize * 0.2));

                while (indices.length < dim) {
                    let seedIdx = Math.floor(Math.random() * anchorRange);

                    // 중복 피하기 시도
                    let attempts = 0;
                    while (used.has(seedIdx) && attempts < anchorRange) {
                        seedIdx = (seedIdx + 1) % anchorRange;
                        attempts++;
                    }

                    if (!used.has(seedIdx)) {
                        indices.push(seedIdx);
                        used.add(seedIdx);

                        // 짝꿍(상관관계가 가장 낮은 종목) 매칭
                        const stock = this.pool[seedIdx];
                        const negCode = this.stockCache[stock.code]?.correlations?.neg?.code;
                        if (negCode && codeToIndexMap.has(negCode)) {
                            const negIdx = codeToIndexMap.get(negCode);
                            if (!used.has(negIdx) && indices.length < dim) {
                                indices.push(negIdx);
                                used.add(negIdx);
                            }
                        }
                    }

                    // 앵커 범위 내에서 더 이상 뽑을 게 없거나 순환이 안되면 전체 풀에서 보충
                    if (attempts >= anchorRange && indices.length < dim) {
                        let fallbackIdx = Math.floor(Math.random() * poolSize);
                        if (!used.has(fallbackIdx)) {
                            indices.push(fallbackIdx);
                            used.add(fallbackIdx);
                        }
                    }
                }

                if (indices.length === dim) {
                    this.swarm.push(this._createParticleFromIndices(indices, dim));
                } else {
                    this.swarm.push(this.createRandomParticle(poolSize, dim));
                }
            }
            startIdx = this.swarm.length;
        }

        // 3. 나머지 입자는 랜덤 생성
        for (let i = startIdx; i < this.swarmSize; i++) {
            const particle = this.createRandomParticle(poolSize, dim);
            this.swarm.push(particle);
        }
        this.gBest = null;
    }

    _createParticleFromIndices(indices, dim) {
        const position = indices.map(i => i);
        const velocity = new Array(dim).fill(0).map(() =>
            (Math.random() - 0.5) * 2 * this.vMax * 0.1
        );
        return {
            position,
            velocity,
            genes: [...indices],
            pBest: [...indices],
            pBestFit: -Infinity,
            fitness: -Infinity,
            stats: null
        };
    }

    createRandomParticle(poolSize, dim) {
        // 랜덤 위치: 풀에서 중복 없이 K개 선택 (연속 값으로 저장)
        const indices = [];
        const used = new Set();
        while (indices.length < dim) {
            const idx = Math.floor(Math.random() * poolSize);
            if (!used.has(idx)) { indices.push(idx); used.add(idx); }
        }

        const position = indices.map(i => i);            // 연속 위치 (초기에는 정수)
        const velocity = new Array(dim).fill(0).map(() =>
            (Math.random() - 0.5) * 2 * this.vMax * 0.1  // 작은 초기 속도
        );

        return {
            position,
            velocity,
            genes: [...indices],     // 이산화된 현재 위치 (= 종목 인덱스)
            pBest: [...indices],      // 개인 최적 위치
            pBestFit: -Infinity,
            fitness: -Infinity,
            stats: null
        };
    }

    // ──────────────────────────────────────────────
    // 적합도 평가 (캐싱된 정밀 데이터 기반)
    // ──────────────────────────────────────────────
    evaluate(particle) {
        const genes = particle.genes;
        if (genes.length === 0) return;

        const cashWeight = (this.config.cashWeight || 0) / 100;
        const stockWeight = (1 - cashWeight) / genes.length;

        // 포트폴리오 전체의 일별 수익률 합산 (정밀 리밸런싱 근사)
        const n = this.dates.length;
        const feeRate = this.config.feeRate || 0.0015;
        const taxRate = 0.0020; // 표준 매도세율 적용

        // [로직 개선] 추정 일회성 거래 비용(진입 시) 패널티 적용
        let cumulative = 1 - (feeRate * (1 - cashWeight));

        let peak = cumulative, mdd = 0;

        const portReturns = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let dailyRet = 0;
            genes.forEach(gIdx => {
                const code = this.pool[gIdx].code;
                dailyRet += this.stockCache[code].dayReturns[i] * stockWeight;
            });
            portReturns[i] = dailyRet;

            cumulative *= (1 + dailyRet);
            if (cumulative > peak) peak = cumulative;
            const dd = (cumulative / peak) - 1;
            if (dd < mdd) mdd = dd;
        }

        const absReturn = cumulative - 1;

        // [로직 개선] 정기 리밸런싱 발생 시 누적될 추정 비용 패널티 반영 (월 1회 리밸런싱 가정)
        const estRebalanceCost = (this.dates.length / 21) * (feeRate + taxRate) * (1 - cashWeight) * 0.5; // 보수적 추정치
        const adjustedReturn = absReturn - estRebalanceCost;

        const sumRet = portReturns.reduce((acc, r) => acc + r, 0);
        const avgRet = sumRet / n;
        let varSum = 0, downVarSum = 0;
        for (let i = 0; i < n; i++) {
            const r = portReturns[i];
            varSum += Math.pow(r - avgRet, 2);
            if (r < 0) downVarSum += Math.pow(r, 2);
        }
        const stdDev = Math.sqrt(varSum / n);
        const downStdDev = Math.sqrt(downVarSum / n);
        const annRet = (adjustedReturn / n) * 252; // 보정된 수익률 기반 연환산
        const annVol = stdDev * Math.sqrt(252);
        const annDownVol = downStdDev * Math.sqrt(252);

        const sharpe = annVol > 0 ? annRet / annVol : 0;
        const sortino = annDownVol > 0 ? annRet / annDownVol : 0;
        const romad = Math.abs(mdd) > 0 ? adjustedReturn / Math.abs(mdd) : adjustedReturn;

        let fitness = 0;
        switch (this.config.metric) {
            case 'return':
                // [개선] 변동성 대비 수익 옵션이 켜져 있으면 수익률을 연환산 변동성으로 나누어 계산
                fitness = (this.config.useRiskAdjusted && annVol > 0) ? absReturn / annVol : absReturn;
                break;
            case 'romad': fitness = romad; break;
            case 'sortino': fitness = sortino; break;
            case 'sharpe':
            default: fitness = sharpe; break;
        }

        particle.fitness = fitness;
        particle.stats = { fitness, absReturn, mdd, sharpe, sortino, romad };
    }

    // ──────────────────────────────────────────────
    // 속도 업데이트
    // ──────────────────────────────────────────────
    updateVelocity(particle, w) {
        const dim = particle.position.length;
        for (let d = 0; d < dim; d++) {
            const r1 = Math.random();
            const r2 = Math.random();
            particle.velocity[d] =
                w * particle.velocity[d]
                + this.c1 * r1 * (particle.pBest[d] - particle.position[d])
                + this.c2 * r2 * (this.gBest.genes[d] - particle.position[d]);

            // 속도 클램핑
            if (particle.velocity[d] > this.vMax) particle.velocity[d] = this.vMax;
            if (particle.velocity[d] < -this.vMax) particle.velocity[d] = -this.vMax;
        }
    }

    // ──────────────────────────────────────────────
    // 위치 업데이트 + 이산화
    // ──────────────────────────────────────────────
    updatePosition(particle) {
        const poolSize = this.pool.length;
        const dim = particle.position.length;

        // 연속 위치 업데이트
        for (let d = 0; d < dim; d++) {
            particle.position[d] += particle.velocity[d];
            // 경계 클램핑
            if (particle.position[d] < 0) {
                particle.position[d] = 0;
                particle.velocity[d] *= -0.5; // 벽 반사
            }
            if (particle.position[d] > poolSize - 1) {
                particle.position[d] = poolSize - 1;
                particle.velocity[d] *= -0.5;
            }
        }

        // 이산화: 반올림 후 중복 해소
        const rounded = particle.position.map(x => Math.round(x));
        particle.genes = this.resolveCollisions(rounded, poolSize);
    }

    // ──────────────────────────────────────────────
    // 중복 해소: 같은 종목이 선택되면 가장 가까운 미사용 인덱스로 교체
    // ──────────────────────────────────────────────
    resolveCollisions(indices, poolSize) {
        const used = new Set();
        const result = new Array(indices.length);

        // 1차: 중복 없는 것 먼저 확정
        for (let i = 0; i < indices.length; i++) {
            let idx = Math.max(0, Math.min(poolSize - 1, indices[i]));
            if (!used.has(idx)) {
                result[i] = idx;
                used.add(idx);
            } else {
                result[i] = -1; // 중복 → 나중에 해결
            }
        }

        // 2차: 중복된 슬롯에 대해 가장 가까운 미사용 인덱스 할당
        for (let i = 0; i < result.length; i++) {
            if (result[i] !== -1) continue;
            const target = Math.max(0, Math.min(poolSize - 1, indices[i]));
            let offset = 0;
            while (true) {
                const up = target + offset;
                const down = target - offset;
                if (up < poolSize && !used.has(up)) {
                    result[i] = up; used.add(up); break;
                }
                if (down >= 0 && !used.has(down)) {
                    result[i] = down; used.add(down); break;
                }
                offset++;
                if (offset > poolSize) break; // 안전장치
            }
        }
        return result;
    }

    // ──────────────────────────────────────────────
    // 돌연변이: 다양성 유지
    // ──────────────────────────────────────────────
    mutate(particle) {
        if (Math.random() < this.mutProb) {
            const poolSize = this.pool.length;
            const dim = particle.genes.length;
            const mutIdx = Math.floor(Math.random() * dim);
            const currentGenes = new Set(particle.genes);

            // 완전히 랜덤한 새 종목으로 교체
            let newGene;
            let attempts = 0;
            do {
                newGene = Math.floor(Math.random() * poolSize);
                attempts++;
            } while (currentGenes.has(newGene) && attempts < poolSize);

            if (!currentGenes.has(newGene)) {
                particle.genes[mutIdx] = newGene;
                particle.position[mutIdx] = newGene; // 연속 위치도 동기화
            }
        }
    }

    // ──────────────────────────────────────────────
    // 아카이브 기록
    // ──────────────────────────────────────────────
    recordArchive(particle, archive) {
        if (particle.fitness === -Infinity || !particle.stats) return;
        const key = [...particle.genes].sort((a, b) => a - b).join(',');
        if (!archive.has(key) || particle.fitness > archive.get(key).fitness) {
            archive.set(key, {
                genes: [...particle.genes],
                fitness: particle.fitness,
                stats: { ...particle.stats }
            });
        }
    }

    // ──────────────────────────────────────────────
    // 메인 PSO 루프
    // ──────────────────────────────────────────────
    async solve(onProgress) {
        this.initSwarm();
        const archive = new Map();

        // 초기 평가
        for (const p of this.swarm) {
            this.evaluate(p);
            // pBest 초기화
            p.pBest = [...p.genes];
            p.pBestFit = p.fitness;
            // gBest 초기화
            if (!this.gBest || p.fitness > this.gBest.fitness) {
                this.gBest = { genes: [...p.genes], fitness: p.fitness, stats: { ...p.stats } };
            }
            this.recordArchive(p, archive);
        }

        for (let iter = 0; iter < this.maxIter; iter++) {
            // 관성 가중치 선형 감소
            const w = this.wMax - (this.wMax - this.wMin) * (iter / this.maxIter);

            // 속도 + 위치 업데이트
            for (const p of this.swarm) {
                this.updateVelocity(p, w);
                this.updatePosition(p);
                this.mutate(p);
            }

            // 평가 + pBest/gBest 갱신
            for (const p of this.swarm) {
                this.evaluate(p);

                // 개인 최적 갱신
                if (p.fitness > p.pBestFit) {
                    p.pBest = [...p.genes];
                    p.pBestFit = p.fitness;
                }

                // 글로벌 최적 갱신
                if (p.fitness > this.gBest.fitness) {
                    this.gBest = { genes: [...p.genes], fitness: p.fitness, stats: { ...p.stats } };
                }

                // 아카이브 기록
                this.recordArchive(p, archive);
            }

            if (onProgress) onProgress(iter + 1, this.maxIter);

            // 비동기 양보 (UI 갱신 허용) — 10회마다
            if (iter % 10 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        // 아카이브에서 TOP 50 추출
        const allUnique = Array.from(archive.values());
        allUnique.sort((a, b) => b.fitness - a.fitness);
        return allUnique.slice(0, 50);
    }
}

const DiscoveryUI = {
    selectedStocks: [{ code: 'CASH', name: '현금', ticker: 'CASH', weight: 20 }],
    scenarios: {},
    discoveredResults: [],
    currentAnalysisTarget: '', // 분석 대상 타이틀 저장용
    currentSort: { key: 'fitness', desc: true },

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

        // Trigger initial state for rebalance rows
        const checkedRebalance = document.querySelector('input[name="rebalanceType"]:checked');
        if (checkedRebalance) checkedRebalance.dispatchEvent(new Event('change'));

        document.getElementById('btnRunDiscovery')?.addEventListener('click', () => this.runDiscovery());

        // 컬럼 헤더 클릭 정렬 이벤트
        document.querySelectorAll('#dsLogHead th[data-sort]').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.getAttribute('data-sort');
                this.toggleSort(key);
            });
        });
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

        // 첫 번째 그룹이 존재하면 기본으로 선택
        if (tabs.length > 0) {
            sel.value = tabs[0].uid;
        }

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
            useCorrelation: document.getElementById('dsUseCorrelation').checked,
            useRiskAdjusted: document.getElementById('dsUseRiskAdjusted').checked,
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
        if (document.getElementById('dsUseCorrelation')) {
            document.getElementById('dsUseCorrelation').checked = !!config.useCorrelation;
        }
        if (document.getElementById('dsUseRiskAdjusted')) {
            document.getElementById('dsUseRiskAdjusted').checked = !!config.useRiskAdjusted;
        }
        this.updateWeightSum();
    },

    toggleSort(key) {
        if (this.currentSort.key === key) {
            this.currentSort.desc = !this.currentSort.desc;
        } else {
            this.currentSort.key = key;
            this.currentSort.desc = true;
        }


        if (this.discoveredResults && this.discoveredResults.length > 0) {
            this.displayDiscoveryList(this.discoveredResults, this.getCurrentConfig().metric, this.discoveredSolver.pool, this.discoveredSolver.config);
        }
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

        const btn = document.getElementById('btnRunDiscovery');
        const originalBtnText = btn.textContent;
        if (btn) {
            btn.disabled = true;
            btn.classList.add('loading');
            btn.textContent = '데이터 준비...';
        }

        try {
            const solver = new DiscoveryPSOSolver(pool, {
                targetCount: parseInt(config.targetCount),
                metric: config.metric,
                cashWeight: cashWeight,
                swarmSize: 150,
                maxIter: 100,
                wMax: 1.1,
                wMin: 0.5,
                c1: 1.5,
                c2: 1.5,
                mutProb: 0.25,
                useCorrelation: config.useCorrelation,
                useRiskAdjusted: config.useRiskAdjusted,
                feeRate: Number(config.feeRate) / 100
            });
            this.discoveredSolver = solver;
            await solver.prepareData(periodMonths);

            this.discoveredResults = await solver.solve((iter, total) => {
                const pct = Math.floor((iter / total) * 100);
                if (btn) btn.textContent = `발굴 중... ${pct}%`;
            });

            // [벤치마크 최적화] 정밀 검증 시작 전 벤치마크 데이터를 미리 로드하여 재사용
            if (btn) btn.textContent = `벤치마크 로딩 중...`;
            const bmkData = await API.fetchBenchmark(solver.dates.length + 30, '1d');
            const sp500Data = await API.fetchSP500(solver.dates.length + 30, '1d');

            const startStr = solver.dates[0];
            const benchmarkHistory = bmkData.filter(d => d.date >= startStr);
            const sp500History = sp500Data.filter(d => d.date >= startStr);

            // [핵심 개선] PSO 결과 TOP 50에 대해 '정밀 백테스트 엔진' 전수 조사 및 재정렬
            const initialCapital = Number(document.getElementById('dsInitialCapital').value.replace(/,/g, ''));
            const feeRate = Number(document.getElementById('dsFeeRate').value) / 100;
            const taxRate = Number(document.getElementById('dsTaxRate').value) / 100;

            let completedCount = 0;
            const totalToVerify = this.discoveredResults.length;

            const preciseJobs = this.discoveredResults.map(async (res) => {
                try {
                    const stockWeight = (100 - cashWeight) / res.genes.length;
                    const stocks = res.genes.map(gIdx => {
                        const s = solver.pool[gIdx];
                        return { code: s.code, name: s.name, ticker: s.ticker, weight: stockWeight };
                    });
                    stocks.unshift({ code: 'CASH', name: '현금', ticker: 'CASH', weight: cashWeight });

                    const historyMap = {};
                    res.genes.forEach(gIdx => {
                        const s = solver.pool[gIdx];
                        const candleMap = solver.candleMaps[s.code];
                        let lastValidPrice = 0;
                        // 첫 번째 유효 가격 찾기
                        for (const d of solver.dates) {
                            const p = candleMap.get(d);
                            if (p) { lastValidPrice = p; break; }
                        }

                        historyMap[s.ticker] = solver.dates.map(d => {
                            const p = candleMap.get(d);
                            if (p) lastValidPrice = p;
                            return { date: d, close: lastValidPrice };
                        });
                    });
                    historyMap['CASH'] = solver.dates.map(d => ({ date: d, close: 1 }));

                    const engine = new DiscoveryEngine({
                        initialCapital, feeRate, taxRate,
                        strategy: { stocks, rebalanceType: config.rebalanceType, rebalancePeriod: config.rebalancePeriod, rebalanceThreshold: config.rebalanceThreshold },
                        dates: solver.dates, historyMap, benchmarkHistory, sp500History
                    });
                    res.preciseStats = engine.run();
                    // 정렬 기준(fitness)을 정밀 백테스트 결과로 갱신
                    res.fitness = res.preciseStats.totalReturn;

                    // PSO 스탯과 정밀 스탯의 필드명 싱크 (absReturn, romad 등)
                    res.preciseStats.absReturn = res.preciseStats.totalReturn;
                    res.preciseStats.romad = res.preciseStats.calmar;
                    res.preciseStats.sharpe = res.preciseStats.sharpe || 0;
                    res.preciseStats.sortino = res.preciseStats.sortino || 0;
                    res.preciseStats.infoRatio = res.preciseStats.infoRatio || 0;

                    res.stats.absReturn = res.preciseStats.totalReturn;
                    res.stats.mdd = res.preciseStats.mdd;
                    res.stats.romad = res.preciseStats.romad;
                    res.stats.fitness = res.fitness;

                    completedCount++;
                    if (btn) btn.textContent = `정밀 검증... ${completedCount}/${totalToVerify}`;
                } catch (e) {
                    console.error("Precise validation error:", e);
                    completedCount++;
                }
            });

            await Promise.all(preciseJobs);

            // 정밀 수익률 기준으로 최종 재정렬
            this.discoveredResults.sort((a, b) => (b.preciseStats?.totalReturn || 0) - (a.preciseStats?.totalReturn || 0));

            // 데이터 전처리: 정밀 정렬된 순서대로 순위 부여 및 상관관계 계산
            this.discoveredResults.forEach((res, idx) => {
                res.originalRank = idx + 1;
                res.avgCorr = this._calculateAvgCorrelation(res.genes, solver.pool, solver.stockCache);
            });

            this.currentSort = { key: 'fitness', desc: true };
            this.displayDiscoveryList(this.discoveredResults, config.metric, solver.pool, solver.config);
            showToast('종목 발굴 완료', 'success');
        } catch (err) {
            console.error(err);
            showToast(err.message, 'error');
        }
        finally {
            if (btn) {
                btn.disabled = false;
                btn.classList.remove('loading');
                btn.textContent = originalBtnText;
            }
        }
    },

    _calculateAvgCorrelation(genes, solverPool, stockCache) {
        if (!genes || genes.length < 2) return 0;
        let sum = 0;
        let count = 0;

        const calcCorr = (x, y) => {
            const n = Math.min(x.length, y.length);
            if (n === 0) return 0;
            let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
            for (let i = 0; i < n; i++) {
                sx += x[i]; sy += y[i];
                sxy += x[i] * y[i];
                sx2 += x[i] * x[i]; sy2 += y[i] * y[i];
            }
            const num = (n * sxy) - (sx * sy);
            const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
            return den === 0 ? 0 : num / den;
        };

        for (let i = 0; i < genes.length; i++) {
            for (let j = i + 1; j < genes.length; j++) {
                const s1 = solverPool[genes[i]];
                const s2 = solverPool[genes[j]];
                const d1 = stockCache[s1.code]?.dayReturns;
                const d2 = stockCache[s2.code]?.dayReturns;
                if (d1 && d2) {
                    sum += calcCorr(d1, d2);
                    count++;
                }
            }
        }
        return count > 0 ? sum / count : 0;
    },

    displayDiscoveryList(results, metricKey, solverPool, solverConfig) {
        document.getElementById('dsEmptyState').style.display = 'none';
        document.getElementById('dsResultState').style.display = 'flex';
        const logBody = document.getElementById('dsLogBody');
        logBody.innerHTML = '';
        const initialCapital = Number(document.getElementById('dsInitialCapital').value.replace(/,/g, ''));
        const feeRate = Number(document.getElementById('dsFeeRate').value) / 100;
        const taxRate = Number(document.getElementById('dsTaxRate').value) / 100;
        const config = this.getCurrentConfig();

        // 정렬 수행
        const sorted = [...results].sort((a, b) => {
            let valA, valB;
            switch (this.currentSort.key) {
                case 'rank': valA = a.originalRank; valB = b.originalRank; break;
                case 'corr': valA = a.avgCorr; valB = b.avgCorr; break;
                case 'return': valA = a.stats.absReturn; valB = b.stats.absReturn; break;
                case 'mdd': valA = a.stats.mdd; valB = b.stats.mdd; break;
                case 'sharpe': valA = a.stats.sharpe; valB = b.stats.sharpe; break;
                case 'romad': valA = a.stats.romad; valB = b.stats.romad; break;
                case 'sortino': valA = a.stats.sortino; valB = b.stats.sortino; break;
                case 'ir': valA = (a.preciseStats?.infoRatio || 0); valB = (b.preciseStats?.infoRatio || 0); break;
                default: return 0;
            }
            if (valA < valB) return this.currentSort.desc ? 1 : -1;
            if (valA > valB) return this.currentSort.desc ? -1 : 1;
            return 0;
        });

        sorted.forEach((res, sIdx) => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.className = 'ds-res-row';
            tr.id = `ds-row-${sIdx}`;

            const comboNamesHtml = res.genes.map(gIdx => {
                const s = solverPool[gIdx];
                return `<span class="ds-stock-ticker" data-gidx="${gIdx}" title="${s.ticker} 개별 분석">${s.name}</span>`;
            }).join('');

            // 이미 정밀검증이 완료된 데이터를 사용
            const s = res.preciseStats || res.stats;
            const pRet = (s.absReturn ?? s.totalReturn ?? 0) * 100;
            const pMdd = (s.mdd || 0) * 100;
            const pSharpe = s.sharpe || 0;
            const pRomad = s.romad ?? s.calmar ?? 0;
            const pSortino = s.sortino || 0;
            const pIR = s.infoRatio || 0;

            tr.innerHTML = `
                <td>${res.originalRank}</td>
                <td style="text-align:left;">${comboNamesHtml}</td>
                <td class="${pRet >= 0 ? 'up' : 'down'}" style="font-weight:600;">${fmtPct(pRet)}</td>
                <td style="font-size:11px; font-weight:500; color:var(--text-muted);">${res.avgCorr.toFixed(2)}</td>
                <td style="font-size:11px;">${pSharpe.toFixed(2)}</td>
                <td style="font-size:11px;">${pSortino.toFixed(2)}</td>
                <td style="font-size:11px;">${pIR.toFixed(2)}</td>
                <td class="res-td-mdd down">${fmtPct(pMdd)}</td>
                <td style="font-size:11px;">${pRomad.toFixed(2)}</td>
            `;

            // 행 클릭: 포트폴리오 전체 상세 분석
            tr.addEventListener('click', (e) => {
                document.querySelectorAll('.ds-res-row').forEach(r => r.classList.remove('active'));
                tr.classList.add('active');
                this.runDetailedBacktest(res, solverPool, solverConfig, res.originalRank);
            });

            // 개별 종목 티커 클릭: 해당 종목만 백테스트
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
        if (sorted.length > 0) {
            // 정렬된 리스트의 첫 번째 항목을 기본 분석 대상으로 설정
            const firstRes = sorted[0];
            const firstRow = document.getElementById('ds-row-0');
            if (firstRow) firstRow.classList.add('active');
            this.runDetailedBacktest(firstRes, solverPool, solverConfig, firstRes.originalRank);
        }
    },

    async runDetailedBacktest(res, solverPool, solverConfig, rank) {
        const cashWeight = solverConfig.cashWeight;
        const stockWeight = (100 - cashWeight) / res.genes.length;
        const stocks = res.genes.map(gIdx => {
            const s = solverPool[gIdx];
            return { code: s.code, name: s.name, ticker: s.ticker, weight: stockWeight };
        });
        stocks.unshift({ code: 'CASH', name: '현금', ticker: 'CASH', weight: cashWeight });
        this.selectedStocks = stocks;

        this.currentAnalysisTarget = `순위 ${rank} 포트폴리오 조합`;

        // [일관성 보장] Solver가 이미 구성한 historyMap 재사용
        const forceHistoryMap = {};
        res.genes.forEach(gIdx => {
            const s = solverPool[gIdx];
            forceHistoryMap[s.ticker] = this.discoveredSolver.dates.map(d => ({
                date: d,
                close: this.discoveredSolver.candleMaps[s.code].get(d)
            }));
        });
        forceHistoryMap['CASH'] = this.discoveredSolver.dates.map(d => ({ date: d, close: 1 }));

        const config = this.getCurrentConfig();
        await this.executeSimulationInternal(
            Number(config.initialCapital.replace(/,/g, '')),
            Number(config.feeRate) / 100,
            Number(config.taxRate) / 100,
            parseInt(config.periodMonths),
            stocks,
            config,
            false,
            forceHistoryMap,
            this.discoveredSolver.dates
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

        this.currentAnalysisTarget = `개별 종목 단독 분석: ${s.name} (${s.ticker})`;

        const forceHistoryMap = {};
        forceHistoryMap[s.ticker] = this.discoveredSolver.dates.map(d => ({
            date: d,
            close: this.discoveredSolver.candleMaps[s.code].get(d)
        }));
        forceHistoryMap['CASH'] = this.discoveredSolver.dates.map(d => ({ date: d, close: 1 }));

        const config = this.getCurrentConfig();
        await this.executeSimulationInternal(
            Number(config.initialCapital.replace(/,/g, '')),
            Number(config.feeRate) / 100,
            Number(config.taxRate) / 100,
            parseInt(config.periodMonths),
            stocks,
            config,
            false,
            forceHistoryMap,
            this.discoveredSolver.dates
        );
    },

    async executeSimulationInternal(initialCapital, feeRate, taxRate, periodMonths, stocks, config, showLoading = true, forceHistoryMap = null, forceDates = null) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth() - periodMonths, now.getDate());
        const startStr = start.toISOString().substring(0, 10);

        try {
            let historyMap = forceHistoryMap;
            let commonDates = forceDates;

            if (!historyMap || !commonDates) {
                const stocksToFetch = stocks.filter(s => s.code !== 'CASH');
                const candleCount = Math.ceil(periodMonths * 23) + 30;
                const batchData = await API.fetchBatch(stocksToFetch.map(s => ({ code: s.code, ticker: s.ticker })), candleCount, '1d');

                historyMap = {};
                batchData.forEach((res, i) => { if (res?.allCandles?.length > 0) historyMap[stocksToFetch[i].ticker] = res.allCandles; });

                const tickers = Object.keys(historyMap);
                commonDates = [];
                if (tickers.length > 0) {
                    commonDates = historyMap[tickers[0]].map(h => h.date);
                    tickers.forEach(t => {
                        const dates = new Set(historyMap[t].map(h => h.date));
                        commonDates = commonDates.filter(d => dates.has(d));
                    });
                    commonDates = commonDates.filter(d => d >= startStr).sort();
                }
                if (stocks.some(s => s.code === 'CASH')) historyMap['CASH'] = commonDates.map(d => ({ date: d, close: 1 }));
            }

            // 벤치마크는 캐싱 여부와 상관없이 필요하면 가져옴 (비동기)
            let bHistory = [], spHistory = [];
            try {
                const bmk = await API.fetchStock('^KS200', 300, '1d', 'KS'); bHistory = bmk.allCandles || [];
                const sp = await API.fetchStock('^GSPC', 300, '1d', 'US'); spHistory = sp.allCandles || [];
            } catch (e) { }

            const engine = new DiscoveryEngine({
                initialCapital, feeRate, taxRate,
                strategy: { stocks, rebalanceType: config.rebalanceType, rebalancePeriod: config.rebalancePeriod, rebalanceThreshold: config.rebalanceThreshold },
                dates: commonDates, historyMap, benchmarkHistory: bHistory, sp500History: spHistory
            });
            this.displayBacktestResults(engine.run());
        } catch (err) { console.error(err); showToast(err.message, 'error'); }
    },

    displayBacktestResults(result) {
        // 분석 대상 타이틀 표시
        const targetEl = document.getElementById('dsAnalysisTarget');
        if (targetEl) targetEl.textContent = this.currentAnalysisTarget || '--';

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

class DiscoveryEngine extends BaseBacktestEngine {
    constructor(params) {
        super(params);
    }
}


document.addEventListener('DOMContentLoaded', async () => {
    try { await Storage.init(); DiscoveryUI.init(); }
    catch (err) { console.error(err); showToast('초기화 실패', 'error'); }
});
