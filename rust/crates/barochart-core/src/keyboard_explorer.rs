//! DOM 없이 stored UTC 봉·시리즈를 선택하고 명시적 요청에서만 값을 읽는다.
use crate::{Host, model_state::Series, native_chart::NativeChart};
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::number_to_string_with;
use barochart_js::string::JsString;
fn key(v: &str) -> JsString {
    JsString::from_str(v)
}
fn error(v: &str) -> JsError {
    JsError::new("Error", key(v))
}
fn object<const N: usize>(fields: [(&str, JsValue); N]) -> JsValue {
    let mut o = JsObject::new();
    for (k, v) in fields {
        o.insert(key(k), v);
    }
    JsValue::Object(o)
}
fn join(parts: &[JsString]) -> JsString {
    let mut u = Vec::new();
    for p in parts {
        u.extend_from_slice(p.as_units());
    }
    JsString::from_utf16(u)
}
fn field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    let JsValue::Object(o) = value else {
        return None;
    };
    o.get(&key(name))
}
fn text_field(v: &JsValue, name: &str) -> JsString {
    match field(v, name) {
        Some(JsValue::String(v)) => v.clone(),
        _ => key(""),
    }
}
fn num(n: f64, chart: &NativeChart, signed_zero: bool) -> JsString {
    if signed_zero && n == 0.0 && n.is_sign_negative() {
        key("-0")
    } else {
        key(&number_to_string_with(n, chart.dialect()))
    }
}
fn nullable_num(v: Option<&JsValue>, chart: &NativeChart, missing: &str) -> JsString {
    match v {
        Some(JsValue::Number(n)) => num(*n, chart, false),
        _ => key(missing),
    }
}
/// Weak API owner별 한 개의 ephemerally retained semantic selection이다.
pub struct NativeKeyboardExplorer {
    active: bool,
    time: Option<f64>,
    series_id: Option<JsString>,
    phase: &'static str,
    text: JsString,
    busy: bool,
}
impl Default for NativeKeyboardExplorer {
    fn default() -> Self {
        Self {
            active: false,
            time: None,
            series_id: None,
            phase: "off",
            text: key(""),
            busy: false,
        }
    }
}
impl NativeKeyboardExplorer {
    fn rows(chart: &NativeChart) -> Result<Vec<&Series>, JsError> {
        let rows = chart
            .model()
            .series
            .iter()
            .filter(|s| s.visible)
            .collect::<Vec<_>>();
        if rows.len() > 256 {
            return Err(JsError::new("RangeError", key("Exploration series limit")));
        }
        Ok(rows)
    }
    fn index(&self, chart: &NativeChart) -> Option<usize> {
        let time = self.time?;
        let store = chart.data().store();
        let index = store.lower_bound(time);
        (index < store.length() && store.columns().time[index] == time).then_some(index)
    }
    fn selection_text(&self, chart: &NativeChart) -> Result<JsString, JsError> {
        let store = chart.data().store();
        if store.length() == 0 {
            return Ok(key(
                "No stored bars. Home or End selects a bar after data arrives.",
            ));
        }
        let Some(index) = self.index(chart) else {
            return Ok(key(
                "Selected bar is no longer available. Press Home or End to select a stored bar.",
            ));
        };
        let rows = Self::rows(chart)?;
        let row = rows.iter().find(|s| self.series_id.as_ref() == Some(&s.id));
        let selected = if let Some(s) = row {
            join(&[
                key("Series "),
                s.id.clone(),
                key("; panel "),
                s.panel.clone(),
                key("; axis "),
                s.axis_id.clone().unwrap_or_else(|| key("default")),
                key("."),
            ])
        } else {
            key("No visible series.")
        };
        Ok(join(&[
            key("Bar "),
            key(&(index + 1).to_string()),
            key(" of "),
            key(&store.length().to_string()),
            key("; stored time "),
            num(self.time.expect("selected time"), chart, false),
            key(" UTC ms. "),
            selected,
            key(" "),
            key(if self.phase == "changed" {
                "Data or display changed. "
            } else {
                ""
            }),
            key("Press Enter to read current plotted values."),
        ])
        .slice(0, Some(4096)))
    }
    fn snapshot(&self, chart: &NativeChart) -> JsValue {
        object([
            ("active", JsValue::Bool(self.active)),
            ("time", self.time.map_or(JsValue::Null, JsValue::Number)),
            (
                "index",
                if self.active {
                    JsValue::Number(self.index(chart).map_or(-1.0, |n| n as f64))
                } else {
                    JsValue::Null
                },
            ),
            (
                "seriesId",
                self.series_id
                    .clone()
                    .map_or(JsValue::Null, JsValue::String),
            ),
            ("phase", JsValue::String(key(self.phase))),
            ("text", JsValue::String(self.text.clone())),
        ])
    }
    fn changed(&mut self, chart: &NativeChart) -> Result<(), JsError> {
        if !self.active {
            return Ok(());
        }
        let rows = Self::rows(chart)?;
        if !rows.iter().any(|s| self.series_id.as_ref() == Some(&s.id)) {
            self.series_id = rows.first().map(|s| s.id.clone());
        }
        self.phase = if self.index(chart).is_some() {
            "changed"
        } else {
            "missing"
        };
        self.text = self.selection_text(chart)?;
        Ok(())
    }
    fn set_active(&mut self, chart: &NativeChart, active: bool) -> Result<(), JsError> {
        self.active = active;
        self.phase = if active { "selected" } else { "off" };
        self.time = None;
        self.series_id = None;
        self.text = key("");
        if active {
            let store = chart.data().store();
            if store.length() > 0 {
                let index = chart.model().view.to.floor();
                let index = barochart_js::num::js_max(&[
                    0.0,
                    barochart_js::num::js_min(&[(store.length() - 1) as f64, index]),
                ]) as usize;
                self.time = Some(store.columns().time[index]);
            }
            self.series_id = Self::rows(chart)?.first().map(|s| s.id.clone());
            self.text = self.selection_text(chart)?;
        }
        Ok(())
    }
    fn navigate(&mut self, chart: &NativeChart, key_name: &str) -> Result<(), JsError> {
        if !self.active {
            return Err(error("Enable data exploration first"));
        }
        let store = chart.data().store();
        let rows = Self::rows(chart)?;
        let index = self.index(chart);
        match key_name {
            "Home" | "End" => {
                self.time = if store.length() > 0 {
                    Some(
                        store.columns().time[if key_name == "Home" {
                            0
                        } else {
                            store.length() - 1
                        }],
                    )
                } else {
                    None
                }
            }
            "ArrowLeft" | "ArrowRight" => {
                if let Some(index) = index {
                    let next = if key_name == "ArrowLeft" {
                        index.saturating_sub(1)
                    } else {
                        std::cmp::min(index + 1, store.length() - 1)
                    };
                    self.time = Some(store.columns().time[next]);
                }
            }
            _ => {
                let at = rows
                    .iter()
                    .position(|s| self.series_id.as_ref() == Some(&s.id))
                    .unwrap_or(0);
                let next = if key_name == "ArrowUp" {
                    at.saturating_sub(1)
                } else {
                    std::cmp::min(at + 1, rows.len().saturating_sub(1))
                };
                self.series_id = rows.get(next).map(|s| s.id.clone());
            }
        }
        if !rows.iter().any(|s| self.series_id.as_ref() == Some(&s.id)) {
            self.series_id = rows.first().map(|s| s.id.clone());
        }
        self.phase = if self.index(chart).is_some() {
            "selected"
        } else {
            "missing"
        };
        self.text = self.selection_text(chart)?;
        Ok(())
    }
    fn read(&mut self, chart: &mut NativeChart, host: &dyn Host) -> Result<(), JsError> {
        if !self.active {
            return Err(error("Enable data exploration first"));
        }
        if self.busy {
            return Err(error("Exploration read already running"));
        }
        if self.index(chart).is_none() {
            self.phase = "missing";
            self.text = self.selection_text(chart)?;
            return Ok(());
        }
        self.busy = true;
        let mut query = JsObject::new();
        query.insert(key("time"), JsValue::Number(self.time.expect("selected")));
        query.insert(key("match"), JsValue::String(key("exact")));
        let symbol = chart
            .symbol
            .as_ref()
            .map(|s| crate::data_explorer::ExplorerSymbol {
                id: s.id.clone(),
                currency: s.currency.clone(),
                volume_unit: s.volume_unit.clone(),
            });
        let result = crate::data_explorer::data_at(
            &chart.model,
            &mut chart.indicators,
            chart.ingestion.data().store(),
            host,
            &JsValue::Object(query),
            &JsValue::Object(JsObject::new()),
            symbol.as_ref(),
        );
        self.busy = false;
        let result = match result {
            Ok(value) => value,
            Err(e) => {
                self.phase = "error";
                self.text = key("Value read failed. Press Enter to retry.");
                return Err(e);
            }
        };
        let Some(result) = result else {
            self.phase = "missing";
            self.text = self.selection_text(chart)?;
            return Ok(());
        };
        let prefix = if let Some(s) = &result.symbol {
            join(&[
                s.id.clone(),
                key("; currency "),
                s.currency.clone(),
                key("; volume unit "),
                s.volume_unit.clone(),
                key(". "),
            ])
        } else {
            key("")
        };
        let b = result.bar;
        let mut parts = vec![
            prefix,
            key("Bar "),
            num(result.index + 1.0, chart, false),
            key("; stored time "),
            num(result.time, chart, false),
            key(" UTC ms. Open "),
            num(b.open, chart, true),
            key("; high "),
            num(b.high, chart, true),
            key("; low "),
            num(b.low, chart, true),
            key("; close "),
            num(b.close, chart, true),
            key("; volume "),
            num(b.volume, chart, true),
            key(". "),
        ];
        if let Some(row) = result
            .series
            .iter()
            .find(|s| self.series_id.as_ref() == Some(&s.id))
        {
            let raw = row.to_js_value();
            parts.extend([
                key("Series "),
                row.id.clone(),
                key("; panel "),
                row.panel.clone(),
                key("; axis "),
                row.axis_id.clone().unwrap_or_else(|| key("default")),
                key("; "),
                text_field(&raw, "status"),
                key("; value "),
                match field(&raw, "value") {
                    Some(JsValue::Number(n)) => num(*n, chart, true),
                    _ => key("unavailable"),
                },
                key("; plot offset "),
                nullable_num(field(&raw, "offset"), chart, "undefined"),
                key("; source index "),
                nullable_num(field(&raw, "sourceIndex"), chart, "none"),
                key("; source time "),
                nullable_num(field(&raw, "sourceTime"), chart, "none"),
                key(" UTC ms."),
            ]);
        } else {
            parts.push(key("No visible series."));
        }
        parts.extend([
            key(" Current plotted values, cutoff "),
            num(result.as_of_index, chart, false),
            key("; revised data, not historical arrival-time truth."),
        ]);
        self.phase = "read";
        self.text = join(&parts).slice(0, Some(4096));
        Ok(())
    }
    /// Wrapper는 action/input검증을 owner검사보다 먼저 한다.
    pub fn call(
        &mut self,
        chart: &mut NativeChart,
        host: &dyn Host,
        action: &str,
        arg: &JsValue,
    ) -> Result<JsValue, JsError> {
        match action {
            "setActive" => {
                let JsValue::Bool(active) = arg else {
                    return Err(JsError::new("TypeError", key("Exploration active boolean")));
                };
                self.set_active(chart, *active)?;
            }
            _ => {
                self.changed(chart)?;
                if action == "read" {
                    self.read(chart, host)?
                } else if action == "navigate" {
                    let JsValue::String(k) = arg else {
                        unreachable!("validated navigation")
                    };
                    self.navigate(chart, &k.to_string_lossy())?;
                }
            }
        };
        let mut out = JsObject::new();
        out.insert(
            key("schema"),
            JsValue::String(key("aster.native-data-exploration")),
        );
        out.insert(key("version"), JsValue::Number(1.0));
        if let JsValue::Object(state) = &self.snapshot(chart) {
            for (k, v) in state.iter() {
                out.insert(k.clone(), v.clone());
            }
        }
        Ok(JsValue::Object(out))
    }
}
