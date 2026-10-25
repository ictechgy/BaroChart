// Keep this metadata deliberately hand-authored.  The registry contains the
// executable factories; the picker only needs stable labels and search terms.
const metadata = [
  ['sma', 'Simple Moving Average', '단순 이동평균', ['SMA', '이동평균', '단순이동평균'], 'trend'],
  ['vwma', 'Volume Weighted Moving Average', '거래량 가중 이동평균', ['VWMA', '거래량가중이동평균'], 'trend'],
  ['ema', 'Exponential Moving Average', '지수 이동평균', ['EMA', '지수이동평균'], 'trend'],
  ['wma', 'Weighted Moving Average', '가중 이동평균', ['WMA', '가중이동평균'], 'trend'],
  ['rsi', 'Relative Strength Index', '상대강도지수', ['RSI', '상대 강도 지수'], 'momentum'],
  ['atr', 'Average True Range', '평균진폭', ['ATR', '평균 진폭'], 'volatility'],
  ['macd', 'Moving Average Convergence Divergence', '이동평균 수렴확산', ['MACD', '이동평균수렴확산'], 'momentum'],
  ['bollinger', 'Bollinger Bands', '볼린저 밴드', ['Bollinger', '볼린저', 'BB'], 'volatility'],
  ['donchian', 'Donchian Channel', '돈치안 채널', ['Donchian', '돈치안'], 'volatility'],
  ['aroon', 'Aroon Indicator', '아룬 지표', ['Aroon', '아룬'], 'trend'],
  ['stochastic', 'Stochastic Oscillator', '스토캐스틱 오실레이터', ['Stochastic', '스토캐스틱'], 'momentum'],
  ['roc', 'Rate of Change', '변화율', ['ROC', '변화율'], 'momentum'],
  ['williamsR', 'Williams %R', '윌리엄스 %R', ['Williams R', '윌리엄스R', 'W%R'], 'momentum'],
  ['cci', 'Commodity Channel Index', '상품채널지수', ['CCI', '상품 채널 지수'], 'momentum'],
  ['obv', 'On Balance Volume', '거래량 균형지표', ['OBV', '누적 거래량'], 'volume'],
  ['vwap', 'Volume Weighted Average Price', '거래량 가중 평균 가격', ['VWAP', '거래량가중평균가격'], 'volume'],
  ['mfi', 'Money Flow Index', '자금흐름지수', ['MFI', '자금 흐름 지수'], 'volume'],
  ['cmf', 'Chaikin Money Flow', '차이킨 자금흐름', ['CMF', '차이킨 자금 흐름'], 'volume'],
  ['adx', 'Average Directional Index', '평균방향성지수', ['ADX', '평균 방향성 지수'], 'trend'],
  ['dema', 'Double Exponential Moving Average', '이중 지수 이동평균', ['DEMA', '이중지수이동평균'], 'trend'],
  ['tema', 'Triple Exponential Moving Average', '삼중 지수 이동평균', ['TEMA', '삼중지수이동평균'], 'trend'],
  ['hma', 'Hull Moving Average', '헐 이동평균', ['HMA', '헐이동평균'], 'trend'],
  ['keltner', 'Keltner Channel', '켈트너 채널', ['Keltner', '켈트너'], 'volatility'],
  ['supertrend', 'Supertrend', '슈퍼트렌드', ['Super Trend', '슈퍼 트렌드'], 'trend'],
  ['ichimoku', 'Ichimoku Cloud', '일목균형표', ['Ichimoku', '일목', '일목균형표'], 'trend'],
  ['trix', 'Triple Exponential Average Oscillator', '삼중 지수 변화율', ['TRIX', '삼중지수변화율'], 'momentum'],
  ['ppo', 'Percentage Price Oscillator', '가격 오실레이터', ['PPO', 'Percentage Price Oscillator'], 'momentum'],
  ['stochRSI', 'Stochastic RSI', '스토캐스틱 RSI', ['Stoch RSI', '스토캐스틱RSI'], 'momentum'],
  ['adl', 'Accumulation/Distribution Line', '누적·분배선', ['ADL', 'A/D Line', '누적분배선'], 'volume'],
  ['chaikin', 'Chaikin Oscillator', '차이킨 오실레이터', ['Chaikin', '차이킨'], 'volume'],
  ['forceIndex', 'Force Index', '자금력지수', ['Force Index', '자금력'], 'volume'],
  ['volumeOscillator', 'Volume Oscillator', '거래량 오실레이터', ['VO', 'Volume Oscillator', '거래량오실레이터'], 'volume'],
  ['vortex', 'Vortex Indicator', '소용돌이 지표', ['Vortex', '소용돌이지표'], 'trend'],
  ['pivots', 'Pivot Points', '피봇 포인트', ['Pivot', 'Pivots', '피봇'], 'trend'],
  ['parabolicSAR', 'Parabolic SAR', '파라볼릭 SAR', ['Parabolic', '파라볼릭'], 'trend']
];

