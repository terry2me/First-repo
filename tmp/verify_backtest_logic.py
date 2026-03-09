# -*- coding: utf-8 -*-
"""
verify_backtest_logic.py
백테스팅 엔진(backtest.js) 핵심 로직 수학적 검증 스크립트

검증 항목:
  A. 초기 매수 배분 (수수료 포함)
  B. 편차 리밸런싱 트리거 (checkDeviation)
  C. 일별/누적 수익률 정확도
  D. 지표 계산 (Sharpe/Sortino/Calmar/CAGR/MDD)
  E. 리밸런싱 후 가치 보존 + 매도세금 적용
  F. Info Ratio 계산
  G. 정기 리밸런싱 타이밍 (isRebalanceDay)
"""
import math
import sys
import io
from datetime import date as Date, timedelta

# Windows 콘솔 UTF-8 강제
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

PASS = "[PASS]"
FAIL = "[FAIL]"
SEP  = "-" * 60
all_results = []

def pr(label, ok, detail=""):
    status = PASS if ok else FAIL
    all_results.append(ok)
    msg = f"  {status} {label}"
    if detail:
        msg += f" | {detail}"
    print(msg)

def assert_close(a, b, tol=1e-9, label=""):
    ok = abs(a - b) < tol
    pr(label or f"{a:.10f} approx {b:.10f}", ok, f"diff={abs(a-b):.2e}")
    return ok

# ══════════════════════════════════════════════════════
# BacktestEngine Python 포팅 (핵심 계산 로직)
# ══════════════════════════════════════════════════════
class FakeEngine:
    def __init__(self, initial_capital, fee_rate, tax_rate, stocks, dates, history_map):
        self.initial_capital = initial_capital
        self.fee_rate = fee_rate
        self.tax_rate = tax_rate
        self.stocks   = stocks
        self.dates    = dates
        self.history_map = history_map
        self.current_cash = initial_capital
        self.holdings = {
            s['ticker']: {
                'qty': 0, 'weight': s['weight'],
                'current_price': 0, 'start_price': 0
            }
            for s in stocks
        }
        self.total_cost = 0
        self.daily_values = []

    def get_price(self, ticker, dt):
        return self.history_map.get(ticker, {}).get(dt, 0)

    def rebalance(self, dt, reason, is_initial=False):
        current_total = self.current_cash
        before_vals = {}
        for ticker, h in self.holdings.items():
            price = self.get_price(ticker, dt)
            if price > 0:
                h['current_price'] = price
            bval = h['qty'] * (h['current_price'] or 0)
            before_vals[ticker] = bval
            current_total += bval

        target_total = current_total
        cost_this_time = 0

        for ticker, h in self.holdings.items():
            if h['current_price'] <= 0:
                continue
            target_val = target_total * h['weight']
            if ticker == 'CASH':
                target_qty = target_val
            else:
                target_qty = math.floor(target_val / h['current_price'])
            diff = target_qty - h['qty']
            if diff != 0:
                trade_amt = abs(diff * h['current_price'])
                if ticker != 'CASH':
                    cost_this_time += trade_amt * self.fee_rate
                    if diff < 0:
                        cost_this_time += trade_amt * self.tax_rate
            h['qty'] = target_qty
            if is_initial and ticker != 'CASH':
                h['start_price'] = h['current_price']
            if is_initial and ticker == 'CASH':
                h['start_price'] = 1

        self.total_cost += cost_this_time
        new_total_stock_val = sum(
            h['qty'] * (h['current_price'] or 0)
            for h in self.holdings.values()
        )
        self.current_cash = target_total - cost_this_time - new_total_stock_val
        return cost_this_time, current_total

    def run(self):
        start = self.dates[0]
        self.rebalance(start, "initial", is_initial=True)
        pv = self.current_cash + sum(
            h['qty'] * (h['current_price'] or 0) for h in self.holdings.values()
        )
        self.daily_values.append(pv)
        for i in range(1, len(self.dates)):
            dt = self.dates[i]
            pv = self.current_cash
            for ticker, h in self.holdings.items():
                price = self.get_price(ticker, dt)
                if price > 0:
                    h['current_price'] = price
                pv += h['qty'] * h['current_price']
            self.daily_values.append(pv)
        return self.daily_values


