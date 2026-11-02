//! JSON으로 오가는 JS 값(이식 지도 §3.1.3, D7·D11).
//!
//! 수는 -0, NaN, ±Infinity를 그대로 담고(iOS는 비유한 수를 코어에 넘긴다), 문자열은 단독 서로게이트를 담는
//! WTF-16이다. 객체는 JS 자기 키 순서를 지킨다.
//!
//! JS `JSON.parse`는 깊이 제한이 없다(V8·JSC는 깊이 100,000도 파싱한다). 그래서 이 값은 깊이와 무관하게
//! 스택을 쓰지 않도록 해제(`Drop`)와 복제(`Clone`)를 반복으로 구현한다. 기본 파생 구현은 중첩 깊이만큼
//! 재귀해 깊은 입력에서 스레드 스택을 넘긴다(스택 넘침은 `catch_unwind`로 잡히지 않고 프로세스가 죽는다).
//! `Drop`을 구현했으므로 `JsValue`를 값으로 분해(move)할 수는 없다. 안쪽 값은 참조로 매치하거나
//! `std::mem::take`로 꺼낸다(기본값은 `Undefined`).

use std::fmt;
use std::slice;

use super::JsonMode;
use super::object::{JsObject, ObjectIter};
use super::write::stringify_json;
use crate::string::JsString;

/// JS 값. 커널이 다루는 JSON 값과 `undefined`다.
#[derive(Default)]
pub enum JsValue {
    /// `undefined`. 객체 안에서는 자기 키로 남고, 표준 JSON으로 쓸 때 객체에서는 빠지고 배열에서는 `null`이 된다
    #[default]
    Undefined,
    /// `null`
    Null,
    /// 불리언
    Bool(bool),
    /// 수(f64). -0, NaN, ±Infinity를 그대로 담는다
    Number(f64),
    /// 문자열(WTF-16)
    String(JsString),
    /// 배열
    Array(Vec<JsValue>),
    /// 키 순서를 보존하는 일반 객체
    Object(JsObject),
}

impl JsValue {
    /// 배열이나 객체인지 본다.
    fn is_container(&self) -> bool {
        matches!(self, Self::Array(_) | Self::Object(_))
    }

    /// 자식 가운데 배열이나 객체가 있는지 본다. 없으면 기본 해제가 한 단계만 내려가므로 반복 해제가 필요 없다.
    fn has_nested_container(&self) -> bool {
        match self {
            Self::Array(items) => items.iter().any(Self::is_container),
            Self::Object(object) => object.values().any(Self::is_container),
            _ => false,
        }
    }

    /// 깊은 자식(다시 컨테이너를 품은 자식)이 있는지 본다. 없으면 기본 해제가 두 단계(자식, 손자)에서 끝난다.
    fn has_deep_child(&self) -> bool {
        match self {
            Self::Array(items) => items.iter().any(Self::has_nested_container),
            Self::Object(object) => object.values().any(Self::has_nested_container),
            _ => false,
        }
    }

    /// 자식을 뒤에서부터 하나씩 떼어 내며 얕은 자식은 바로 풀고, 처음 만난 깊은 자식(다시 컨테이너를 품은 자식)을 돌려준다.
    ///
    /// - 반환: 깊은 자식, 남은 자식이 없으면 `None`(그때 이 값은 비어 있다)
    fn pop_deep_child(&mut self) -> Option<JsValue> {
        match self {
            Self::Array(items) => first_deep(std::iter::from_fn(|| items.pop())),
            Self::Object(object) => first_deep(std::iter::from_fn(|| object.pop_value())),
            _ => None,
        }
    }
}

/// 떼어 낸 자식들 가운데 첫 깊은 자식을 고르고, 그 앞의 얕은 자식은 하나씩 푼다.
///
/// - `children`: 부모에서 하나씩 떼어 내는 자식들
/// - 반환: 깊은 자식, 없으면 `None`
fn first_deep(mut children: impl Iterator<Item = JsValue>) -> Option<JsValue> {
    children.find(JsValue::has_nested_container)
}

/// 중첩 깊이와 무관하게 스택을 일정하게 쓰는 해제.
///
/// 지금 내려가는 경로의 컨테이너만 힙의 경로 목록에 들고, 맨 아래 컨테이너에서 깊은 자식을 하나씩 떼어 내려간다.
/// 깊은 자식이 남지 않은 컨테이너는 보통 해제로 푼다(재귀 두 단계). 경로 목록의 길이는 중첩 깊이를 넘지 않는다.
/// 손자까지 원시 값인 값(수 배열, 원시 값만 든 레코드의 배열)은 경로 목록을 만들지 않는다.
impl Drop for JsValue {
    fn drop(&mut self) {
        if !self.has_deep_child() {
            return;
        }
        let mut path = vec![std::mem::take(self)];
        while let Some(bottom) = path.last_mut() {
            match bottom.pop_deep_child() {
                Some(child) => path.push(child),
                None => {
                    path.pop();
                }
            }
        }
    }
}

