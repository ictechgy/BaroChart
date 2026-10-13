# 지표 수치 규약

0.2.11의 세션 VWAP·pivots·기준 시점 조회는 [SESSION-STUDIES.md](SESSION-STUDIES.md), 정적 사용자 모듈·지표 저장/병합은 [INDICATOR-MODULES.md](INDICATOR-MODULES.md)를 참고하세요. 아래 과거 실행 수와 새 검증 수를 합산하지 않습니다.

지표는 축약된 화면 봉이 아니라 **전체 원본 OHLCV**로 계산합니다. 조회한 화면 범위·DPR은 결과에 영향을 주지 않습니다. 35종 built-in factory와 사용자 stateful factory를 제공합니다.

0-based index, period=p입니다. p는 1..10,000 정수입니다. NaN은 warm-up 또는 정의되지 않은 값이며 렌더러는 해당 출력점을 생략합니다. 원본 입력 NaN/Infinity는 저장소에서 거부하므로 gap을 건너뛰어 seed를 잇는 동작은 없습니다.

| 지표 | 기본값·계산 | 최초 유효 출력 / 0분모 |
|---|---|---|
| SMA | close rolling mean, p=20; source 변경 가능 | p−1 |
| EMA | p=20, SMA(p) seed, α=2/(p+1) | 정상 p−1; 첫 close seed 아님. overflow recovery는 아래 별도 규약 |
| WMA | p=20, 오래된→최신 가중치 1..p | p−1; O(p) 계산 |
| RSI | p=14, close 변화 gain/loss SMA seed, Wilder α=1/p | p; gain=loss=0 → 50, loss=0 → 100 |
| ATR | p=14, 첫 TR=high−low, 이후 max(H−L, abs(H−prevC), abs(L−prevC)); SMA seed/Wilder | p−1 |
| MACD | fast=12, slow=26, signal=9; 각 EMA는 SMA seed | MACD slow−1, signal/hist slow+signal−2 |
| Bollinger | p=20, deviation=2; mean ± deviation×**population** stddev | p−1; flat stddev=0; 제거/추가 Welford |
| Donchian | p=20, rolling high/low, middle 평균 | p−1; 단조 queue |
| Aroon | p=25 prior intervals; 현재 포함 p+1봉의 최신 고/저점 나이로 up/down=100(p−age)/p, oscillator=up−down | p; 동률은 최신 index, flat up/down100·oscillator0 |
| Stochastic | p=14, smoothK=3, smoothD=3; K=100(C−L)/(H−L), SMA K/D | K p+smoothK−2; D p+smoothK+smoothD−3; H=L → 50 |
| ROC | p=12, (C/C[i−p]−1)×100 | p; 과거 C=0 → NaN |
| Williams %R | p=14, −100(H−C)/(H−L) | p−1; H=L → −50 |
| CCI | p=20, typical=(H+L+C)/3, mean absolute deviation; (TP−mean)/(.015×MAD) | p−1; MAD=0 → 0; O(p) |
| OBV | 초기 0, close 변화 방향×volume 누적, flat 변화 없음 | 0; 첫 봉 volume을 누적하지 않음 |
| VWAP | typical price×volume 누적 / volume; sessionMs=86,400,000 | volume>0 이후; volume=0 → NaN |
| MFI | p=14, TP 변화 방향의 money flow SMA 비율 | p; 양·음 flow=0 → 50, 음 flow=0 → 100 |
| CMF | p=20, ((2C−H−L)/(H−L)×V) rolling 합 / rolling V | p−1; H=L의 flow=0, rolling V=0 → NaN |
| DEMA | p=20, 2×EMA(C)−EMA(EMA(C)), 모두 SMA seed | 2p−2 |
| TEMA | p=20, 3E1−3E2+E3 | 3p−3 |
| HMA | p=20, WMA(floor√p, 2WMA(floor(p/2),C)−WMA(p,C)); 기간 최소1 | p+floor√p−2; WMA O(p) |
| VWMA | sum(close×volume)/sum(volume), p20 현재 포함 p봉; zero volume 및 명시 overflow는 NaN | p−1 |
| Keltner | EMA20 middle ± 2×Wilder ATR10; multiplier/atrPeriod 설정 | middle p−1; band max(p,atrPeriod)−1 |
| Supertrend | Wilder ATR10, HL2±3ATR, 이전 close가 넘은 band 또는 좁아진 band 갱신 | p−1; 첫 방향 +1/lower. 상승은 lower 하향 이탈 시 −1, 하락은 upper 상향 이탈 시 +1 |
| Ichimoku | high/low midpoint Tenkan9/Kijun26, SpanA=(T+K)/2, SpanB52, Chikou=close | T8/K25/A25/B51/C0; plotOffsets A/B +26, C −26. 원본 출력 배열은 이동하지 않음 |
| TRIX | SMA-seeded triple EMA15의 전 봉 대비 변화율×100 | 3p−2; 이전 triple EMA=0 또는 변화율이 Float64로 표현 불가 → NaN gap; EMA 상태는 유지하여 다음 finite 출력 회복 |
| PPO | 100(EMA12−EMA26)/EMA26, EMA9 signal, histogram=차이 | slow−1, signal slow+signal−2; slow EMA=0 → NaN |
| Stoch RSI | Wilder RSI14의 rolling14 min/max, 0..100 raw, SMA3 K/D | RSI p 후 stoch/K/D warm-up; K p+stochPeriod+smoothK−2, D에 smoothD−1 추가; flat RSI → 50 |
| ADL | 누적 ((2C−H−L)/(H−L))×V | 0; H=L flow0. OBV와 다른 수식 |
| Chaikin oscillator | EMA3(ADL)−EMA10(ADL) | slow−1; SMA seed |
| Force Index | EMA13((C−prevC)×V) | p; 첫 변화 NaN |
| Volume oscillator | 100(SMA14(V)−SMA28(V))/SMA28(V) | slow−1; rolling V=0 → NaN |
| Vortex | rolling abs(H−prevL)/rolling TR 및 abs(L−prevH)/TR, p14 | p; 첫 비교 제외; rolling TR=0 → NaN |
| Classic pivots | 이전 관측 UTC/sessionMs 구간 H/L/lastC로 P,R1,S1,R2,S2 | 첫 구간 NaN; 다음 구간부터 P=(H+L+C)/3, R1=2P−L, S1=2P−H, R2=P+H−L, S2=P−H+L |
| Parabolic SAR | step .02/max .2; EP·AF 재귀, 직전 2봉 extrema로 clamp | index1: 2봉 close 방향, 상승 min(low0,low1)/하락 max(high0,high1) seed. 이후 현재 low/high가 SAR을 넘으면 방향 반전·SAR=이전EP·AF reset |
| ADX | p=14, directional movement/TR Wilder; DI 및 DX 후 ADX Wilder seed | DI p, ADX 2p−1; TR=0→DI 0, DI합=0→DX 0 |

