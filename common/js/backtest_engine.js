/**
 * BaseBacktestEngine.js
 * 백테스트 및 종목발굴에서 공통으로 사용하는 핵심 계산 엔진
 */

class BaseBacktestEngine {
    constructor({ initialCapital, feeRate, taxRate, strategy, dates, historyMap, benchmarkHistory, sp500History }) {
        this.initialCapital = initialCapital;
        this.feeRate = feeRate;
        this.taxRate = taxRate;
        this.strategy = strategy; // stocks, rebalanceType, rebalancePeriod, rebalanceThreshold
        this.dates = dates;
        this.historyMap = historyMap;
        this.benchmarkHistory = benchmarkHistory || [];
        this.sp500History = sp500History || [];

        // 빠른 조회를 위한 Map 변환
        this.historyDateMaps = {};
        for (const t in this.historyMap) {
            this.historyDateMaps[t] = new Map(this.historyMap[t].map(h => [h.date, h.close]));
        }
        this.benchmarkMap = new Map(this.benchmarkHistory.map(h => [h.date, h.close]));
        this.sp500Map = new Map(this.sp500History.map(h => [h.date, h.close]));

        // 초기화
        this.currentCash = initialCapital;
        this.totalCost = 0;
        this.holdings = {};
        this.strategy.stocks.forEach(s => {
            this.holdings[s.ticker] = {
                qty: 0,
                weight: s.weight / 100,
                currentPrice: 0,
                startPrice: 0
            };
        });

        this.results = {
            dates: [],
            dailyValues: [],
            dailyReturns: [],
            benchmarkReturns: [],
            logs: [],
            initialCapital,
        };

        this.lastRebalanceDate = null;
    }

    getPrice(ticker, date) {
        const m = this.historyDateMaps[ticker];
        return m ? (m.get(date) || 0) : 0;
    }

    /**
     * 달력 기준 주 시작일 계산 (오차 없는 리밸런싱을 위함)
     */
    getWeekStart(dateStr) {
        const d = new Date(dateStr);
        const day = d.getDay(); // 0(일) ~ 6(토)
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // 월요일 기준
        return new Date(d.setDate(diff)).toISOString().split('T')[0];
    }

    /**
     * 리밸런싱 실행 여부 판단 (달력 기준)
     */
    shouldRebalance(dateStr) {
        if (!this.lastRebalanceDate) {
            this.lastRebalanceDate = dateStr;
            return false;
        }

        const curr = new Date(dateStr);
        const prev = new Date(this.lastRebalanceDate);
        const type = this.strategy.rebalancePeriod;

        let triggered = false;
        if (type === '1wk') {
            triggered = this.getWeekStart(dateStr) !== this.getWeekStart(this.lastRebalanceDate);
        } else if (type === '2wk') {
            // 2주 주기는 단순 일수 계산 보다는 주 시작일 차이로 판단
            const d1 = new Date(this.getWeekStart(dateStr));
            const d2 = new Date(this.getWeekStart(this.lastRebalanceDate));
            triggered = (d1 - d2) / (1000 * 60 * 60 * 24) >= 14;
        } else if (type === '1mo') {
            triggered = (curr.getMonth() !== prev.getMonth()) || (curr.getFullYear() !== prev.getFullYear());
        } else if (type === '3mo') {
            const getQ = (d) => Math.floor(d.getMonth() / 3);
            triggered = (getQ(curr) !== getQ(prev)) || (curr.getFullYear() !== prev.getFullYear());
        } else if (type === '6mo') {
            const getH = (d) => Math.floor(d.getMonth() / 6);
            triggered = (getH(curr) !== getH(prev)) || (curr.getFullYear() !== prev.getFullYear());
        } else if (type === '1yr') {
            triggered = (curr.getFullYear() !== prev.getFullYear());
        }

        return triggered;
    }