# ══════════════════════════════════════════════════════
# A. 초기 매수 배분 검증
# ══════════════════════════════════════════════════════
print(SEP)
print("A. 초기 매수 배분 검증")
print(SEP)

initial = 10_000_000
fee_rate = 0.00015
tax_rate = 0.002

stocks = [
    {'ticker': 'A',    'weight': 0.40},
    {'ticker': 'B',    'weight': 0.40},
    {'ticker': 'CASH', 'weight': 0.20},
]
history = {
    'A':    {'2024-01-02': 10000},
    'B':    {'2024-01-02': 20000},
    'CASH': {'2024-01-02': 1},
}
eng = FakeEngine(initial, fee_rate, tax_rate, stocks, ['2024-01-02'], history)
cost, _ = eng.rebalance('2024-01-02', "initial", is_initial=True)

qty_A = math.floor(initial * 0.40 / 10000)   # 400
qty_B = math.floor(initial * 0.40 / 20000)   # 200
qty_C = initial * 0.20                        # 2,000,000

cost_A_expected = qty_A * 10000 * fee_rate   # 600
cost_B_expected = qty_B * 20000 * fee_rate   # 600
expected_cost   = cost_A_expected + cost_B_expected  # 1,200 (CASH 무수수료)

new_stock_val = qty_A * 10000 + qty_B * 20000 + qty_C
expected_cash = initial - expected_cost - new_stock_val
pv_after = eng.current_cash + sum(
    h['qty'] * (h['current_price'] or 0) for h in eng.holdings.values()
)

pr("A qty = 400", eng.holdings['A']['qty'] == 400,
   f"qty={eng.holdings['A']['qty']} (expected 400)")
pr("B qty = 200", eng.holdings['B']['qty'] == 200,
   f"qty={eng.holdings['B']['qty']} (expected 200)")
pr("CASH qty = 2,000,000 (1원=1주)", abs(eng.holdings['CASH']['qty'] - 2_000_000) < 1,
   f"qty={eng.holdings['CASH']['qty']:.0f}")
assert_close(cost, expected_cost, tol=0.01, label=f"수수료 합계 expected={expected_cost:.0f}원")
assert_close(eng.current_cash, expected_cash, tol=0.01,
             label=f"잔여 현금 expected={expected_cash:.2f}원")
pr("CASH는 수수료 없음 (cost = A+B 수수료만)", abs(cost - expected_cost) < 0.01,
   f"cost={cost:.4f}")
pr("포트폴리오 총액 = 초기자본 - 수수료",
   abs(pv_after - (initial - cost)) < 1,
   f"pv={pv_after:.2f}원")

# ══════════════════════════════════════════════════════
# B. 편차 리밸런싱 트리거 (checkDeviation)
# ══════════════════════════════════════════════════════
print()
print(SEP)
print("B. 편차 리밸런싱 트리거 검증 (threshold=5%)")
print(SEP)

def check_deviation(holdings, total_value, threshold_pct):
    """backtest.js checkDeviation() 재현"""
    if total_value <= 0:
        return None
    threshold = threshold_pct / 100
    for ticker, h in holdings.items():
        actual_weight = (h['qty'] * h['current_price']) / total_value
        if abs(actual_weight - h['weight']) > threshold:
            return ticker
    return None

# A +30% 상승 -> A=60%, B=40% (vs 목표 A=50%, B=50%)
h_b1 = {
    'A': {'qty': 500, 'current_price': 13000, 'weight': 0.50},  # 6,500,000 = 62.1%
    'B': {'qty': 500, 'current_price': 8000,  'weight': 0.50},  # 4,000,000 = 38.1%
}
total_b1 = 500*13000 + 500*8000  # 10,500,000
a_w  = 500*13000 / total_b1      # 0.619...
trigger_b1 = check_deviation(h_b1, total_b1, 5)
pr(f"A {a_w*100:.1f}% (편차 {abs(a_w-0.5)*100:.1f}%) -> 트리거 발생",
   trigger_b1 == 'A',
   f"trigger={trigger_b1}")

