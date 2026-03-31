const fs = require('fs');
const workerContent = fs.readFileSync('c:\\zTest\\Antigravity\\Project1\\Indexsimulation\\js\\sim_worker.js', 'utf8');
const appContent = fs.readFileSync('c:\\zTest\\Antigravity\\Project1\\Indexsimulation\\js\\sim_app.js', 'utf8');

// We will mock sim_worker environment
const window = {};

// We just need _runVectorizedSimulation
eval(workerContent.split('self.onmessage')[0] + workerContent.split('};')[1]); // extract functions before and after onmessage

// Get generateCombos and _packScenarios from sim_app.js
eval(appContent.match(/function\* generateCombos[\s\S]*?return packed;\n}/)[0]);

const combos = [...generateCombos()];
const n = combos.length;
const packed = _packScenarios();

// create mock candles
const T = 250;
const candles = [];
for (let i=0; i<T; i++) {
  candles.push({
    date: new Date(2025, 0, i+1).toISOString(),
    close: 10000 + Math.random()*2000 - 1000,
    bbMiddle: 10000,
    bbUpper: 11000,
    bbLower: 9000,
    rsiSignal: Math.random() < 0.1 ? 'BUY' : (Math.random() < 0.1 ? 'SELL' : null),
    macdCross: Math.random() < 0.1 ? 'BUY' : (Math.random() < 0.1 ? 'SELL' : null),
    mfiSignal: Math.random() < 0.1 ? 'BUY' : (Math.random() < 0.1 ? 'SELL' : null),
    stochSignal: Math.random() < 0.1 ? 'BUY' : (Math.random() < 0.1 ? 'SELL' : null),
    eomCross: Math.random() < 0.1 ? 'BUY' : (Math.random() < 0.1 ? 'SELL' : null),
  });
}

const data = { candlesWithBB: candles };
const simParams = {
  simPeriodMonths: 6,
  bbBuyPriceType: 'close',
  bbSellPriceType: 'close',
  pnlType: 'simple'
};

const res = _runVectorizedSimulation(data, packed, simParams);
console.log("Result:", res);
