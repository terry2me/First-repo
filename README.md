# 📈 볼린저 밴드 주식 모니터

Yahoo Finance API 기반 실시간 볼린저 밴드 모니터링 앱.  
모든 기기(PC · 태블릿 · 스마트폰) 공유 데이터, 탭 그룹 관리, 기술지표 시각화.

---

## ✅ 완성된 기능

| 기능 | 설명 |
|------|------|
| 종목 검색 | 한국(6자리 코드) / 미국(영문 티커) 검색 |
| 볼린저 밴드 분석 | BB 위치 바·미니 차트·상세 모달 |
| EOM 서브차트 | Ease of Movement + Signal 매수/매도 신호 |
| RSI + Stochastic | RSI14 + SlowK/D 복합 신호 |
| 탭 그룹 관리 | 추가·삭제·이름변경·드래그 정렬 |
| 종목 드래그 정렬 | 우측 리스트 행 드래그 재정렬 |
| 일봉/주봉 토글 | 헤더에서 전환, 즉시 재조회 |
| 캔들 수 선택 | 10/20/30/40/50 버튼 |
| 컬럼 리사이저 | 마우스로 컬럼 너비 조정 |
| 체크박스 + 삭제 | 선택 일괄 삭제 |
| Toast 알림 | 등록·삭제·새로고침 완료 등 |
| 전체 새로고침 | 헤더 새로고침 버튼 |
| 다기기 공유 | 서버 Table API → PC/태블릿/폰 동일 데이터 |
| **한국 종목 한국어 표시** | 네이버 금융에서 한국어 종목명 비동기 조회 (양쪽 패널) |

---

## 🔧 최근 수정 내역 (2026-02-21)

### api.js
- **cors.sh 제거** → genspark.ai 도메인 차단 확인, codetabs fallback으로 교체
- **배치 처리 도입** `fetchMultiple`: 동시 요청 3개로 제한 → 느린 폰에서 타임아웃 방지
- **한국어 이름 2단계 조회**:
  1. 네이버 자동완성 API (`ac.finance.naver.com/ac`)
  2. 네이버 금융 페이지 title 파싱 (fallback)
- **forceMarket 처리 단순화**: 코드 정리 및 버그 수정
- **resolveKoreanName 공개 함수** 추가

### app.js  
- **doSearch**: 한국 종목 검색 후 한국어 이름 비동기 반영 (미리보기 + 리스트 동시 갱신)
- **_updateListItemName**: 리스트 행 이름만 교체하는 헬퍼 추가
- **fetchMultiple onProgress**: 기존 저장된 한국어 이름 보존 + 비동기 보강
- **등록 버튼**: watchData의 한국어 이름이 있으면 그것으로 등록
- **초기 로드**: 저장된 영문 이름을 한국어로 비동기 업데이트

---

## 🌐 API 구조

### 주요 진입점
| 경로 | 설명 |
|------|------|
| `index.html` | 메인 페이지 |

### CORS 프록시 전략 (우선순위)
| 프록시 | 방식 | 타임아웃 | 특징 |
|--------|------|---------|------|
| `api.allorigins.win/get` | 서버사이드 | 12s | 모바일 포함 가장 안전 |
| `corsproxy.io` | 중계 | 6s | PC/태블릿에서 빠름 |
| `api.codetabs.com/v1/proxy` | 서버사이드 | 10s | 추가 fallback |

---

## 📦 데이터 모델

### bb_tabs
| 필드 | 타입 | 설명 |
|------|------|------|
| id | text | 서버 UUID (기본키) |
| name | text | 탭 이름 |
| sort_order | number | 정렬 순서 |
| stocks | rich_text | JSON 배열: [{code, name, market}] |

### bb_settings
| 필드 | 타입 | 설명 |
|------|------|------|
| id | text | 서버 UUID |
| key | text | 설정 키 (active_tab / candle_count / interval) |
| value | text | 설정 값 |

---

## 🛠️ 파일 구조

```
index.html          — 메인 HTML
css/style.css       — 다크 테마 스타일
js/
  storage.js        — 서버 Table API 기반 데이터 관리
  api.js            — Yahoo Finance 조회 + CORS 프록시 + 한국어 이름
  indicators.js     — BB / EOM / RSI / Stochastic 계산
  charts.js         — ECharts 기반 차트 렌더링
  app.js            — 메인 UI 로직
```

---

## ⚠️ 미구현 / 개선 가능 항목

- [ ] 한국어 이름을 서버 DB에 영구 저장 (현재 앱 재시작 시 재조회)
- [ ] 알림 기능 (BB 하단 돌파 시 브라우저 알림)
- [ ] 다중 지표 커스터마이징 (기간 설정)
- [ ] CSV 내보내기