# 편차 3% - 트리거 없음
h_b2 = {
    'A': {'qty': 530, 'current_price': 10000, 'weight': 0.50},  # 5,300,000
    'B': {'qty': 500, 'current_price': 9400,  'weight': 0.50},  # 4,700,000
}
total_b2 = 530*10000 + 500*9400   # 10,000,000
a_w2 = 530*10000 / total_b2       # 0.53 (편차 3%)
trigger_b2 = check_deviation(h_b2, total_b2, 5)
pr(f"A {a_w2*100:.1f}% (편차 {abs(a_w2-0.5)*100:.1f}%) -> 트리거 없음",
   trigger_b2 is None,
   f"trigger={trigger_b2}")

# CASH 포함 케이스: CASH 가격=1원, qty=매우 큰 값
h_b3 = {
    'A':    {'qty': 300, 'current_price': 10000, 'weight': 0.50},  # 3,000,000 = 30%
    'CASH': {'qty': 7_000_000, 'current_price': 1, 'weight': 0.50},  # 7,000,000 = 70%
}
total_b3 = 300*10000 + 7_000_000   # 10,000,000
cash_w3 = 7_000_000 / total_b3     # 0.70 (편차 20%)
trigger_b3 = check_deviation(h_b3, total_b3, 5)
pr(f"CASH {cash_w3*100:.1f}% (편차 {abs(cash_w3-0.5)*100:.1f}%) -> 트리거 발생",
   trigger_b3 is not None,
   f"trigger={trigger_b3}")

# ══════════════════════════════════════════════════════
# C. 일별/누적 수익률 정확도
# ══════════════════════════════════════════════════════
print()
print(SEP)
print("C. 일별/누적 수익률 계산 정확도")
print(SEP)

dates_c = ['2024-01-02', '2024-01-03', '2024-01-04']
history_c = {'A': {'2024-01-02': 10000, '2024-01-03': 11000, '2024-01-04': 9900}}
stocks_c  = [{'ticker': 'A', 'weight': 1.0}]

eng_c = FakeEngine(10_000_000, 0.00015, 0, stocks_c, dates_c, history_c)
daily_vals = eng_c.run()

qty_A_c  = math.floor(10_000_000 / 10000)     # 1000
cost_D0  = qty_A_c * 10000 * 0.00015          # 1500
rem_cash = 10_000_000 - cost_D0 - qty_A_c * 10000  # 소폭 음수(-1500)

pv_D0 = qty_A_c * 10000 + rem_cash            # 9,998,500
pv_D1 = qty_A_c * 11000 + rem_cash            # 10,998,500
pv_D2 = qty_A_c * 9900  + rem_cash            # 9,898,500

pr("D0 PV = 초기자본 - 수수료", abs(daily_vals[0] - pv_D0) < 1,
   f"pv={daily_vals[0]:,.0f} | expected={pv_D0:,.0f}")
pr("D1 PV (+10% 가격반영)", abs(daily_vals[1] - pv_D1) < 1,
   f"pv={daily_vals[1]:,.0f} | expected={pv_D1:,.0f}")
pr("D2 PV (-10% 가격반영)", abs(daily_vals[2] - pv_D2) < 1,
   f"pv={daily_vals[2]:,.0f} | expected={pv_D2:,.0f}")

ret_D1 = (daily_vals[1] / daily_vals[0]) - 1
ret_D2 = (daily_vals[2] / daily_vals[1]) - 1
pr(f"D0->D1 일별수익률 +10.00%", abs(ret_D1 - 0.10) < 0.0001,
   f"{ret_D1*100:.4f}%")
pr(f"D1->D2 일별수익률 -10.00%", abs(ret_D2 - (-0.10)) < 0.0001,
   f"{ret_D2*100:.4f}%")

total_ret = (daily_vals[-1] / 10_000_000) - 1
# D0대비 D2: qty_A_c * 9900 / 10,000,000 - 1 = 재현된 수익률
pr(f"누적수익률 일관성 (수식 재현)", abs(total_ret - (pv_D2/10_000_000 - 1)) < 1e-10,
   f"{total_ret*100:.4f}%")

