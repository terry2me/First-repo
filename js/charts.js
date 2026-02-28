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
    upper:   '#f87171',   // 상단 밴드 (빨강)
    middle:  '#60a5fa',   // 중단 밴드 (파랑)
    lower:   '#4ade80',   // 하단 밴드 (초록)
    fill:    'rgba(96,165,250,0.08)',
    candleUp:   '#ef4444',
    candleDown: '#3b82f6',
    volume:  'rgba(156,163,175,0.4)',
    grid:    'rgba(255,255,255,0.06)',
    text:    '#94a3b8',
    bg:      '#1e293b',
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
  function renderMini(domId, data) {
    const dom = document.getElementById(domId);
    if (!dom) return;

    // 기존 인스턴스 dispose
    if (_instances[domId]) {
      _instances[domId].dispose();
    }
    const chart = echarts.init(dom, 'dark');
    _instances[domId] = chart;

    const { candlesWithBB } = data;
    const dates   = candlesWithBB.map(c => c.date);
    const candles = candlesWithBB.map(c => [c.open, c.close, c.low, c.high]);
    const upper   = candlesWithBB.map(c => c.bbUpper);
    const middle  = candlesWithBB.map(c => c.bbMiddle);
    const lower   = candlesWithBB.map(c => c.bbLower);

    const option = {
      ...baseOption(),
      axisPointer: { show: false },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: { show: true, color: COLOR.text, fontSize: 9,
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
        axisLabel: { color: COLOR.text, fontSize: 9,
          formatter: v => v >= 1000 ? (v/1000).toFixed(0)+'K' : v
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
            color:         COLOR.candleUp,
            color0:        COLOR.candleDown,
            borderColor:   COLOR.candleUp,
            borderColor0:  COLOR.candleDown,
          },
          z: 3,
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
    const upper  = candlesWithBB.map(c => c.bbUpper);
    const middle = candlesWithBB.map(c => c.bbMiddle);
    const lower  = candlesWithBB.map(c => c.bbLower);

    chart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      grid: { left: 0, right: 0, top: 2, bottom: 2 },
      xAxis: { type: 'category', show: false,
        data: candlesWithBB.map(c => c.date) },
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
          lineStyle: { color: '#f8fafc', width: 1.5 },
          symbol: 'none', connectNulls: true,
          itemStyle: { opacity: 0 },
        },
      ],
    });
  }

  /**
   * 모달 상세 차트 (캔들 + BB + 거래량)
   * @param {string} domId
   * @param {Object} data
   */
  function renderModal(domId, data) {
    const dom = document.getElementById(domId);
    if (!dom) return;

    if (_instances[domId]) _instances[domId].dispose();
    const chart = echarts.init(dom, 'dark');
    _instances[domId] = chart;

    const { candlesWithBB, name } = data;
    const dates   = candlesWithBB.map(c => c.date);
    const candles = candlesWithBB.map(c => [c.open, c.close, c.low, c.high]);
    const vols    = candlesWithBB.map(c => c.volume || 0);
    const upper   = candlesWithBB.map(c => c.bbUpper);
    const middle  = candlesWithBB.map(c => c.bbMiddle);
    const lower   = candlesWithBB.map(c => c.bbLower);

    // 거래량 색상 (상승:빨, 하락:파)
    const volColors = candlesWithBB.map(c =>
      c.close >= c.open ? COLOR.candleUp : COLOR.candleDown
    );

    chart.setOption({
      backgroundColor: '#0f172a',
      animation: false,
      title: {
        text: `${name} — 볼린저 밴드 + 캔들`,
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
        data: ['BB상단', 'BB중단', 'BB하단', '캔들'],
        textStyle: { color: COLOR.text, fontSize: 11 },
        top: 8, right: 16,
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      dataZoom: [
        { type: 'inside', xAxisIndex: [0,1], start: 0, end: 100 },
        { type: 'slider', xAxisIndex: [0,1], start: 0, end: 100,
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
          axisLabel: { color: COLOR.text, fontSize: 10,
            formatter: v => v >= 1000 ? (v/1000).toFixed(0)+'K' : v },
        },
        {
          type: 'value', scale: true, gridIndex: 1,
          splitLine: { show: false },
          axisLabel: { color: COLOR.text, fontSize: 9,
            formatter: v => v >= 1e6 ? (v/1e6).toFixed(0)+'M' : v >= 1000 ? (v/1000).toFixed(0)+'K' : v },
        },
      ],
      series: [
        {
          name: 'BB상단', type: 'line', data: upper, xAxisIndex: 0, yAxisIndex: 0,
          lineStyle: { color: COLOR.upper, width: 1.5, type: 'dashed' },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 },
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
            color:        COLOR.candleUp,   color0:       COLOR.candleDown,
            borderColor:  COLOR.candleUp,   borderColor0: COLOR.candleDown,
          },
        },
        {
          name: '거래량', type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1,
          itemStyle: { color: (params) => volColors[params.dataIndex] || COLOR.volume },
          barMaxWidth: 12,
        },
      ],
    });

    window.addEventListener('resize', () => chart.resize());
  }

  /* ─────────────────────────────────────────────────────────────
     EOM 서브차트
     구성: EOM 선(파랑) + Signal 선(오렌지) + 0선(점선) + 히스토그램 + 매매신호 마커
  ──────────────────────────────────────────────────────────── */
  /**
   * @param {string} domId
   * @param {Object} data  — indicators.analyzeAll() 결과 (candlesWithBB에 eom/eomSignal/eomCross 포함)
   */
  function renderEOM(domId, data) {
    const dom = document.getElementById(domId);
    if (!dom) return;
    if (_instances[domId]) _instances[domId].dispose();
    const chart = echarts.init(dom, 'dark');
    _instances[domId] = chart;

    const cands = data.candlesWithBB;
    const dates  = cands.map(c => c.date);
    const eomArr = cands.map(c => c.eom   !== null ? parseFloat(c.eom.toExponential   ? c.eom.toFixed(8)   : c.eom)   : null);
    const sigArr = cands.map(c => c.eomSignal !== null ? parseFloat(c.eomSignal.toFixed ? c.eomSignal.toFixed(8) : c.eomSignal) : null);

    // 히스토그램 색 (EOM > Signal → 파랑, 아래 → 빨강)
    const barData = eomArr.map((v, i) => {
      if (v === null) return { value: null, itemStyle: { color: 'transparent' } };
      const s = sigArr[i];
      const color = s === null
        ? (v >= 0 ? 'rgba(96,165,250,0.5)' : 'rgba(239,68,68,0.5)')
        : (v >= s ? 'rgba(96,165,250,0.5)' : 'rgba(239,68,68,0.5)');
      return { value: parseFloat(v.toFixed(8)), itemStyle: { color } };
    });

    // 매매신호 scatter
    const buyScatter  = cands.map((c, i) => c.eomCross === 'BUY'  ? [i, c.eom] : null).filter(Boolean);
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
        // 히스토그램 (EOM)
        {
          name: 'EOM히스토', type: 'bar', data: barData,
          barMaxWidth: 6, z: 1,
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { color: 'rgba(255,255,255,0.3)', type: 'dashed', width: 1 },
            data: [{ yAxis: 0, name: '기준선 0' }],
            label: { show: true, formatter: '0', color: 'rgba(255,255,255,0.4)', fontSize: 9 },
          },
        },
        // EOM 선
        {
          name: 'EOM', type: 'line', data: eomArr,
          lineStyle: { color: '#60a5fa', width: 1.5 },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 }, z: 2,
        },
        // Signal 선
        {
          name: 'Signal', type: 'line', data: sigArr,
          lineStyle: { color: '#fb923c', width: 1.5, type: 'dashed' },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 }, z: 2,
        },
        // BUY 신호
        {
          name: 'BUY신호', type: 'scatter', data: buyScatter,
          symbol: 'triangle', symbolSize: 10,
          itemStyle: { color: '#22c55e', borderColor: '#fff', borderWidth: 0.5 },
          label: { show: true, formatter: 'B', position: 'bottom', color: '#22c55e', fontSize: 8, fontWeight: 700 },
          z: 5,
        },
        // SELL 신호
        {
          name: 'SELL신호', type: 'scatter', data: sellScatter,
          symbol: 'triangle', symbolRotate: 180, symbolSize: 10,
          itemStyle: { color: '#ef4444', borderColor: '#fff', borderWidth: 0.5 },
          label: { show: true, formatter: 'S', position: 'top', color: '#ef4444', fontSize: 8, fontWeight: 700 },
          z: 5,
        },
      ],
    });
    window.addEventListener('resize', () => { try { chart.resize(); } catch {} });
  }

  /* ─────────────────────────────────────────────────────────────
     RSI + Stochastic 서브차트
     구성 (단일 패널):
       - RSI 선(보라)  + 기준선 20/80(빨간 점선)
       - Slow%K 선(노랑) + Slow%D 선(청록)
       - 과매도 영역(< 20) 배경 음영
       - 과매수 영역(> 80) 배경 음영
       - 매매신호 마커 (BUY▲ / SELL▼)
  ──────────────────────────────────────────────────────────── */
  /**
   * @param {string} domId
   * @param {Object} data  — analyzeAll() 결과
   */
  function renderRSIStoch(domId, data) {
    const dom = document.getElementById(domId);
    if (!dom) return;
    if (_instances[domId]) _instances[domId].dispose();
    const chart = echarts.init(dom, 'dark');
    _instances[domId] = chart;

    const cands  = data.candlesWithBB;
    const dates  = cands.map(c => c.date);
    const rsiArr = cands.map(c => c.rsi   !== null ? parseFloat(c.rsi.toFixed(2))   : null);
    const kArr   = cands.map(c => c.slowK !== null ? parseFloat(c.slowK.toFixed(2)) : null);
    const dArr   = cands.map(c => c.slowD !== null ? parseFloat(c.slowD.toFixed(2)) : null);

    // 매매신호 scatter (RSI 값 위치에 표시)
    const buyS  = cands.map((c, i) => c.rsiStSignal === 'BUY'  ? [i, c.rsi] : null).filter(Boolean);
    const sellS = cands.map((c, i) => c.rsiStSignal === 'SELL' ? [i, c.rsi] : null).filter(Boolean);

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
        // RSI 선
        {
          name: 'RSI', type: 'line', data: rsiArr,
          lineStyle: { color: '#a78bfa', width: 2 },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 }, z: 3,
          markLine: {
            silent: true, symbol: 'none',
            data: [
              { yAxis: 20, name: '과매도', lineStyle: { color: '#ef4444', type: 'dashed', width: 1 },
                label: { show: true, formatter: '20', position: 'insideEndBottom', color: '#ef4444', fontSize: 9 } },
              { yAxis: 80, name: '과매수', lineStyle: { color: '#f97316', type: 'dashed', width: 1 },
                label: { show: true, formatter: '80', position: 'insideEndTop', color: '#f97316', fontSize: 9 } },
              { yAxis: 50, name: '중간',  lineStyle: { color: 'rgba(255,255,255,0.2)', type: 'dashed', width: 1 },
                label: { show: false } },
            ],
          },
          markArea: {
            silent: true,
            data: [
              [ { yAxis: 0  }, { yAxis: 20 } ],   // 과매도 영역
              [ { yAxis: 80 }, { yAxis: 100 } ],   // 과매수 영역
            ],
            itemStyle: { color: 'rgba(239,68,68,0.07)' },
          },
        },
        // Slow %K
        {
          name: 'Slow%K', type: 'line', data: kArr,
          lineStyle: { color: '#fbbf24', width: 1.5 },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 }, z: 2,
        },
        // Slow %D
        {
          name: 'Slow%D', type: 'line', data: dArr,
          lineStyle: { color: '#34d399', width: 1.5, type: 'dashed' },
          symbol: 'none', connectNulls: false, itemStyle: { opacity: 0 }, z: 2,
        },
        // BUY 신호
        {
          name: 'BUY신호', type: 'scatter', data: buyS,
          symbol: 'triangle', symbolSize: 10,
          itemStyle: { color: '#22c55e', borderColor: '#fff', borderWidth: 0.5 },
          label: { show: true, formatter: 'B', position: 'bottom', color: '#22c55e', fontSize: 8, fontWeight: 700 },
          z: 5,
        },
        // SELL 신호
        {
          name: 'SELL신호', type: 'scatter', data: sellS,
          symbol: 'triangle', symbolRotate: 180, symbolSize: 10,
          itemStyle: { color: '#ef4444', borderColor: '#fff', borderWidth: 0.5 },
          label: { show: true, formatter: 'S', position: 'top', color: '#ef4444', fontSize: 8, fontWeight: 700 },
          z: 5,
        },
      ],
    });
    window.addEventListener('resize', () => { try { chart.resize(); } catch {} });
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
    Object.values(_instances).forEach(c => { try { c.resize(); } catch {} });
  }

  return { renderMini, renderSparkline, renderModal, renderEOM, renderRSIStoch, dispose, resizeAll };
})();