VWAP built-in의 session은 `floor(time/sessionMs)` 경계입니다. **거래소 현지 정규장 open reset과 동일하지 않습니다.** 시장 세션별 VWAP이 필요하면 SessionCalendar를 참조하는 사용자 factory를 등록해야 합니다. 일광절약 시간제를 가진 시장에 `sessionMs`만 바꿔 완전한 시장 VWAP이라고 주장하지 않습니다.

append/current replacement/역사 correction은 변경 위치의 checkpoint 이전 상태에서 suffix를 다시 계산합니다. 현재 봉을 여러 번 교체해도 rolling 상태가 중복 누적되지 않습니다. reset/prepend는 checkpoint를 비우고 전체 재계산합니다. double 누적 오차가 발생할 수 있으며 비교 테스트는 상대 오차 1e−10을 사용합니다. Bollinger도 작은 부동소수점 오차를 완전히 제거하지 않습니다.

검증: 기존17종 mixed/tiny/flat 독립 수치46,800개와 추가16종28,800개 출력 위치/warm-up을 검사합니다. 6봉 단조 수열의 해석적 fixture도 유지하고, 33종 모두 seed=123의 550봉에서 255/256 경계 append, 마지막/첫/중간 봉 수정, reset/empty, flat/0 volume, custom output 오류를 검사합니다. 상용·TA-Lib과 모든 입력에 대해 bitwise 동등성을 확인한 것은 아닙니다. 구현 규약이 다른 EMA seed/ATR 초기값을 사용하는 제품과 warm-up 값이 다를 수 있습니다.

Supertrend/SAR seed와 reversal 규약은 위 표의 구현 선택입니다. VWAP뿐 아니라 pivots도 UTC/sessionMs이며 거래소 open 기반 경계는 custom factory로 주입하세요. Ichimoku의 positive/negative plot offset은 hindsight 표시를 포함하며 미래 가격을 예측한 출력이 아닙니다.

## Aroon 추가 규약

