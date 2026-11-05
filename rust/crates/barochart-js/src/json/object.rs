//! 키 순서를 보존하는 JS 일반 객체(이식 지도 §3.1.3).
//!
//! JS 자기 키 순서(`OrdinaryOwnPropertyKeys`)는 배열 인덱스 키(정규 십진 `0`..=`4294967294`)를 수 오름차순으로
//! 먼저 두고, 나머지 문자열 키를 삽입 순서로 둔다. `'01'`, `'-1'`, `'1.5'`, `'4294967295'`는 일반 키다.
//! `{...a}`, `JSON.stringify`, `Object.keys`, 검증 반복문이 모두 이 순서를 따르므로 바이트 동등성의 바탕이다.
//!
//! 구현: 인덱스 키는 수 순서의 연속 `Vec`, 일반 키는 삽입 순서 `Vec`에 둔다. 일반 키가 많아지면 해시 색인을 만든다.
//! Untrusted parser는 별도 builder에서 두 종류를 해시 조회하며 모은 뒤 인덱스 키를 한 번 정렬하므로, 내림차순 wide
//! 입력도 제곱 시간이 되지 않는다. 색인은 위치만 바꿀 뿐 결과 순서에 영향이 없다.

use std::collections::HashMap;
use std::mem::size_of;
use std::{fmt, slice};

