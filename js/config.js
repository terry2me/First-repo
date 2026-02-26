/**
 * config.js — 외부 API 설정
 *
 * ── Google Sheets Finance API (US 종목 펀더멘털) ──────────────────
 * Google Apps Script 배포 URL
 * 제공 데이터: name, price, pe, eps, beta, yield
 *
 * 단일 호출: GET {GSHEET_FUND_API}?ticker=AAPL
 * 배치 호출: GET {GSHEET_FUND_API}?tickers=AAPL,MSFT,NVDA,...  (최대 50개)
 *
 * 배치 응답:
 *   { ok: true, results: [ { input, processed, data | error }, ... ] }
 * 단일 응답 (하위 호환):
 *   { ok: true, input, processed, data: { name, price, pe, eps, beta, yield } }
 *
 * 한국 종목(.KS/.KQ): 미지원 → null 반환
 * 제한: 없음 (Google 계정 할당량만 적용)
 *
 * ── Alpha Vantage (레거시, 미사용) ────────────────────────────────
 * 발급: https://www.alphavantage.co/support/#api-key (무료 가입)
 * 무료 플랜 제한: 25 req/day, 5 req/min
 */
const CONFIG = {
  // Google Sheets Finance API v2 — 배치 지원 (2025-02 업데이트)
  GSHEET_FUND_API: 'https://script.google.com/macros/s/AKfycbxpOXw12XpMyGsQvPRUzuYJ1IL0221W5U3k9pHOTGK72R4X3UGbvvnlrTLNkCTjUBmw8A/exec',

  // Alpha Vantage (레거시 — 현재 미사용)
  ALPHA_VANTAGE_KEY: '3TGFSQEBEFKSHJMD',
};
