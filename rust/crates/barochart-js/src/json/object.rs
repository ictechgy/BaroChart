//! 키 순서를 보존하는 JS 일반 객체(이식 지도 §3.1.3).
//!
//! JS 자기 키 순서(`OrdinaryOwnPropertyKeys`)는 배열 인덱스 키(정규 십진 `0`..=`4294967294`)를 수 오름차순으로
//! 먼저 두고, 나머지 문자열 키를 삽입 순서로 둔다. `'01'`, `'-1'`, `'1.5'`, `'4294967295'`는 일반 키다.
//! `{...a}`, `JSON.stringify`, `Object.keys`, 검증 반복문이 모두 이 순서를 따르므로 바이트 동등성의 바탕이다.
//!
//! 구현: 인덱스 키는 `BTreeMap`(수 순서), 일반 키는 삽입 순서 `Vec`에 둔다. 일반 키가 많아지면 해시 색인을 만들어
//! 키가 많은 입력에서도 조회·중복 키 처리가 제곱 시간이 되지 않게 한다. 색인은 위치만 바꿀 뿐 결과 순서에 영향이 없다.

use std::collections::{BTreeMap, HashMap, btree_map};
use std::{fmt, slice};

use super::value::JsValue;
use crate::string::JsString;

/// 가장 큰 배열 인덱스(2^32 - 2). 2^32 - 1(`'4294967295'`)은 일반 키다.
const MAX_ARRAY_INDEX: u64 = 4_294_967_294;

/// 배열 인덱스 키의 최대 자릿수(`'4294967294'`는 10자리)
const MAX_ARRAY_INDEX_DIGITS: usize = 10;

/// 일반 키를 처음부터 훑어 찾는 최대 개수. 이보다 많아지면 해시 색인을 만든다.
///
/// 코어의 레코드(드로잉·시리즈·옵션)는 키가 몇 개뿐이라 색인 없이 훑는 편이 싸다.
const LINEAR_LOOKUP_LIMIT: usize = 8;

/// JS 자기 키 순서: 배열 인덱스 키(0..=4294967294, 앞자리 0 없음) 오름차순, 나머지는 삽입 순서. 덮어쓰기는 자리를 유지한다.
///
/// 지운 뒤 다시 넣은 일반 키는 끝에 붙는다(JS `delete` 뒤 대입과 같다). `undefined`를 담은 키도 자기 키라 자리를 지킨다.
#[derive(Clone, Default)]
pub struct JsObject {
    /// 배열 인덱스 키: 인덱스 → (원래 키, 값). 수 오름차순으로 순회한다
    indexed: BTreeMap<u32, (JsString, JsValue)>,
    /// 일반 키: 삽입 순서
    named: Vec<(JsString, JsValue)>,
    /// 일반 키 → `named` 위치. 일반 키가 `LINEAR_LOOKUP_LIMIT`개를 넘을 때만 만든다
    ///
    /// `HashMap`(48 B)을 상자에 넣어 8 B로 둔다. `JsObject`가 `JsValue`의 가장 큰 변형이라, 상자 없이는 모든 값
    /// (수 배열의 원소 하나까지)이 96 B, 상자를 쓰면 56 B다(rustc 1.98.1 aarch64-apple-darwin 실측). 색인은 키가 많은
    /// 객체에만 있으므로 추가 할당 한 번보다 모든 값의 크기가 중요하다.
    #[allow(clippy::box_collection)]
    lookup: Option<Box<HashMap<JsString, usize>>>,
}

impl JsObject {
    /// 빈 객체(`{}`)를 만든다. 메모리를 잡지 않는다.
    pub fn new() -> Self {
        Self::default()
    }

    /// 자기 키의 값을 찾는다(JS `Object.hasOwn(o, key) ? o[key] : 없음`).
    ///
    /// - `key`: 찾을 키. `'1'`과 `'01'`은 다른 키다
    /// - 반환: 값, 키가 없으면 `None`
    pub fn get(&self, key: &JsString) -> Option<&JsValue> {
        match array_index(key) {
            Some(index) => self.indexed.get(&index).map(|(_, value)| value),
            None => self
                .named_position(key)
                .map(|position| &self.named[position].1),
        }
    }

    /// 키에 값을 넣는다(JS 대입 `o[key] = value`). 있던 키면 자리를 지키고 값만 바꾼다. 새 일반 키는 끝에 붙는다.
    ///
    /// - `key`: 넣을 키
    /// - `value`: 넣을 값(`undefined`도 자기 키로 남는다)
    pub fn insert(&mut self, key: JsString, value: JsValue) {
        if let Some(index) = array_index(&key) {
            match self.indexed.entry(index) {
                btree_map::Entry::Occupied(mut slot) => slot.get_mut().1 = value,
                btree_map::Entry::Vacant(slot) => {
                    slot.insert((key, value));
                }
            }
            return;
        }
        match self.named_position(&key) {
            Some(position) => self.named[position].1 = value,
            None => self.push_named(key, value),
        }
    }