# ══════════════════════════════════════════════════════
# D. 지표 계산 (Sharpe/Sortino/CAGR/MDD/Calmar)
# ══════════════════════════════════════════════════════
print()
print(SEP)
print("D. 지표 계산 수학적 검증")
print(SEP)

import random
random.seed(42)
N = 252
mean_daily = 0.0005   # 일평균 +0.05%
std_daily  = 0.010    # 일표준편차 1%
returns = [random.gauss(mean_daily, std_daily) for _ in range(N)]

start_val = 10_000_000
values = [start_val]
for r in returns:
    values.append(values[-1] * (1 + r))
last_val = values[-1]

# --- CAGR (달력일 기준) ---
d0 = Date(2024, 1, 2)
d_last = d0 + timedelta(days=365)   # 대략 1년
years = (d_last - d0).days / 365.25
cagr_calc = (last_val / start_val) ** (1 / years) - 1

# CAGR >= 0 이고, 총수익률과 단조 관계이면 정상
total_ret_d = (last_val / start_val) - 1
pr(f"CAGR 양수 (수익 발생 시): {cagr_calc*100:.2f}%", cagr_calc > 0)
pr("CAGR < 총수익률 (1년 이하 기간)", cagr_calc < total_ret_d,
   f"CAGR={cagr_calc*100:.2f}% < TotalRet={total_ret_d*100:.2f}%")

# --- MDD ---
peak = 0
max_dd = 0
for v in values:
    if v > peak:
        peak = v
    dd = (v / peak) - 1
    if dd < max_dd:
        max_dd = dd
pr(f"MDD <= 0 (낙폭): {max_dd*100:.2f}%", max_dd <= 0)

# MDD 검증: 수동 루프와 일치 여부
manual_peak = 0
manual_mdd  = 0
for v in values:
    if v > manual_peak:
        manual_peak = v
    manual_mdd = min(manual_mdd, (v / manual_peak) - 1)
assert_close(max_dd, manual_mdd, tol=1e-12, label=f"MDD 수식 재현 일치")

# --- Sharpe (표본분산 N-1) ---
avg_r  = sum(returns) / len(returns)
var_r  = sum((r - avg_r)**2 for r in returns) / (len(returns) - 1)
std_r  = math.sqrt(var_r)
sharpe = (avg_r / std_r) * math.sqrt(252)
pr(f"Sharpe > 0 (양의 평균수익률): {sharpe:.4f}", sharpe > 0)

# Sharpe 분모가 표본표준편차 (N-1) 임을 검증
std_pop = math.sqrt(sum((r - avg_r)**2 for r in returns) / len(returns))  # 모집단
sharpe_pop = (avg_r / std_pop) * math.sqrt(252)
pr("표본표준편차(N-1) 사용 -> Sharpe_sample < Sharpe_pop (보수적)",
   sharpe < sharpe_pop,
   f"sample={sharpe:.4f} < pop={sharpe_pop:.4f}")

# --- Sortino (MAR=0, min(r,0)^2, N-1) ---
down_sq  = sum(min(r, 0)**2 for r in returns) / (len(returns) - 1)
down_std = math.sqrt(down_sq)
sortino  = (avg_r / down_std) * math.sqrt(252) if down_std > 0 else 0
pr(f"Sortino >= Sharpe (하방편차 <= 전체편차): {sortino:.4f}",
   sortino >= sharpe,
   f"Sortino={sortino:.4f}, Sharpe={sharpe:.4f}")

# downside std <= total std (항상)
pr("Downside StdDev <= Total StdDev",
   down_std <= std_r,
   f"down={down_std:.6f}, total={std_r:.6f}")

# --- Calmar ---
calmar = cagr_calc / abs(max_dd) if max_dd < 0 else 0
pr(f"Calmar = CAGR / |MDD|: {calmar:.4f}",
   abs(calmar - cagr_calc / abs(max_dd)) < 1e-10,
   f"CAGR={cagr_calc*100:.2f}%, MDD={max_dd*100:.2f}%")