/// 중첩 깊이와 무관하게 스택을 일정하게 쓰는 깊은 복제. 키 순서와 -0·NaN·`undefined`를 그대로 옮긴다.
impl Clone for JsValue {
    fn clone(&self) -> Self {
        match self {
            Self::Undefined => Self::Undefined,
            Self::Null => Self::Null,
            Self::Bool(flag) => Self::Bool(*flag),
            Self::Number(number) => Self::Number(*number),
            Self::String(text) => Self::String(text.clone()),
            Self::Array(_) | Self::Object(_) => clone_tree(self),
        }
    }
}

/// 무손실 JSON 텍스트로 보인다(진단용). -0, NaN, `undefined`, 단독 서로게이트(`\udxxx`)가 그대로 드러난다.
impl fmt::Debug for JsValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&String::from_utf8_lossy(&stringify_json(
            self,
            JsonMode::Lossless,
        )))
    }
}

/// 복제 중인 컨테이너 하나. 원본 순회 상태와 새로 만드는 컨테이너를 함께 든다.
enum CloneFrame<'a> {
    /// 배열: 원본 원소 순회자와 새 원소들
    Array {
        /// 남은 원본 원소
        source: slice::Iter<'a, JsValue>,
        /// 지금까지 복제한 원소
        target: Vec<JsValue>,
    },
    /// 객체: 원본 멤버 순회자, 새 객체, 지금 복제 중인 자식의 키
    Object {
        /// 남은 원본 멤버(JS 키 순서)
        source: ObjectIter<'a>,
        /// 지금까지 복제한 멤버
        target: JsObject,
        /// 마지막으로 꺼낸 자식의 키. 자식을 붙일 때 쓴다
        key: JsString,
    },
}

impl<'a> CloneFrame<'a> {
    /// 컨테이너의 복제를 시작한다.
    ///
    /// - `value`: 원본 값
    /// - 반환: 배열·객체면 새 프레임, 원시 값이면 `None`
    fn open(value: &'a JsValue) -> Option<Self> {
        match value {
            JsValue::Array(items) => Some(Self::Array {
                source: items.iter(),
                target: Vec::with_capacity(items.len()),
            }),
            JsValue::Object(object) => Some(Self::Object {
                source: object.entries(),
                target: JsObject::new(),
                key: JsString::default(),
            }),
            _ => None,
        }
    }

    /// 다음 원본 자식을 꺼낸다. 객체면 그 키를 기억해 둔다.
    ///
    /// - 반환: 원본 자식, 다 꺼냈으면 `None`
    fn next_child(&mut self) -> Option<&'a JsValue> {
        match self {
            Self::Array { source, .. } => source.next(),
            Self::Object { source, key, .. } => source.next().map(|(name, value)| {
                *key = name.clone();
                value
            }),
        }
    }

    /// 다 복제한 자식을 붙인다. 객체면 `next_child`가 기억한 키로 넣는다.
    ///
    /// - `child`: 복제한 자식
    fn attach(&mut self, child: JsValue) {
        match self {
            Self::Array { target, .. } => target.push(child),
            Self::Object { target, key, .. } => target.insert(std::mem::take(key), child),
        }
    }

    /// 다 만든 컨테이너를 값으로 바꾼다.
    fn finish(self) -> JsValue {
        match self {
            Self::Array { target, .. } => JsValue::Array(target),
            Self::Object { target, .. } => JsValue::Object(target),
        }
    }
}

/// 배열·객체를 반복으로 깊게 복제한다. 자식 컨테이너는 다 만든 뒤 부모에 붙인다.
///
/// - `root`: 원본 배열·객체
/// - 반환: 복제본
fn clone_tree(root: &JsValue) -> JsValue {
    let Some(first) = CloneFrame::open(root) else {
        // 원시 값의 복제는 재귀하지 않는다
        return root.clone();
    };
    let mut stack = vec![first];
    let mut finished = JsValue::Undefined;
    while let Some(frame) = stack.last_mut() {
        match frame.next_child() {
            Some(child) => match CloneFrame::open(child) {
                Some(child_frame) => stack.push(child_frame),
                None => frame.attach(child.clone()),
            },
            None => {
                let done = match stack.pop() {
                    Some(frame) => frame.finish(),
                    None => JsValue::Undefined,
                };
                match stack.last_mut() {
                    Some(parent) => parent.attach(done),
                    None => finished = done,
                }
            }
        }
    }
    finished
}