use super::value::JsValue;
use crate::memory::{MemoryFailure, MemoryScope};
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
    /// 배열 인덱스 키: `(인덱스, 원래 키, 값)`. 인덱스 오름차순이다.
    indexed: Vec<(u32, JsString, JsValue)>,
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

    /// 소유 entry를 fallible builder로 모아 JS 자기 키 순서의 객체를 만든다.
    /// 새 컨테이너와 색인 allocation은 `scope`가 보유하므로 결과를 쓰는 동안 scope를 유지해야 한다.
    /// key/value payload의 기존 소유권은 이동하며 같은 키의 마지막 값만 남는다.
    pub fn try_from_entries_scoped(
        entries: impl IntoIterator<Item = (JsString, JsValue)>,
        scope: &mut MemoryScope,
    ) -> Result<Self, MemoryFailure> {
        let mut builder = JsObjectBuilder::new();
        for (key, value) in entries {
            builder.insert(key, value, scope)?;
        }
        Ok(builder.finish())
    }

    /// 연속 인덱스 키를 갖는 typed-array JSON 객체를 중간 entry 배열 없이 만든다.
    pub fn try_from_indexed_values_scoped(
        values: impl IntoIterator<Item = JsValue>,
        scope: &mut MemoryScope,
    ) -> Result<Self, MemoryFailure> {
        let mut builder = JsObjectBuilder::new();
        for (index, value) in values.into_iter().enumerate() {
            let key = JsString::try_from_str(&index.to_string(), scope)?;
            builder.insert(key, value, scope)?;
        }
        Ok(builder.finish())
    }

    pub(crate) fn from_builder_parts(
        indexed: Vec<(u32, JsString, JsValue)>,
        named: Vec<(JsString, JsValue)>,
        named_lookup: HashMap<JsString, usize>,
    ) -> Self {
        Self {
            indexed,
            lookup: (named.len() > LINEAR_LOOKUP_LIMIT).then(|| Box::new(named_lookup)),
            named,
        }
    }

    /// 자기 키의 값을 찾는다(JS `Object.hasOwn(o, key) ? o[key] : 없음`).
    ///
    /// - `key`: 찾을 키. `'1'`과 `'01'`은 다른 키다
    /// - 반환: 값, 키가 없으면 `None`
    pub fn get(&self, key: &JsString) -> Option<&JsValue> {
        match array_index(key) {
            Some(index) => self
                .indexed
                .binary_search_by_key(&index, |(index, _, _)| *index)
                .ok()
                .map(|position| &self.indexed[position].2),
            None => self
                .named_position(key)
                .map(|position| &self.named[position].1),
        }
    }

    /// 키와 순서를 바꾸지 않고 자기 key의 값만 배타적으로 빌린다.
    pub fn get_mut(&mut self, key: &JsString) -> Option<&mut JsValue> {
        match array_index(key) {
            Some(index) => self
                .indexed
                .binary_search_by_key(&index, |(index, _, _)| *index)
                .ok()
                .map(|position| &mut self.indexed[position].2),
            None => self
                .named_position(key)
                .map(|position| &mut self.named[position].1),
        }
    }

    /// 키에 값을 넣는다(JS 대입 `o[key] = value`). 있던 키면 자리를 지키고 값만 바꾼다. 새 일반 키는 끝에 붙는다.
    ///
    /// - `key`: 넣을 키
    /// - `value`: 넣을 값(`undefined`도 자기 키로 남는다)
    pub fn insert(&mut self, key: JsString, value: JsValue) {
        if let Some(index) = array_index(&key) {
            match self
                .indexed
                .binary_search_by_key(&index, |(index, _, _)| *index)
            {
                Ok(position) => self.indexed[position].2 = value,
                Err(position) => self.indexed.insert(position, (index, key, value)),
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
            let position = self
                .indexed
                .binary_search_by_key(&index, |(index, _, _)| *index)
                .ok()?;
            return Some(self.indexed.remove(position).2);
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
            indexed: self.indexed.iter(),
            named: self.named.iter(),
        }
    }

    /// 값만 순회한다(키 순서와 무관한 내부 검사용).
    pub(crate) fn values(&self) -> impl Iterator<Item = &JsValue> {
        self.indexed
            .iter()
            .map(|(_, _, value)| value)
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
        self.indexed.pop().map(|(_, _, value)| value)
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

/// Untrusted parser가 wide object를 amortized O(n)으로 모으고 numeric key를 한 번 정렬한다.
pub(crate) struct JsObjectBuilder {
    indexed: Vec<(u32, JsString, JsValue)>,
    indexed_lookup: HashMap<u32, usize>,
    named: Vec<(JsString, JsValue)>,
    named_lookup: HashMap<JsString, usize>,
}

impl JsObjectBuilder {
    pub(crate) fn new() -> Self {
        Self {
            indexed: Vec::new(),
            indexed_lookup: HashMap::new(),
            named: Vec::new(),
            named_lookup: HashMap::new(),
        }
    }

    pub(crate) fn insert(
        &mut self,
        key: JsString,
        value: JsValue,
        scope: &mut MemoryScope,
    ) -> Result<(), MemoryFailure> {
        if let Some(index) = array_index(&key) {
            if let Some(position) = self.indexed_lookup.get(&index).copied() {
                self.indexed[position].2 = value;
                return Ok(());
            }
            reserve_vec(&mut self.indexed, 1, scope)?;
            reserve_hash(&mut self.indexed_lookup, 1, scope)?;
            let position = self.indexed.len();
            self.indexed.push((index, key, value));
            self.indexed_lookup.insert(index, position);
            return Ok(());
        }
        if let Some(position) = self.named_lookup.get(&key).copied() {
            self.named[position].1 = value;
            return Ok(());
        }
        reserve_vec(&mut self.named, 1, scope)?;
        reserve_hash(&mut self.named_lookup, 1, scope)?;
        let lookup_key = key.try_clone_scoped(scope)?;
        let position = self.named.len();
        self.named.push((key, value));
        self.named_lookup.insert(lookup_key, position);
        Ok(())
    }

    pub(crate) fn finish(mut self) -> JsObject {
        self.indexed.sort_unstable_by_key(|(index, _, _)| *index);
        JsObject::from_builder_parts(self.indexed, self.named, self.named_lookup)
    }
}

fn reserve_vec<T>(
    values: &mut Vec<T>,
    additional: usize,
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure> {
    let bytes = additional
        .checked_mul(size_of::<T>())
        .ok_or_else(|| scope.allocation_failure())?;
    scope.try_grow(bytes)?;
    values
        .try_reserve(additional)
        .map_err(|_| scope.allocation_failure())
}

fn reserve_hash<K, V>(
    values: &mut HashMap<K, V>,
    additional: usize,
    scope: &mut MemoryScope,
) -> Result<(), MemoryFailure>
where
    K: Eq + std::hash::Hash,
{
    let bytes = additional
        .checked_mul(size_of::<(K, V)>().saturating_add(16))
        .ok_or_else(|| scope.allocation_failure())?;
    scope.try_grow(bytes)?;
    values
        .try_reserve(additional)
        .map_err(|_| scope.allocation_failure())
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
    indexed: slice::Iter<'a, (u32, JsString, JsValue)>,
    /// 일반 키(삽입 순서)
    named: slice::Iter<'a, (JsString, JsValue)>,
}

impl<'a> Iterator for ObjectIter<'a> {
    type Item = (&'a JsString, &'a JsValue);

    fn next(&mut self) -> Option<Self::Item> {
        match self.indexed.next() {
            Some((_, key, value)) => Some((key, value)),
            None => self.named.next().map(|(key, value)| (key, value)),
        }
    }
}

/// 키가 정규 배열 인덱스(`'0'` 또는 앞자리 0 없는 십진수, 4294967294 이하)면 그 수를 돌려준다.
///
/// - `key`: 살펴볼 키
/// - 반환: 인덱스, 일반 키면 `None`
pub(crate) fn array_index(key: &JsString) -> Option<u32> {
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