    /// 키를 지운다(JS `delete o[key]`). 남은 키의 순서는 그대로다.
    ///
    /// - `key`: 지울 키
    /// - 반환: 지운 값, 키가 없었으면 `None`
    pub fn remove(&mut self, key: &JsString) -> Option<JsValue> {
        if let Some(index) = array_index(key) {
            return self.indexed.remove(&index).map(|(_, value)| value);
        }
        let position = self.named_position(key)?;
        let (_, value) = self.named.remove(position);
        if let Some(lookup) = self.lookup.as_mut() {
            lookup.remove(key);
            // 뒤의 키가 한 칸씩 당겨졌으므로 색인 위치를 고친다
            for (offset, (later, _)) in self.named[position..].iter().enumerate() {
                if let Some(slot) = lookup.get_mut(later) {
                    *slot = position + offset;
                }
            }
        }
        Some(value)
    }

    /// (키, 값)을 JS 자기 키 순서로 순회한다(`Object.entries`와 같은 순서).
    pub fn iter(&self) -> impl Iterator<Item = (&JsString, &JsValue)> {
        self.entries()
    }

    /// 자기 키 수(`Object.keys(o).length`). `undefined`를 담은 키도 센다.
    pub fn len(&self) -> usize {
        self.indexed.len() + self.named.len()
    }

    /// 자기 키가 없는지 본다.
    pub fn is_empty(&self) -> bool {
        self.indexed.is_empty() && self.named.is_empty()
    }

    /// `iter`의 구체 타입. writer와 복제가 순회 상태를 스택에 담으려고 쓴다.
    pub(crate) fn entries(&self) -> ObjectIter<'_> {
        ObjectIter {
            indexed: self.indexed.values(),
            named: self.named.iter(),
        }
    }

    /// 값만 순회한다(키 순서와 무관한 내부 검사용).
    pub(crate) fn values(&self) -> impl Iterator<Item = &JsValue> {
        self.indexed
            .values()
            .map(|(_, value)| value)
            .chain(self.named.iter().map(|(_, value)| value))
    }

    /// 저장 순서의 끝에서 멤버 하나를 떼어 값을 돌려준다(일반 키를 먼저, 그다음 인덱스 키).
    ///
    /// 깊은 값의 반복 해제가 자식을 하나씩 떼어 낼 때 쓴다. JS 순서와 무관한 내부 연산이다.
    /// - 반환: 뗀 값, 비었으면 `None`
    pub(crate) fn pop_value(&mut self) -> Option<JsValue> {
        if let Some((key, value)) = self.named.pop() {
            if let Some(lookup) = self.lookup.as_mut() {
                lookup.remove(&key);
            }
            return Some(value);
        }
        self.indexed.pop_last().map(|(_, (_, value))| value)
    }

    /// 일반 키의 `named` 위치를 찾는다. 색인이 있으면 해시로, 없으면 처음부터 훑는다.
    ///
    /// - `key`: 배열 인덱스가 아닌 키
    /// - 반환: 위치, 없으면 `None`
    fn named_position(&self, key: &JsString) -> Option<usize> {
        match &self.lookup {
            Some(lookup) => lookup.get(key).copied(),
            None => self.named.iter().position(|(existing, _)| existing == key),
        }
    }

    /// 새 일반 키를 끝에 붙이고, 개수가 한도를 넘으면 색인을 만든다.
    ///
    /// - `key`: 없던 일반 키
    /// - `value`: 값
    fn push_named(&mut self, key: JsString, value: JsValue) {
        if let Some(lookup) = self.lookup.as_mut() {
            lookup.insert(key.clone(), self.named.len());
        }
        self.named.push((key, value));
        if self.lookup.is_none() && self.named.len() > LINEAR_LOOKUP_LIMIT {
            let lookup = self
                .named
                .iter()
                .enumerate()
                .map(|(position, (name, _))| (name.clone(), position))
                .collect();
            self.lookup = Some(Box::new(lookup));
        }
    }
}

/// 무손실 JSON 텍스트로 보인다(진단용, `JsValue`의 Debug와 같은 형식).
impl fmt::Debug for JsObject {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&String::from_utf8_lossy(&super::write::object_to_lossless(
            self,
        )))
    }
}

/// `JsObject::iter`의 순회자: 인덱스 키를 먼저, 그다음 일반 키를 삽입 순서로 낸다.
pub(crate) struct ObjectIter<'a> {
    /// 배열 인덱스 키(수 오름차순)
    indexed: btree_map::Values<'a, u32, (JsString, JsValue)>,
    /// 일반 키(삽입 순서)
    named: slice::Iter<'a, (JsString, JsValue)>,
}

impl<'a> Iterator for ObjectIter<'a> {
    type Item = (&'a JsString, &'a JsValue);

    fn next(&mut self) -> Option<Self::Item> {
        match self.indexed.next() {
            Some((key, value)) => Some((key, value)),
            None => self.named.next().map(|(key, value)| (key, value)),
        }
    }
}

/// 키가 정규 배열 인덱스(`'0'` 또는 앞자리 0 없는 십진수, 4294967294 이하)면 그 수를 돌려준다.
///
/// - `key`: 살펴볼 키
/// - 반환: 인덱스, 일반 키면 `None`
fn array_index(key: &JsString) -> Option<u32> {
    let units = key.as_units();
    let (&first, rest) = units.split_first()?;
    if units.len() > MAX_ARRAY_INDEX_DIGITS || (first == u16::from(b'0') && !rest.is_empty()) {
        return None;
    }
    let mut index: u64 = 0;
    for &unit in units {
        let digit = unit
            .checked_sub(u16::from(b'0'))
            .filter(|digit| *digit <= 9)?;
        index = index * 10 + u64::from(digit);
    }
    if index > MAX_ARRAY_INDEX {
        return None;
    }
    u32::try_from(index).ok()
}