const freezeEntry = ([id, name, koreanName, aliases, category]) => Object.freeze({
  id, name, koreanName, aliases: Object.freeze([...aliases]), category
});

export const INDICATOR_CATALOG = Object.freeze(metadata.map(freezeEntry));

const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const compact = value => normalize(value).replace(/\s+/gu, '');
const searchText = entry => compact([entry.id, entry.name, entry.koreanName, ...entry.aliases].join(' '));
const categoryValue = value => {
  const normalized = normalize(value);
  return normalized === 'all' || normalized === '전체' ? '' : normalized;
};

/** Return matching immutable catalog entries without changing the catalog. */
export function filterIndicatorCatalog(query = '', category = '', catalog = INDICATOR_CATALOG) {
  const needles = normalize(query).split(' ').filter(Boolean).map(compact);
  const categoryNeedle = categoryValue(category);
  return catalog.filter(entry => (!categoryNeedle || normalize(entry.category) === categoryNeedle) && needles.every(needle => searchText(entry).includes(needle)));
}
const CATEGORY_LABELS = Object.freeze({
  trend: '추세', momentum: '모멘텀', volatility: '변동성', volume: '거래량'
});

function clearChildren(node) {
  if (typeof node.replaceChildren === 'function') node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

function optionFor(document, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function ensureCategoryOptions(category) {
  if (!category || category.children?.length) return;
  category.append(optionFor(category.ownerDocument, '', '전체'));
  for (const value of Object.keys(CATEGORY_LABELS)) category.append(optionFor(category.ownerDocument, value, CATEGORY_LABELS[value]));
}

function labelFor(entry) {
  return `${entry.id.toUpperCase()} · ${entry.name} (${entry.koreanName})`;
}

/**
 * Bind a search input, category select, native indicator select, and summary
 * element.  The host owns the Add button and can use selectedName/selected.
 */
export function createIndicatorPicker({search, category, select, summary, catalog = INDICATOR_CATALOG, onSelect} = {}) {
  if (!search || !select || !summary) throw new TypeError('search, select, and summary controls are required');
  if (!Array.isArray(catalog)) throw new TypeError('catalog must be an array');

  const document = select.ownerDocument ?? search.ownerDocument;
  ensureCategoryOptions(category);
  let composing = false;
  let disposed = false;
  let lastSelected = '';
  let initialRender = true;
  let matches = [];

  const selectedEntry = () => catalog.find(entry => entry.id === select.value) ?? null;
  const announce = value => {
    if (initialRender) { lastSelected = value; return; }
    if (value === lastSelected) return;
    lastSelected = value;
    onSelect?.(value || null, value ? catalog.find(entry => entry.id === value) ?? null : null);
  };
  const updateSummary = () => {
    summary.textContent = !matches.length ? '검색 결과가 없습니다.' : `${matches.length}개 지표 · ${selectedEntry()?.koreanName ?? '선택 없음'}`;
  };
  const render = () => {
    if (disposed) return;
    const current = select.value;
    matches = filterIndicatorCatalog(search.value, category?.value, catalog);
    clearChildren(select);
    for (const entry of matches) select.append(optionFor(document, entry.id, labelFor(entry)));
    const next = matches.some(entry => entry.id === current) ? current : matches[0]?.id ?? '';
    select.value = next;
    updateSummary();
    announce(next);
    initialRender = false;
  };
  const onInput = () => { if (!composing) render(); };
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; render(); };
  const onCategory = () => render();
  const onChange = () => {
    if (disposed) return;
    const value = catalog.some(entry => entry.id === select.value) ? select.value : '';
    if (value !== select.value) select.value = value;
    updateSummary();
    announce(value);
  };
  const onKeydown = event => {
    if (event.key !== 'Escape' || disposed || event.isComposing || composing) return;
    if (search.value) {
      search.value = '';
      render();
      event.preventDefault?.();
    }
  };

  search.addEventListener('input', onInput);
  search.addEventListener('compositionstart', onCompositionStart);
  search.addEventListener('compositionend', onCompositionEnd);
  search.addEventListener('keydown', onKeydown);
  category?.addEventListener('change', onCategory);
  select.addEventListener('change', onChange);
  render();

  const availability = () => {
    const enabled = catalog.length > 0;
    for (const node of [search, category, select]) if (node) node.disabled = !enabled;
  };
  availability();

  return {
    get selectedName() { return selectedEntry()?.id ?? null; },
    get selected() { return selectedEntry(); },
    get matches() { return [...matches]; },
    sync() { if (!disposed) availability(); },
    destroy() {
      if (disposed) return;
      disposed = true;
      search.removeEventListener('input', onInput);
      search.removeEventListener('compositionstart', onCompositionStart);
      search.removeEventListener('compositionend', onCompositionEnd);
      search.removeEventListener('keydown', onKeydown);
      category?.removeEventListener('change', onCategory);
      select.removeEventListener('change', onChange);
    }
  };
}
