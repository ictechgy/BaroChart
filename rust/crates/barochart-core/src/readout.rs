//! 실제 layout과 controller 해석을 사용하는 crosshair semantic readout이다.
use crate::scene::SceneAxisView;
use crate::scene_parts::{AxisFormatInput, format_axis_value};
use crate::{Host, crosshair_snap::CrosshairResolution, layout::Layout, native_chart::NativeChart};
use barochart_js::error::JsError;
use barochart_js::json::{JsObject, JsValue};
use barochart_js::num::js_round;
use barochart_js::string::JsString;
fn key(s: &str) -> JsString {
    JsString::from_str(s)
}
fn object<const N: usize>(fields: [(&str, JsValue); N]) -> JsValue {
    let mut value = JsObject::new();
    for (k, v) in fields {
        value.insert(key(k), v);
    }
    JsValue::Object(value)
}
fn field<'a>(value: &'a JsValue, name: &str) -> Option<&'a JsValue> {
    let JsValue::Object(value) = value else {
        return None;
    };
    value.get(&key(name))
}
fn symbol(value: Option<&JsString>) -> JsValue {
    value.cloned().map_or(JsValue::Null, JsValue::String)
}
/// 원본과 동일하게 visible series를 계산한 뒤 panel axis의 가격 단위를 더한다.
pub fn crosshair_values_at(
    chart: &mut NativeChart,
    host: &dyn Host,
    layout: &Layout,
    resolution: Option<&CrosshairResolution>,
) -> Result<JsValue, JsError> {
    let store = chart.ingestion.data().store();
    let Some(resolution) = resolution.filter(|_| store.length() > 0) else {
        return Ok(JsValue::Null);
    };
    let Some(panel) = layout.panels.iter().find(|p| p.id == resolution.panel) else {
        return Ok(JsValue::Null);
    };
    let index = if resolution.snapped {
        resolution.index.map_or(f64::NAN, |v| v as f64)
    } else {
        js_round(layout.index(chart.model.view, resolution.raw[0]))
    };
    if index < 0.0 || index >= store.length() as f64 {
        return Ok(JsValue::Null);
    }
    let bar = store.at(index as usize).expect("bounded bar");
    let columns = store.columns();
    let primary_symbol = chart.symbol.as_ref().map(|s| &s.id);
    let mut series = Vec::new();
    for s in chart.model.series.iter().filter(|s| s.visible) {
        let source_index = index - s.offset;
        let valid = source_index >= 0.0
            && source_index < (store.length() as f64)
            && source_index.fract() == 0.0;
        let raw = s.raw_record();
        let value = if let Some(values) = &s.values {
            if valid {
                values
                    .get(source_index as usize)
                    .copied()
                    .unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        } else if let Some(id) = &s.indicator {
            let read = chart
                .indicators
                .get(store, host, &JsValue::String(id.clone()))?;
            let output = s
                .output
                .as_ref()
                .map(JsString::to_string_lossy)
                .unwrap_or_else(|| {
                    read.definition()
                        .outputs
                        .first()
                        .expect("indicator output")
                        .to_string()
                });
            let values = read.output(&output);
            if valid {
                values
                    .and_then(|v| v.get(source_index as usize))
                    .copied()
                    .unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        } else {
            let source = match field(&raw, "source") {
                Some(JsValue::String(s)) => s.to_string_lossy(),
                _ => "close".to_owned(),
            };
            let values = match source.as_str() {
                "time" => &columns.time,
                "open" => &columns.open,
                "high" => &columns.high,
                "low" => &columns.low,
                "volume" => &columns.volume,
                _ => &columns.close,
            };
            if valid {
                values[source_index as usize]
            } else {
                f64::NAN
            }
        };
        let label = match field(&raw, "label") {
            Some(JsValue::String(value)) => value,
            _ => &s.id,
        };
        let symbol_id = if s.values.is_some() {
            match field(&raw, "symbolId") {
                Some(JsValue::String(value)) => Some(value),
                _ => None,
            }
        } else {
            primary_symbol
        };
        series.push(object([
            ("id", JsValue::String(s.id.clone())),
            ("label", JsValue::String(label.clone())),
            ("symbolId", symbol(symbol_id)),
            ("panel", JsValue::String(s.panel.clone())),
            ("axisId", symbol(s.axis_id.as_ref())),
            (
                "value",
                if value.is_finite() {
                    JsValue::Number(value)
                } else {
                    JsValue::Null
                },
            ),
            ("sourceIndex", JsValue::Number(source_index)),
            (
                "sourceTime",
                if value.is_finite() {
                    JsValue::Number(columns.time[source_index as usize])
                } else {
                    JsValue::Null
                },
            ),
        ]));
    }
    let axes = panel
        .axes
        .iter()
        .map(|axis| {
            let value =
                if resolution.snapped && resolution.axis_id.as_ref() == axis.axis_id.as_ref() {
                    resolution.price.unwrap_or(f64::NAN)
                } else {
                    axis.price(resolution.resolved[1])
                };
            let formatted = format_axis_value(
                AxisFormatInput {
                    id: &axis.id,
                    axis_id: axis.axis_id.as_ref(),
                    scale: axis.scale_kind(),
                    precision: axis.precision(),
                    model_precision: chart.model.precision as u32,
                    tick_format: axis.tick_format(),
                    prefix: axis.prefix(),
                    suffix: axis.suffix(),
                    projection: &axis.scale,
                    symbol: chart.symbol.as_ref(),
                },
                value,
                chart.dialect,
            );
            object([
                ("id", symbol(axis.axis_id.as_ref())),
                ("panel", JsValue::String(panel.id.clone())),
                ("value", JsValue::Number(value)),
                ("formatted", JsValue::String(formatted)),
            ])
        })
        .collect();
    Ok(object([
        ("index", JsValue::Number(index)),
        ("time", JsValue::Number(bar.time)),
        (
            "primary",
            object([
                ("symbolId", symbol(primary_symbol)),
                (
                    "bar",
                    object([
                        ("time", JsValue::Number(bar.time)),
                        ("open", JsValue::Number(bar.open)),
                        ("high", JsValue::Number(bar.high)),
                        ("low", JsValue::Number(bar.low)),
                        ("close", JsValue::Number(bar.close)),
                        ("volume", JsValue::Number(bar.volume)),
                    ]),
                ),
            ]),
        ),
        ("series", JsValue::Array(series)),
        ("axes", JsValue::Array(axes)),
    ]))
}

fn concat(parts: &[JsString], separator: &str) -> JsString {
    let mut units = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        if i != 0 {
            units.extend(separator.encode_utf16());
        }
        units.extend_from_slice(part.as_units());
    }
    JsString::from_utf16(units)
}
fn string_field(value: &JsValue, name: &str) -> Option<JsString> {
    match field(value, name) {
        Some(JsValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}
/// Native accessibility는 scene과 같은 semantic 가격·label 정보를 사용한다.
pub fn accessibility(
    chart: &NativeChart,
    input: &crate::interaction::OwnedInteractionState,
    crosshair: JsValue,
) -> Result<JsValue, JsError> {
    let store = chart.data().store();
    let last = if store.length() == 0 {
        None
    } else {
        Some(store.at(store.length() - 1)?)
    };
    let close = if let Some(bar) = last {
        key(&if let Some(symbol) = chart.symbol() {
            crate::markets::format_price(bar.close, symbol, chart.dialect())
        } else {
            barochart_js::num::to_precision(bar.close, 15)
        })
    } else {
        key("No data")
    };
    let selected = chart
        .drawings()
        .items()
        .iter()
        .find(|d| chart.drawings().selected() == Some(&d.id));
    let selection = selected.map_or_else(
        || key("No selection"),
        |d| {
            key(&format!(
                "{} {}",
                d.kind.as_js(),
                if d.locked == Some(true) {
                    "locked"
                } else {
                    "editable"
                }
            ))
        },
    );
    let tool = input.tool().clone();
    let mut panels = Vec::new();
    let mut panel_readouts = Vec::new();
    for p in &chart.model().panels {
        let title = string_field(&p.to_js_value(), "label").unwrap_or_else(|| p.id.clone());
        let mut rows = Vec::new();
        let mut labels = Vec::new();
        for series in chart
            .model()
            .series
            .iter()
            .filter(|s| s.panel == p.id && s.visible)
        {
            let label = string_field(&series.raw_record(), "label")
                .or_else(|| series.indicator.clone())
                .unwrap_or_else(|| series.id.clone());
            labels.push(label.clone());
            let mut value = JsObject::new();
            value.insert(key("id"), JsValue::String(series.id.clone()));
            value.insert(key("label"), JsValue::String(label));
            if let Some(id) = &series.indicator {
                value.insert(key("indicator"), JsValue::String(id.clone()));
            }
            rows.push(JsValue::Object(value));
        }
        panel_readouts.push(concat(
            &[title.clone(), key(": "), concat(&labels, ", ")],
            "",
        ));
        panels.push(object([
            ("id", JsValue::String(p.id.clone())),
            ("title", JsValue::String(title)),
            ("series", JsValue::Array(rows)),
        ]));
    }
    let mut readout = vec![concat(
        &[
            key(&store.length().to_string()),
            key(" bars. Close "),
            close.clone(),
            key(". "),
            selection.clone(),
            key(". Tool "),
            tool.clone(),
            key("."),
        ],
        "",
    )];
    readout.extend(panel_readouts);
    if let JsValue::Object(_) = &crosshair {
        if let Some(JsValue::Number(time)) = field(&crosshair, "time") {
            let iso = barochart_js::date::to_iso_string(*time)
                .ok_or_else(|| JsError::new("RangeError", key("Invalid time value")))?;
            readout.push(key(&format!("Time {iso}")));
        }
        if let Some(JsValue::Array(axes)) = field(&crosshair, "axes") {
            for axis in axes {
                let id = string_field(axis, "id")
                    .or_else(|| string_field(axis, "panel"))
                    .expect("axis label");
                let formatted = string_field(axis, "formatted").expect("formatted axis");
                readout.push(concat(&[id, key(": "), formatted], ""));
            }
        }
        if let Some(JsValue::Array(series)) = field(&crosshair, "series") {
            for series in series {
                let label = string_field(series, "label").expect("series label");
                let value = match field(series, "value") {
                    Some(JsValue::Number(value)) => key(&barochart_js::num::number_to_string_with(
                        *value,
                        chart.dialect(),
                    )),
                    _ => key("gap"),
                };
                readout.push(concat(&[label, key(": "), value], ""));
            }
        }
    }
    Ok(object([
        ("bars", JsValue::Number(store.length() as f64)),
        ("close", JsValue::String(close)),
        ("selection", JsValue::String(selection)),
        ("tool", JsValue::String(tool)),
        ("panels", JsValue::Array(panels)),
        ("crosshair", crosshair),
        ("readout", JsValue::String(concat(&readout, ". "))),
    ]))
}

/// UIKit/Android가 공유하는 접근성 문자열의 플랫폼별 결합 순서다.
pub fn accessibility_text(summary: &JsValue, platform: &JsValue) -> Result<JsString, JsError> {
    let platform = match platform {
        JsValue::String(value) if value == &key("android") => "android",
        JsValue::String(value) if value == &key("uikit") => "uikit",
        _ => {
            return Err(JsError::new(
                "TypeError",
                key("Accessibility text platform"),
            ));
        }
    };
    if platform == "android" {
        return Ok(string_field(summary, "readout").expect("summary readout"));
    }
    let bars = match field(summary, "bars") {
        Some(JsValue::Number(value)) => *value,
        _ => unreachable!("bars"),
    };
    let titles = match field(summary, "panels") {
        Some(JsValue::Array(panels)) => panels
            .iter()
            .map(|p| string_field(p, "title").expect("title"))
            .collect::<Vec<_>>(),
        _ => unreachable!("panels"),
    };
    Ok(concat(
        &[
            key(&format!(
                "{} bars",
                barochart_js::num::number_to_string(bars)
            )),
            concat(&titles, "; "),
            string_field(summary, "readout").expect("readout"),
            string_field(summary, "selection").expect("selection"),
            concat(
                &[key("tool "), string_field(summary, "tool").expect("tool")],
                "",
            ),
        ]
        .into_iter()
        .filter(|v| !v.as_units().is_empty())
        .collect::<Vec<_>>(),
        "; ",
    ))
}