    /**
     * 비중 편차 체크
     */
    checkDeviation(totalValue) {
        if (totalValue <= 0) return null;
        const threshold = (this.strategy.rebalanceThreshold || 5) / 100;

        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            const actualWeight = (h.qty * h.currentPrice) / totalValue;
            if (Math.abs(actualWeight - h.weight) > threshold) {
                return ticker; // 이탈한 종목 반환
            }
        }
        return null;
    }

    /**
     * 시뮬레이션 실행
     */
    run() {
        const start = this.dates[0];
        // 최초 매수
        this.rebalance(start, "최초 매수", true);

        // 벤치마크 기준가 고정 (TO-BE: 루프 밖으로 이동)
        const bStart = this.benchmarkMap.get(this.dates[0]) || 1;

        this.dates.forEach((date, i) => {
            const totalVal = this.calculateTotalValue(date);

            this.results.dates.push(date);
            this.results.dailyValues.push(totalVal);
            this.results.dailyReturns.push((totalVal / this.initialCapital) - 1);

            // 벤치마크 수익률 계산
            const bCurr = this.benchmarkMap.get(date) || bStart;
            this.results.benchmarkReturns.push((bCurr / bStart) - 1);

            // 리밸런싱 체크 (최초 매수일 중복 체크 방지)
            if (i > 0) {
                if (this.strategy.rebalanceType === 'period' && this.shouldRebalance(date)) {
                    this.rebalance(date, "정기 리밸런싱");
                } else if (this.strategy.rebalanceType === 'deviation') {
                    const triggerTicker = this.checkDeviation(totalVal);
                    if (triggerTicker) {
                        this.rebalance(date, "비중 이탈 리밸런싱", false, triggerTicker);
                    }
                }
            }
        });

        return this.calculateFinalStats();
    }

    calculateTotalValue(date) {
        let total = this.currentCash;
        for (const t in this.holdings) {
            if (t === 'CASH') continue; // 현금은 이미 base value에 포함됨 (중복 계산 방지)
            const p = this.getPrice(t, date);
            if (p > 0) this.holdings[t].currentPrice = p;
            total += this.holdings[t].qty * (this.holdings[t].currentPrice || 0);
        }
        return total;
    }

    rebalance(date, reason, isInitial = false, triggerTicker = null) {
        const currentTotal = this.calculateTotalValue(date);
        const targetTotal = currentTotal;
        let costThisTime = 0;

        const beforeVals = {};
        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            beforeVals[ticker] = h.qty * (h.currentPrice || 0);
        }

        // 1단계: 매도 (비중 초과 종목)
        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            if (ticker === 'CASH' || h.currentPrice <= 0) continue;

            const targetVal = targetTotal * h.weight;
            const targetQty = Math.floor(targetVal / h.currentPrice);
            const diff = targetQty - h.qty;

            if (diff < 0) { // 매도
                const sellQty = Math.abs(diff);
                const amt = sellQty * h.currentPrice;
                const fee = amt * this.feeRate;
                const tax = amt * this.taxRate;
                costThisTime += (fee + tax);
                h.qty -= sellQty;
                this.currentCash += (amt - fee - tax);
            }
        }

        // 2단계: 매수 (현금 내에서 비중 미달 종목)
        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            if (ticker === 'CASH' || h.currentPrice <= 0) continue;

            const targetVal = targetTotal * h.weight;
            const targetQty = Math.floor((targetVal / (1 + this.feeRate)) / h.currentPrice); // 수수료 고려한 수량
            const diff = targetQty - h.qty;

            if (diff > 0) { // 매수
                const buyQty = diff;
                const amt = buyQty * h.currentPrice;
                const fee = amt * this.feeRate;
                if (this.currentCash >= (amt + fee)) {
                    costThisTime += fee;
                    h.qty += buyQty;
                    this.currentCash -= (amt + fee);
                } else {
                    // 현금이 아슬아슬하게 부족한 경우 1주씩 줄여가며 매수 시도
                    let tempQty = buyQty - 1;
                    while (tempQty > 0) {
                        const tAmt = tempQty * h.currentPrice;
                        const tFee = tAmt * this.feeRate;
                        if (this.currentCash >= (tAmt + tFee)) {
                            costThisTime += tFee;
                            h.qty += tempQty;
                            this.currentCash -= (tAmt + tFee);
                            break;
                        }
                        tempQty--;
                    }
                }
            }
        }

        // 현금 비중 업데이트
        const cashH = this.holdings['CASH'];
        if (cashH) {
            cashH.qty = this.currentCash;
            cashH.currentPrice = 1;
        }

        if (isInitial) {
            for (const t in this.holdings) this.holdings[t].startPrice = this.holdings[t].currentPrice;
        }

        this.totalCost += costThisTime;
        this.lastRebalanceDate = date;

        const evals = {};
        let finalPortfolioValue = 0;
        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            const val = h.qty * (h.currentPrice || 0);
            finalPortfolioValue += val;
            evals[ticker] = {
                beforeVal: isInitial ? 0 : beforeVals[ticker],
                beforeWeight: isInitial ? 0 : (beforeVals[ticker] / currentTotal) * 100,
                afterVal: val,
                pnlPct: h.startPrice > 0 ? (h.currentPrice / h.startPrice) - 1 : 0
            };
        }
        for (const ticker in evals) {
            evals[ticker].afterWeight = (evals[ticker].afterVal / finalPortfolioValue) * 100;
        }

        const logType = isInitial ? '매수' : '리밸런싱';
        this.results.logs.push({
            date,
            type: logType,
            msg: `${reason} (비용: ${Math.round(costThisTime).toLocaleString()}원)`,
            cost: costThisTime,
            value: finalPortfolioValue,
            evals,
            pnlPct: (finalPortfolioValue / this.initialCapital) - 1,
            triggerTicker
        });
    }

    calculateFinalStats() {
        const res = this.results;
        const n = res.dailyValues.length;
        if (n < 2) return res;

        const firstVal = this.initialCapital;
        const lastVal = res.dailyValues[n - 1];
        res.totalReturn = (lastVal / firstVal) - 1;
        res.totalProfit = lastVal - firstVal;

        // CAGR 계산 (1년 미만 보정)
        const d1 = new Date(res.dates[0]);
        const d2 = new Date(res.dates[n - 1]);
        const diffMs = d2 - d1;
        const years = Math.max(diffMs / (1000 * 60 * 60 * 24 * 365.25), 1 / 252);
        res.cagr = Math.pow(lastVal / firstVal, 1 / years) - 1;

        // MDD
        let peak = 0;
        let mdd = 0;
        res.dailyValues.forEach(v => {
            if (v > peak) peak = v;
            const dd = (v / peak) - 1;
            if (dd < mdd) mdd = dd;
        });
        res.mdd = mdd;

        // 일별 수익률 기반 지표
        const dailyRets = [];
        for (let i = 1; i < n; i++) {
            dailyRets.push((res.dailyValues[i] / res.dailyValues[i - 1]) - 1);
        }

        const avg = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
        const std = Math.sqrt(dailyRets.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / (dailyRets.length - 1));
        res.sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

        const downSide = dailyRets.filter(r => r < 0);
        const downStd = Math.sqrt(downSide.reduce((a, b) => a + Math.pow(b, 2), 0) / (dailyRets.length - 1));
        res.sortino = downStd > 0 ? (avg / downStd) * Math.sqrt(252) : 0;

        res.calmar = Math.abs(mdd) > 0 ? res.cagr / Math.abs(mdd) : 0;

        // Info Ratio
        const excessRets = [];
        for (let i = 1; i < n; i++) {
            const pRet = (res.dailyValues[i] / res.dailyValues[i - 1]) - 1;
            const bValOld = this.benchmarkMap.get(res.dates[i - 1]) || 1;
            const bValNew = this.benchmarkMap.get(res.dates[i]) || bValOld;
            const bRet = (bValNew / bValOld) - 1;
            excessRets.push(pRet - bRet);
        }
        const avgEx = excessRets.reduce((a, b) => a + b, 0) / excessRets.length;
        const te = Math.sqrt(excessRets.reduce((a, b) => a + Math.pow(b - avgEx, 2), 0) / (excessRets.length - 1));
        res.infoRatio = te > 0 ? (avgEx / te) * Math.sqrt(252) : 0;

        // 최종 결과 로그 추가
        const lastDate = res.dates[n - 1];
        const finalEvals = {};
        for (const ticker in this.holdings) {
            const h = this.holdings[ticker];
            finalEvals[ticker] = {
                afterVal: h.qty * h.currentPrice,
                afterWeight: (h.qty * h.currentPrice / lastVal) * 100,
                pnlPct: h.startPrice > 0 ? (h.currentPrice / h.startPrice) - 1 : 0
            };
        }
        res.logs.push({
            date: lastDate,
            type: '최종 결과',
            msg: '',
            value: lastVal,
            evals: finalEvals,
            pnlPct: res.totalReturn
        });

        return res;
    }
}

// 브라우저 환경에서 전역 객체에 등록
if (typeof window !== 'undefined') {
    window.BaseBacktestEngine = BaseBacktestEngine;
}