`aroon`은 `up`, `down`, `oscillator`를 반환합니다. `period`(기본25, 정수1..10000)는 과거 interval 수이므로 현재를 포함한 window는 `period+1`봉입니다. 최초 finite 출력은 0-based index `period`이며, 그 전 세 출력은 NaN입니다. 동률 extrema(±0 포함)는 최신 봉을 선택합니다. 시간 gap은 경과 밀리초가 아닌 저장된 봉 개수로 셉니다. 원본 OHLCV NaN/Infinity는 기존 BarStore 계약대로 거부합니다. up/down은0..100, oscillator는−100..100입니다. 이는 매수/매도 권고나 타제품 모든 설정과의 parity 보장이 아닙니다.

수식 설명은 [TradingView 공식 Aroon 설명](https://www.tradingview.com/support/solutions/43000501801-aroon-indicator/)을 참고했으며 외부 구현 코드는 사용하지 않았습니다. window 포함 범위·동률·warmup은 위의 명시적 계약과 독립 raw-bar scan oracle로 검증합니다. 단조 queue는 amortized O(1) step, O(period) state이며 기존 checkpoint canonicalization으로 만료 prefix를 버립니다. 큰 period의 checkpoint/worker/native restore는 기존 byte 예산에 따라 거부될 수 있습니다. compaction의 studyHistory restart는 축약 suffix에서 warmup을 다시 시작합니다.

```js
api.addIndicator('trend-age', 'aroon', {period: 25});
api.addPanel({id: 'aroon', weight: 1, range: [-100, 100]});
for (const output of ['up', 'down', 'oscillator']) {
  api.addSeries({id: `aroon-${output}`, type: 'line', panel: 'aroon',
    indicator: 'trend-age', output});
}
```

Aroon 추가 검증은 독립 전체-window scan과 incremental append/update/correction/prepend/reset, 실제 Node Worker의 params/workspace 복원, compact restart, native bundle VM/독립 QuickJS 경로를 분리합니다. 이 실행 결과가 Swift/JSC 또는 Android/JNI SDK·기기 검증을 대신하지는 않습니다.

검증 범위와 실행 결과: [Aroon validation](AROON-VALIDATION.md).


## VWMA 추가 규약

`vwma`는 close 고정, `{period:20}`(정수1..10000), `value` 한 출력을 제공합니다. 현재 포함 p봉을 사용하고 첫 출력은 index p−1입니다. 0 volume만 있는 window는 NaN입니다. 시간 gap은 빈 봉을 합성하지 않습니다. 원본 finite OHLCV/비음수 volume 규약을 유지합니다.

**극대값 제한:** 원시 Float64 `close*volume` 곱셈을 사용합니다. product overflow가 포함되거나 volume 합 또는 absolute-product 합이 표현 불가한 window는 NaN gap입니다. 양·음 product가 상쇄되어 수학적 평균이 유한해도 absolute-product 합 overflow이면 gap입니다. 이는 scaled mean이나 임의 정밀도 계산이 아닙니다. product underflow는 0이 될 수 있으며 period 1에도 별도 우회가 없습니다. 문제 봉이 빠지면 현재 window에서 정상 계산을 회복합니다.

세 rolling 합계(분자/volume/absolute-product)는 보상값을 함께 저장합니다. p번마다, 또는 abs/volume 합이 MAX_VALUE/4 이상이거나 산술 상태가 비유한이거나 퇴거 항이 기존 순합/volume의 절반 이상이거나 보상값이 현재 합계 규모의 오차 한도를 벗어날 때 시간순 window를 재합산합니다. 보통 amortized O(1), 극대값·심한 상쇄 구간 O(p)/봉, 상태 O(p)입니다. checkpoint에도 ring/counter/sum/comp를 보존하며 기존 byte/count 한도를 약화하지 않습니다. synchronous dirty-history 계산은 UI thread를 막을 수 있습니다.

수식의 일반 정의는 [TradingView 공식 VWMA 설명](https://www.tradingview.com/support/solutions/43000592293-volume-weighted-moving-average-vwma/)을 참조했습니다. 위 warmup/overflow/복구와 부동소수 규약은 이 구현의 명시 계약이며 타제품 모든 값과의 parity 보장은 아닙니다.

검증 범위와 실행 결과: [VWMA validation](VWMA-VALIDATION.md).

SMA의 overflow gap 및 finite-window 복구 규약: [SMA recovery](SMA-RECOVERY.md).

EMA seed/recurrent overflow와 period1 복구: [EMA recovery](EMA-RECOVERY.md).