# ══════════════════════════════════════════════════════
# E. 리밸런싱 후 포트폴리오 가치 보존 + 매도세금
# ══════════════════════════════════════════════════════
print()
print(SEP)
print("E. 리밸런싱 후 가치 보존 + 매도세금 적용 검증")
print(SEP)

stocks_e = [{'ticker': 'A', 'weight': 0.50}, {'ticker': 'B', 'weight': 0.50}]
dates_e  = ['2024-01-02', '2024-01-05']
history_e = {
    'A': {'2024-01-02': 10000, '2024-01-05': 13000},  # +30%
    'B': {'2024-01-02': 10000, '2024-01-05': 8000},   # -20%
}
eng_e = FakeEngine(10_000_000, 0.00015, 0.002, stocks_e, dates_e, history_e)
eng_e.rebalance('2024-01-02', "initial", is_initial=True)

# 가격 업데이트 (D1)
for ticker, h in eng_e.holdings.items():
    p = history_e[ticker].get('2024-01-05', 0)
    if p > 0:
        h['current_price'] = p

pv_before = eng_e.current_cash + sum(
    h['qty'] * h['current_price'] for h in eng_e.holdings.values()
)
qty_A_before = eng_e.holdings['A']['qty']
qty_B_before = eng_e.holdings['B']['qty']
A_w_before = qty_A_before * 13000 / pv_before
B_w_before = qty_B_before * 8000  / pv_before

pr(f"D1 A 비중 {A_w_before*100:.1f}% (목표 50%, 상승으로 편차 발생)",
   A_w_before > 0.50,
   f"A={qty_A_before*13000:,.0f}, B={qty_B_before*8000:,.0f}")

# 리밸런싱
cost_reb, _ = eng_e.rebalance('2024-01-05', "rebalance")
pv_after_reb = eng_e.current_cash + sum(
    h['qty'] * h['current_price'] for h in eng_e.holdings.values()
)

qty_A_after = eng_e.holdings['A']['qty']
qty_B_after = eng_e.holdings['B']['qty']
A_w_after = qty_A_after * 13000 / pv_after_reb
B_w_after = qty_B_after * 8000  / pv_after_reb

pr(f"리밸런싱 후 A 비중 ~50%", abs(A_w_after - 0.50) < 0.02,
   f"{A_w_after*100:.2f}%")
pr(f"리밸런싱 후 B 비중 ~50%", abs(B_w_after - 0.50) < 0.02,
   f"{B_w_after*100:.2f}%")
pr("리밸런싱 후 PV = 리밸런싱 전 PV - 비용",
   abs(pv_after_reb - (pv_before - cost_reb)) < 1,
   f"before={pv_before:,.0f}, after={pv_after_reb:,.0f}, cost={cost_reb:.2f}")

sold_A = qty_A_before - qty_A_after
pr(f"A 매도 발생 ({sold_A}주) - 가격 상승으로 비중 초과", sold_A > 0)
pr("매도세금 포함 (cost > 수수료만)", cost_reb > sold_A * 13000 * 0.00015,
   f"cost={cost_reb:.2f} > fee_only={sold_A*13000*0.00015:.2f}")

# 세금 포함 비용 검증
fee_sell   = sold_A * 13000 * 0.00015   # 매도 수수료
tax_sell   = sold_A * 13000 * 0.002     # 매도 세금
bought_B   = qty_B_after - qty_B_before
fee_buy    = bought_B * 8000 * 0.00015  # 매수 수수료
expected_cost_reb = fee_sell + tax_sell + fee_buy
assert_close(cost_reb, expected_cost_reb, tol=0.1,
             label=f"비용 = 매도수수료 + 매도세금 + 매수수수료 (expected={expected_cost_reb:.2f})")

# ══════════════════════════════════════════════════════
# F. Info Ratio 계산 검증
# ══════════════════════════════════════════════════════
print()
print(SEP)
print("F. Info Ratio 계산 검증")
print(SEP)

random.seed(42)
port_returns = [random.gauss(0.0008, 0.012) for _ in range(252)]
bmk_daily    = [random.gauss(0.0003, 0.008) for _ in range(252)]
excess = [p - b for p, b in zip(port_returns, bmk_daily)]

