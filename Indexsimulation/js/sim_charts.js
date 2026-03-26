/**
 * charts.js
 * ECharts 기반 차트 렌더링 모듈
 * - 미니 차트 (좌단 미리보기): 캔들 + 볼린저 밴드
 * - 리스트 인라인 스파크라인 (우단)
 * - 모달 상세 차트
 */

const Charts = (() => {

  // 차트 인스턴스 캐시
  const _instances = {};

  // 컬러 팔레트
  const COLOR = {
    upper: '#f87171',   // 상단 밴드 (빨강)
    middle: '#60a5fa',   // 중단 밴드 (파랑)
    lower: '#4ade80',   // 하단 밴드 (초록)
    fill: 'rgba(96,165,250,0.08)',
    candleUp: '#ef4444',
    candleDown: '#3b82f6',
    volume: 'rgba(156,163,175,0.4)',
    grid: 'rgba(148, 163, 184, 0.06)',
    text: '#94a3b8',
    bg: '#020617',
  };

  /** 공통 기본 옵션 (미니 차트용 — tooltip/axisPointer 없음) */
  function baseOption() {
    return {
      backgroundColor: 'transparent',
      animation: false,
      grid: [
        { left: 10, right: 10, top: 4, bottom: 20, containLabel: false }
      ],
      tooltip: { show: false },
    };
  }

  /**
   * 미니 차트 렌더링 (좌단 미리보기)
   * @param {string} domId  - 대상 DOM id
   * @param {Object} data   - indicators.analyze() 결과
   */
  function renderMini(domId, data, simResult, simPeriodMonths, highlightIndex = -1) {
    const dom = document.getElementById(domId);
    if (!dom) return;

    // 기존 인스턴스 dispose
    if (_instances[domId]) {
      _instances[domId].dispose();
    }
    const chart = echarts.init(dom, 'dark');
    _instances[domId] = chart;

    // 🚀 시뮬레이션 엔진과 동일한 lookback 로직 적용
    let candlesToDraw = data.candlesWithBB;
    if (simPeriodMonths) {
      const lookback = simPeriodMonths * 21;
      candlesToDraw = data.candlesWithBB.slice(-lookback);
    }
    const dates = candlesToDraw.map(c => c.date);
    const candles = candlesToDraw.map(c => [c.open, c.close, c.low, c.high]);
    const upper = candlesToDraw.map(c => c.bbUpper);
    const middle = candlesToDraw.map(c => c.bbMiddle);
    const lower = candlesToDraw.map(c => c.bbLower);

    // 시뮬레이션 매매 마커 준비
    const buyMarkers = [];
    const sellMarkers = [];
    if (simResult && simResult.trades) {
      simResult.trades.forEach((t, idx) => {
        const bIdx = dates.indexOf(t.buyDate);
        const isHighlighted = (idx === highlightIndex);

        if (bIdx !== -1) {
          buyMarkers.push({
            // 🚀 매수/매도 모두 캔들 최상단(high)에 배치하여 일봉 가림 방지
            value: [bIdx, candlesToDraw[bIdx].high],
            itemStyle: isHighlighted ? { color: COLOR.candleUp, borderColor: '#fff', borderWidth: 2.5 } : {},
            label: isHighlighted ? { color: '#fff', fontSize: 11 } : {},
            symbolSize: isHighlighted ? 28 : 20,
          });
        }

        if (!t.isOpen && t.exitDate) {
          const sIdx = dates.indexOf(t.exitDate);
          if (sIdx !== -1) {
            sellMarkers.push({
              // 🚀 매도는 캔들 상단(high)에 표시
              value: [sIdx, candlesToDraw[sIdx].high],
              itemStyle: isHighlighted ? { color: '#fff', borderColor: '#60a5fa', borderWidth: 2.5 } : {},
              label: isHighlighted ? { color: '#60a5fa', fontSize: 11 } : {},
              symbolSize: isHighlighted ? 28 : 20,
            });
          }
        }
      });
    }

    const option = {
      ...baseOption(),
      axisPointer: { show: false },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: {
          show: true, color: COLOR.text, fontSize: 9,
          formatter: v => v.slice(5) // MM-DD
        },
        axisLine: { lineStyle: { color: '#334155' } },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        scale: true,
        splitLine: { lineStyle: { color: COLOR.grid } },
        axisLabel: {
          color: COLOR.text, fontSize: 9,
          formatter: v => v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v
        },
      },
      series: [
        // 볼린저 밴드 상단
        {
          name: 'BB상단', type: 'line', data: upper,
          lineStyle: { color: COLOR.upper, width: 1, type: 'dashed' },
          itemStyle: { opacity: 0 }, symbol: 'none', connectNulls: false,
          z: 1,
        },
        // 볼린저 밴드 하단 (areaStyle로 상단~하단 채움)
        {
          name: 'BB하단', type: 'line', data: lower,
          lineStyle: { color: COLOR.lower, width: 1, type: 'dashed' },
          itemStyle: { opacity: 0 }, symbol: 'none', connectNulls: false,
          areaStyle: { color: COLOR.fill, origin: 'auto' },
          z: 1,
        },
        // 볼린저 중단
        {
          name: 'BB중단', type: 'line', data: middle,
          lineStyle: { color: COLOR.middle, width: 1.5 },
          itemStyle: { opacity: 0 }, symbol: 'none', connectNulls: false,
          z: 2,
        },
        // 캔들 일봉
        {
          name: '캔들', type: 'candlestick', data: candles,
          itemStyle: {
            color: COLOR.candleUp,
            color0: COLOR.candleDown,
            borderColor: COLOR.candleUp,
            borderColor0: COLOR.candleDown,
          },
          z: 3,
        },
        // 시뮬레이션 매수 마커 (In)
        {
          name: 'SIM_IN', type: 'scatter', data: buyMarkers,
          symbol: 'pin', symbolSize: 20,
          symbolOffset: [0, '-10%'], // 🚀 살짝 위로 띄워서 캔들과 겹침 방지
          itemStyle: { color: '#fff', borderColor: COLOR.candleUp, borderWidth: 1.5 },
          label: {
            show: true, formatter: 'In', position: 'inside',
            color: COLOR.candleUp, fontSize: 9, fontWeight: 'bold',
            offset: [0, 2]
          },
          z: 100,
        },
        // 시뮬레이션 매도 마커 (Out)
        {
          name: 'SIM_OUT', type: 'scatter', data: sellMarkers,
          symbol: 'pin', symbolSize: 20, 
          symbolOffset: [0, '-10%'], // 🚀 살짝 위로 띄워서 캔들과 겹침 방지
          itemStyle: { color: '#60a5fa', borderColor: '#fff', borderWidth: 1.5 },
          label: {
            show: true, formatter: 'Out', position: 'inside',
            color: '#fff', fontSize: 9, fontWeight: 'bold',
            offset: [0, 2]
          },
          z: 100,
        },
      ],
    };

    chart.setOption(option);
    window.addEventListener('resize', () => chart.resize());
  }

  /**
   * 우단 리스트 인라인 스파크라인 (초소형)
   * @param {string} domId
   * @param {Object} data  - indicators.analyze() 결과
   */
  function renderSparkline(domId, data) {
    const dom = document.getElementById(domId);
    if (!dom) return;

    if (_instances[domId]) _instances[domId].dispose();
    const chart = echarts.init(dom);
    _instances[domId] = chart;

    const { candlesWithBB } = data;
    const closes = candlesWithBB.map(c => c.close);
    const upper = candlesWithBB.map(c => c.bbUpper);
    const middle = candlesWithBB.map(c => c.bbMiddle);
    const lower = candlesWithBB.map(c => c.bbLower);

    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { left: 0, right: 0, top: 2, bottom: 2 },
      xAxis: {
        type: 'category', show: false,
        data: candlesWithBB.map(c => c.date)
      },
      yAxis: { type: 'value', scale: true, show: false },
      series: [
        {
          name: 'BB상단', type: 'line', data: upper,
          lineStyle: { color: COLOR.upper, width: 1 },
          symbol: 'none', connectNulls: false,
          itemStyle: { opacity: 0 },
        },
        {
          name: 'BB하단', type: 'line', data: lower,
          lineStyle: { color: COLOR.lower, width: 1 },
          symbol: 'none', connectNulls: false,
          itemStyle: { opacity: 0 },
          areaStyle: { color: 'rgba(96,165,250,0.07)', origin: 'auto' },
        },
        {
          name: 'BB중단', type: 'line', data: middle,
          lineStyle: { color: COLOR.middle, width: 1 },
          symbol: 'none', connectNulls: false,
          itemStyle: { opacity: 0 },
        },
        {
          name: '종가', type: 'line', data: closes,
          lineStyle: { color: '#cbd5e1', width: 1.5 },
          symbol: 'none', connectNulls: true,
          itemStyle: { opacity: 0 },
        },
      ],
    });
  }

  /**
   * 모달 상세 차트 (캔들 + BB + 거래량 + 시뮬레이션 마커)
   * @param {string} domId
   * @param {Object} data
   * @param {Object} simResult
   * @param {number} simPeriodMonths
   */
  function renderModal(domId, data, simResult, simPeriodMonths) {
    const dom = document.getElementById(domId);
    if (!dom) return;

    if (_instances[domId]) _instances[domId].dispose();
    const chart = echarts.init(dom, 'dark');
    _instances[domId] = chart;

    const { candlesWithBB, name } = data;
    const dates = candlesWithBB.map(c => c.date);
    const candles = candlesWithBB.map(c => [c.open, c.close, c.low, c.high]);
    const vols = candlesWithBB.map(c => c.volume || 0);
    const upper = candlesWithBB.map(c => c.bbUpper);
    const middle = candlesWithBB.map(c => c.bbMiddle);
    const lower = candlesWithBB.map(c => c.bbLower);

    // 시뮬레이션 마커 준비
    const buyMarkers = [];
    const sellMarkers = [];
    if (simResult && simResult.trades) {
      simResult.trades.forEach(t => {
        const bIdx = dates.indexOf(t.buyDate);
        if (bIdx !== -1) {
          buyMarkers.push([bIdx, candlesWithBB[bIdx].high]);
        }
        if (!t.isOpen && t.exitDate) {
          const sIdx = dates.indexOf(t.exitDate);
          if (sIdx !== -1) {
            sellMarkers.push([sIdx, candlesWithBB[sIdx].high]);
          }
        }
      });
    }

    // 시뮬레이션 영역 (배경 음영)
    const markArea = { silent: true, data: [] };
    if (simPeriodMonths) {
      const lookback = simPeriodMonths * 21;
      const startIdx = Math.max(0, dates.length - lookback - 6);
      if (startIdx < dates.length) {
        markArea.data = [[{ xAxis: dates[startIdx] }, { xAxis: dates[dates.length - 1] }]];
        markArea.itemStyle = { color: 'rgba(59, 130, 246, 0.04)' };
      }
    }

    // 거래량 색상
    const volColors = candlesWithBB.map(c =>
      c.close >= c.open ? COLOR.candleUp : COLOR.candleDown
    );

    chart.setOption({
      backgroundColor: '#0f172a',
      animation: false,
      title: {
        text: `${name} — 분석 결과 상세`,
        textStyle: { color: '#e2e8f0', fontSize: 14, fontWeight: 600 },
        left: 16, top: 8,
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: '#1e293b',
        borderColor: '#475569',
        textStyle: { color: '#e2e8f0', fontSize: 11 },
      },
      legend: {
        data: ['BB상단', 'BB중단', 'BB하단', '캔들', 'SIM_IN', 'SIM_OUT'],
        textStyle: { color: COLOR.text, fontSize: 11 },
        top: 8, right: 16,
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
        {
          type: 'slider', xAxisIndex: [0, 1], start: 0, end: 100,
          bottom: 4, height: 18,
          textStyle: { color: COLOR.text, fontSize: 9 },
          borderColor: '#334155', fillerColor: 'rgba(96,165,250,0.15)',
        },
      ],
      grid: [
        { left: 60, right: 16, top: 48, height: '62%' },
        { left: 60, right: 16, top: '76%', height: '14%' },
      ],
      xAxis: [
        {
          type: 'category', data: dates, gridIndex: 0,
          axisLabel: { color: COLOR.text, fontSize: 10, formatter: v => v.slice(5) },
          axisLine: { lineStyle: { color: '#334155' } },
          splitLine: { show: false },
        },
        {
          type: 'category', data: dates, gridIndex: 1,
          axisLabel: { show: false },
          axisLine: { lineStyle: { color: '#334155' } },
          splitLine: { show: false },
        },
      ],
      yAxis: [
        {
          type: 'value', scale: true, gridIndex: 0,
          splitLine: { lineStyle: { color: COLOR.grid } },
          axisLabel: {
            color: COLOR.text, fontSize: 10,
            formatter: v => v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v
          },
        },
        {
          type: 'value', scale: true, gridIndex: 1,
          splitLine: { show: false },
          axisLabel: {
            color: COLOR.text, fontSize: 9,
            formatter: v => v >= 1e6 ? (v / 1e6).toFixed(0) + 'M' : v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v
          },
        },
      ],
      series: [
        {
          name: 'BB상단', type: 'line', data: upper, xAxisIndex: 0, yAxisIndex: 0,
          lineStyle: { color: COLOR.upper, width: 1.5, type: 'dashed' },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 },
          markArea: markArea,
        },
        {
          name: 'BB하단', type: 'line', data: lower, xAxisIndex: 0, yAxisIndex: 0,
          lineStyle: { color: COLOR.lower, width: 1.5, type: 'dashed' },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 },
          areaStyle: { color: COLOR.fill },
        },
        {
          name: 'BB중단', type: 'line', data: middle, xAxisIndex: 0, yAxisIndex: 0,
          lineStyle: { color: COLOR.middle, width: 2 },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 },
        },
        {
          name: '캔들', type: 'candlestick', data: candles, xAxisIndex: 0, yAxisIndex: 0,
          itemStyle: {
            color: COLOR.candleUp, color0: COLOR.candleDown,
            borderColor: COLOR.candleUp, borderColor0: COLOR.candleDown,
          },
        },
        {
          name: '거래량', type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1,
          itemStyle: { color: (params) => volColors[params.dataIndex] || COLOR.volume },
          barMaxWidth: 12,
        },
        // 시뮬레이션 매수 마커 (In)
        {
          name: 'SIM_IN', type: 'scatter', data: buyMarkers, xAxisIndex: 0, yAxisIndex: 0,
          symbol: 'pin', symbolSize: 20,
          symbolOffset: [0, '-10%'], // 🚀 띄우기
          itemStyle: { color: '#fff', borderColor: COLOR.candleUp, borderWidth: 2 },
          label: {
            show: true, formatter: 'In', position: 'inside',
            color: COLOR.candleUp, fontSize: 10, fontWeight: 'bold'
          },
          z: 100,
        },
        // 시뮬레이션 매도 마커 (Out)
        {
          name: 'SIM_OUT', type: 'scatter', data: sellMarkers, xAxisIndex: 0, yAxisIndex: 0,
          symbol: 'pin', symbolSize: 20,
          symbolOffset: [0, '-10%'], // 🚀 띄우기
          itemStyle: { color: '#60a5fa', borderColor: '#fff', borderWidth: 2 },
          label: {
            show: true, formatter: 'Out', position: 'inside',
            color: '#fff', fontSize: 10, fontWeight: 'bold'
          },
          z: 100,
        },
      ],
    });

    window.addEventListener('resize', () => chart.resize());
  }

  /**
   * EOM 서브차트
   * 구성: EOM 선(파랑) + Signal 선(오렌지) + 0선(점선) + 히스토그램 + 매매신호 마커
   */
  function renderEOM(domId, data, simResult, simPeriodMonths) {
    const dom = document.getElementById(domId);
    if (!dom) return;
    if (_instances[domId]) _instances[domId].dispose();
    const chart = echarts.init(dom, 'dark');
    _instances[domId] = chart;

    // 기간만큼 데이터 슬라이싱
    let cands = data.candlesWithBB;
    if (simPeriodMonths) {
      const lookback = simPeriodMonths * 21;
      cands = data.candlesWithBB.slice(-lookback);
    }

    const dates = cands.map(c => c.date);
    const eomArr = cands.map(c => c.eom !== null ? parseFloat(c.eom.toExponential ? c.eom.toFixed(8) : c.eom) : null);
    const sigArr = cands.map(c => c.eomSignal !== null ? parseFloat(c.eomSignal.toFixed ? c.eomSignal.toFixed(8) : c.eomSignal) : null);

    // 🚀 지표 차트는 시뮬레이션 결과와 관계없이 항상 "순수 지표 신호"만 표시
    const buyScatter = cands.map((c, i) => c.eomCross === 'BUY' ? [i, c.eom] : null).filter(Boolean);
    const sellScatter = cands.map((c, i) => c.eomCross === 'SELL' ? [i, c.eom] : null).filter(Boolean);

    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: [{ left: 10, right: 10, top: 4, bottom: 4, containLabel: false }],
      tooltip: { show: false },
      axisPointer: { show: false },
      xAxis: {
        type: 'category', data: dates,
        show: false,
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', scale: true,
        axisLabel: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      series: [
        {
          name: 'EOM히스토', type: 'bar',
          data: eomArr.map((v, i) => {
            if (v === null) return { value: null, itemStyle: { color: 'transparent' } };
            const s = sigArr[i];
            const color = s === null ? (v >= 0 ? 'rgba(96,165,250,0.5)' : 'rgba(239,68,68,0.5)') : (v >= s ? 'rgba(96,165,250,0.5)' : 'rgba(239,68,68,0.5)');
            return { value: parseFloat(v.toFixed(8)), itemStyle: { color } };
          }),
          barMaxWidth: 6, z: 1,
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { color: 'rgba(255,255,255,0.3)', type: 'dashed', width: 1 },
            data: [{ yAxis: 0, name: '기준선 0' }],
            label: { show: true, formatter: '0', color: 'rgba(255,255,255,0.4)', fontSize: 9 },
          },
        },
        {
          name: 'EOM', type: 'line', data: eomArr,
          lineStyle: { color: '#60a5fa', width: 1.5 },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 }, z: 2,
        },
        {
          name: 'Signal', type: 'line', data: sigArr,
          lineStyle: { color: '#fb923c', width: 1.5, type: 'dashed' },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 }, z: 2,
        },
        {
          name: 'BUY신호', type: 'scatter', data: buyScatter,
          symbol: 'triangle', symbolSize: 10,
          itemStyle: { color: COLOR.candleUp, borderColor: '#cbd5e1', borderWidth: 0.5 },
          label: { show: true, formatter: 'B', position: 'bottom', color: COLOR.candleUp, fontSize: 8, fontWeight: 700 },
          z: 5,
        },
        {
          name: 'SELL신호', type: 'scatter', data: sellScatter,
          symbol: 'triangle', symbolRotate: 180, symbolSize: 10,
          itemStyle: { color: COLOR.candleDown, borderColor: '#cbd5e1', borderWidth: 0.5 },
          label: { show: true, formatter: 'S', position: 'top', color: COLOR.candleDown, fontSize: 8, fontWeight: 700 },
          z: 5,
        },
      ],
    });
    window.addEventListener('resize', () => { try { chart.resize(); } catch { } });
  }

  /**
   * RSI + Stochastic 서브차트
   */
  function renderRSIStoch(domId, data, simResult, simPeriodMonths, rsiOB = 70, rsiOS = 30, stochOB = 80, stochOS = 20) {
    const dom = document.getElementById(domId);
    if (!dom) return;
    if (_instances[domId]) _instances[domId].dispose();
    const chart = echarts.init(dom, 'dark');
    _instances[domId] = chart;

    // 기간만큼 데이터 슬라이싱
    let cands = data.candlesWithBB;
    if (simPeriodMonths) {
      const lookback = simPeriodMonths * 21;
      cands = data.candlesWithBB.slice(-lookback);
    }

    const dates = cands.map(c => c.date);
    const rsiArr = cands.map(c => c.rsi !== null ? parseFloat(c.rsi.toFixed(2)) : null);
    const kArr = cands.map(c => c.slowK !== null ? parseFloat(c.slowK.toFixed(2)) : null);
    const dArr = cands.map(c => c.slowD !== null ? parseFloat(c.slowD.toFixed(2)) : null);

    // 🚀 지표 차트는 시뮬레이션 결과와 관계없이 항상 "순수 지표 신호"만 표시 
    // RSI와 Stochastic 신호가 분리되었으므로, 둘 중 하나라도 있으면 표시 (우선순위: RSI > Stoch)
    const buyS = cands.map((c, i) => {
      if (c.rsiSignal === 'BUY' || c.stochSignal === 'BUY') return [i, rsiArr[i]];
      return null;
    }).filter(Boolean);
    const sellS = cands.map((c, i) => {
      if (c.rsiSignal === 'SELL' || c.stochSignal === 'SELL') return [i, rsiArr[i]];
      return null;
    }).filter(Boolean);

    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: [{ left: 10, right: 10, top: 4, bottom: 4, containLabel: false }],
      tooltip: { show: false },
      axisPointer: { show: false },
      xAxis: {
        type: 'category', data: dates,
        show: false,
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', min: 0, max: 100,
        interval: 20,
        axisLabel: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
      },
      series: [
        {
          name: 'RSI', type: 'line', data: rsiArr,
          lineStyle: { color: '#a78bfa', width: 2 },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 }, z: 3,
          markArea: {
            silent: true,
            data: [
              [{ yAxis: 0 }, { yAxis: rsiOS }],
              [{ yAxis: rsiOB }, { yAxis: 100 }],
            ],
            itemStyle: { color: 'rgba(239,68,68,0.07)' },
          },
          markLine: {
            silent: true, symbol: 'none',
            data: [
              { yAxis: rsiOS, name: 'RSI과매도', lineStyle: { color: '#ef4444', type: 'dashed', width: 1 }, label: { show: true, formatter: 'R:' + String(rsiOS), position: 'insideEndBottom', color: '#ef4444', fontSize: 9 } },
              { yAxis: rsiOB, name: 'RSI과매수', lineStyle: { color: '#f97316', type: 'dashed', width: 1 }, label: { show: true, formatter: 'R:' + String(rsiOB), position: 'insideEndTop', color: '#f97316', fontSize: 9 } },
              { yAxis: stochOS, name: 'ST과매도', lineStyle: { color: '#fbbf24', type: 'dotted', width: 1 }, label: { show: true, formatter: 'ST:' + String(stochOS), position: 'insideEndBottom', color: '#fbbf24', fontSize: 9 } },
              { yAxis: stochOB, name: 'ST과매수', lineStyle: { color: '#fbbf24', type: 'dotted', width: 1 }, label: { show: true, formatter: 'ST:' + String(stochOB), position: 'insideEndTop', color: '#fbbf24', fontSize: 9 } },
            ],
          },
        },
        {
          name: 'Slow%K', type: 'line', data: kArr,
          lineStyle: { color: '#fbbf24', width: 1.5 },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 }, z: 2,
        },
        {
          name: 'Slow%D', type: 'line', data: dArr,
          lineStyle: { color: '#34d399', width: 1.5, type: 'dashed' },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 }, z: 2,
        },
        {
          name: 'BUY신호', type: 'scatter', data: buyS,
          symbol: 'triangle', symbolSize: 10,
          itemStyle: { color: COLOR.candleUp, borderColor: '#cbd5e1', borderWidth: 0.5 },
          label: { 
            show: true, formatter: 'B', position: 'bottom', 
            color: COLOR.candleUp, fontSize: 8, fontWeight: 700,
            offset: [0, 2] // 🚀 매수는 지표선 아래로 살짝 내림
          },
          z: 5,
        },
        {
          name: 'SELL신호', type: 'scatter', data: sellS,
          symbol: 'triangle', symbolRotate: 180, symbolSize: 10,
          itemStyle: { color: COLOR.candleDown, borderColor: '#cbd5e1', borderWidth: 0.5 },
          label: { 
            show: true, formatter: 'S', position: 'top', 
            color: COLOR.candleDown, fontSize: 8, fontWeight: 700,
            offset: [0, -2] // 🚀 매도는 지표선 위로 살짝 올림
          },
          z: 5,
        },
      ],
    });
    window.addEventListener('resize', () => { try { chart.resize(); } catch { } });
  }

  /** 차트 인스턴스 dispose */
  function dispose(domId) {
    if (_instances[domId]) {
      _instances[domId].dispose();
      delete _instances[domId];
    }
  }

  /** 전체 resize (레이아웃 변경 시) */
  function resizeAll() {
    Object.values(_instances).forEach(c => { try { c.resize(); } catch { } });
  }

  return { renderMini, renderSparkline, renderModal, renderEOM, renderRSIStoch, dispose, resizeAll };
})();