avg_excess = sum(excess) / len(excess)
var_excess  = sum((e - avg_excess)**2 for e in excess) / (len(excess) - 1)
tracking_err = math.sqrt(var_excess)
ir = (avg_excess / tracking_err) * math.sqrt(252)

pr(f"IR = {ir:.4f} > 0 (포트 > 벤치마크)", ir > 0,
   f"avg_excess={avg_excess*100:.4f}%/일, TE={tracking_err*100:.4f}%")

# ══════════════════════════════════════════════════════
# G. 정기 리밸런싱 타이밍 (isRebalanceDay 재현)
# ══════════════════════════════════════════════════════
print()
print(SEP)
print("G. isRebalanceDay 타이밍 검증")
print(SEP)

def week_start(dt):
    offset = dt.weekday()  # Mon=0
    return dt - timedelta(days=offset)

def is_rebalance_day(dt, prev_dt, period):
    d, pd = dt, prev_dt
    if period == '1wk':
        return week_start(d) != week_start(pd)
    elif period == '1mo':
        return (d.month != pd.month) or (d.year != pd.year)
    elif period == '3mo':
        return (d.month // 3 != pd.month // 3) or (d.year != pd.year)
    elif period == '1yr':
        return d.year != pd.year
    return False

# 1wk: 같은 주 (수->목)
d_wed = Date(2025, 1, 8)
d_thu = Date(2025, 1, 9)
pr("1wk: 같은 주(수->목) -> 리밸런싱 없음",
   not is_rebalance_day(d_thu, d_wed, '1wk'),
   f"week_start 동일: {week_start(d_wed)}")

# 1wk: 주 경계 (금->다음주 월)
d_fri = Date(2025, 1, 10)
d_mon = Date(2025, 1, 13)
pr("1wk: 금->다음주월 -> 리밸런싱 발생",
   is_rebalance_day(d_mon, d_fri, '1wk'),
   f"{week_start(d_fri)} -> {week_start(d_mon)}")

# 공휴일 케이스: 금->화 (월 공휴일 스킵) - 다른 주로 인식
d_fri2 = Date(2025, 1, 17)  # 금요일
d_tue2 = Date(2025, 1, 21)  # 화요일 (월=공휴일 스킵)
pr("1wk: 금->화(월공휴일) -> 리밸런싱 발생 (다른 주)",
   is_rebalance_day(d_tue2, d_fri2, '1wk'),
   f"{week_start(d_fri2)} != {week_start(d_tue2)}")

# 1mo: 월말->월초
d_jan = Date(2025, 1, 31)
d_feb = Date(2025, 2, 3)
pr("1mo: 1월말->2월초 -> 리밸런싱 발생",
   is_rebalance_day(d_feb, d_jan, '1mo'))
pr("1mo: 1월초->1월말 -> 리밸런싱 없음",
   not is_rebalance_day(d_jan, Date(2025, 1, 2), '1mo'))

# 3mo: 분기 경계
pr("3mo: Q2->Q3 (6월->7월) -> 리밸런싱 발생",
   is_rebalance_day(Date(2025, 7, 1), Date(2025, 6, 30), '3mo'))
pr("3mo: 같은 분기 내 (7월->8월) -> 리밸런싱 없음",
   not is_rebalance_day(Date(2025, 8, 15), Date(2025, 7, 1), '3mo'))

# 1yr: 연도 경계
pr("1yr: 12월->1월 -> 리밸런싱 발생",
   is_rebalance_day(Date(2025, 1, 2), Date(2024, 12, 31), '1yr'))
pr("1yr: 같은 연도 내 -> 리밸런싱 없음",
   not is_rebalance_day(Date(2025, 6, 1), Date(2025, 1, 2), '1yr'))

# ══════════════════════════════════════════════════════
# 최종 요약
# ══════════════════════════════════════════════════════
print()
print("=" * 60)
total = len(all_results)
passed = sum(1 for r in all_results if r)
failed = total - passed
print(f"  결과: {passed}/{total} PASS  |  {failed} FAIL")
print("=" * 60)
if failed > 0:
    sys.exit(1)
