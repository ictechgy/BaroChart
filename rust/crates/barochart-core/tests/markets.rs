use std::sync::{Arc, Mutex};

use barochart_core::{Host, HostError};
use barochart_js::date::date_utc;
use barochart_js::error::JsError;
use barochart_js::num::NumberDialect;
use barochart_js::string::JsString;

use barochart_core::markets;

use markets::{
    Adjustment, CalendarInterval, CalendarProvider, SessionCalendar, SessionWindowInput, Symbol,
    TimeZoneCache, format_price, market_date, shift_date, validate_symbol, zoned_epoch,
    zoned_parts, zoned_parts_cached,
};

#[derive(Default)]
struct FixedHost {
    calls: Mutex<Vec<(String, String, Option<u64>)>>,
}

impl FixedHost {
    fn calls(&self) -> Vec<(String, String, Option<u64>)> {
        self.calls.lock().unwrap().clone()
    }
}

impl Host for FixedHost {
    fn zone_resolve(&self, name: &JsString) -> Result<JsString, HostError> {
        let original = name.to_string_lossy();
        self.calls
            .lock()
            .unwrap()
            .push(("resolve".into(), original.clone(), None));
        let canonical = match original.to_ascii_lowercase().as_str() {
            "utc" => "UTC",
            "america/new_york" => "America/New_York",
            "america/santiago" => "America/Santiago",
            "asia/seoul" => "Asia/Seoul",
            "etc/gmt-14" => "Etc/GMT-14",
            "etc/gmt+12" => "Etc/GMT+12",
            "late/failure" => "Late/Failure",
            value if value.starts_with("zone/") => return Ok(JsString::from_str(&original)),
            _ => return Err(HostError),
        };
        Ok(JsString::from_str(canonical))
    }

    fn zone_offset_seconds(&self, zone: &JsString, epoch_ms: f64) -> Result<i32, HostError> {
        let zone = zone.to_string_lossy();
        self.calls
            .lock()
            .unwrap()
            .push(("offset".into(), zone.clone(), Some(epoch_ms.to_bits())));
        let offset = match zone.as_str() {
            "UTC" => 0,
            "Asia/Seoul" => 9 * 3600,
            "Etc/GMT-14" => 14 * 3600,
            "Etc/GMT+12" => -12 * 3600,
            "America/New_York" => {
                let spring = date_utc(2026.0, 2.0, 8.0, 7.0, 0.0, 0.0, 0.0);
                let fall = date_utc(2026.0, 10.0, 1.0, 6.0, 0.0, 0.0, 0.0);
                if epoch_ms >= spring && epoch_ms < fall {
                    -4 * 3600
                } else {
                    -5 * 3600
                }
            }
            "America/Santiago" => {
                let change = date_utc(2026.0, 8.0, 6.0, 4.0, 0.0, 0.0, 0.0);
                if epoch_ms < change {
                    -4 * 3600
                } else {
                    -3 * 3600
                }
            }
            value if value.starts_with("Zone/") || value.starts_with("zone/") => 0,
            _ => return Err(HostError),
        };
        Ok(offset)
    }

    fn log(&self, _level: i32, _message: &str) {}
}

fn error(result: Result<impl Sized, JsError>) -> (String, String) {
    let error = result.err().expect("expected error");
    (error.name.into(), error.message.to_string_lossy())
}

fn text(value: &str) -> JsString {
    JsString::from_str(value)
}

#[test]
fn fixed_offsets_clip_before_conversion_without_calling_host() {
    let host = FixedHost::default();
    let parts = zoned_parts(&host, -0.5, &text("+05:30")).unwrap();
    assert_eq!(parts.as_array(), ["1970", "01", "01", "05", "30", "00"]);
    assert!(host.calls().is_empty());
    assert_eq!(
        zoned_parts(&host, 1_773_063_000_000.0, &text("-03:30"))
            .unwrap()
            .as_array(),
        ["2026", "03", "09", "10", "00", "00"]
    );
}

#[test]
fn timezone_validation_precedes_host_and_truncates_unsupported_name_in_utf16() {
    let host = FixedHost::default();
    assert_eq!(
        error(zoned_parts(&host, f64::NAN, &text("Z"))),
        (
            "RangeError".into(),
            "Time zone conversion requires a finite time".into()
        )
    );
    assert_eq!(
        error(zoned_parts(&host, 0.0, &text("UTC+9"))),
        ("RangeError".into(), "Unsupported time zone: UTC+9".into())
    );
    let mut long = vec![u16::from(b'A'); 63];
    long.extend([0xd83d, 0xde00, u16::from(b'Z')]);
    let bad = JsString::from_utf16(long);
    let failure = zoned_parts(&host, 0.0, &bad).unwrap_err();
    assert_eq!(failure.name, "RangeError");
    let units = failure.message.as_units();
    assert_eq!(
        &units[.."Unsupported time zone: ".encode_utf16().count()],
        &"Unsupported time zone: ".encode_utf16().collect::<Vec<_>>()
    );
    assert_eq!(
        units.last(),
        Some(&0xd83d),
        "slice is exactly 64 UTF-16 units"
    );
    assert!(host.calls().is_empty());
}

#[test]
fn named_zone_uses_canonical_name_and_timeclipped_epoch() {
    let host = FixedHost::default();
    let result = zoned_parts(&host, -0.5, &text("asia/seoul")).unwrap();
    assert_eq!(result.as_array(), ["1970", "01", "01", "09", "00", "00"]);
    assert_eq!(
        host.calls(),
        vec![
            ("resolve".into(), "asia/seoul".into(), None),
            ("offset".into(), "Asia/Seoul".into(), Some(0.0f64.to_bits()))
        ]
    );
}

#[test]
fn successful_named_zones_use_a_casefolded_bounded_lru_cache() {
    let host = FixedHost::default();
    let mut cache = TimeZoneCache::default();
    assert!(cache.is_empty());
    for index in 0..32 {
        zoned_parts_cached(&host, 0.0, &text(&format!("Zone/{index}")), &mut cache).unwrap();
    }
    assert_eq!(cache.len(), 32);
    zoned_parts_cached(&host, 0.0, &text("zone/0"), &mut cache).unwrap();
    assert_eq!(
        host.calls()
            .iter()
            .filter(|(kind, _, _)| kind == "resolve")
            .count(),
        32
    );
    zoned_parts_cached(&host, 0.0, &text("Zone/32"), &mut cache).unwrap();
    zoned_parts_cached(&host, 0.0, &text("Zone/1"), &mut cache).unwrap();
    assert_eq!(cache.len(), 32);
    assert_eq!(
        host.calls()
            .iter()
            .filter(|(kind, _, _)| kind == "resolve")
            .count(),
        34,
        "refreshing Zone/0 evicts Zone/1 after the 33rd insertion"
    );
}

#[test]
fn named_zone_failures_and_local_year_edges_keep_stable_errors() {
    let host = FixedHost::default();
    let mut cache = TimeZoneCache::default();
    for _ in 0..2 {
        assert_eq!(
            error(zoned_parts_cached(
                &host,
                0.0,
                &text("Missing/Timezone"),
                &mut cache
            )),
            (
                "RangeError".into(),
                "Unsupported time zone: Missing/Timezone".into()
            )
        );
    }
    let year_1000 = date_utc(1000.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0);
    assert_eq!(
        error(zoned_parts(&host, year_1000, &text("Etc/GMT+12"))),
        (
            "RangeError".into(),
            "Time zone conversion year out of range".into()
        )
    );
    let resolve_calls = host
        .calls()
        .iter()
        .filter(|(kind, name, _)| kind == "resolve" && name == "Missing/Timezone")
        .count();
    assert_eq!(
        resolve_calls, 2,
        "failed names are not retained by the cache"
    );

    let mut late_cache = TimeZoneCache::default();
    for _ in 0..2 {
        assert_eq!(
            error(zoned_parts_cached(
                &host,
                0.0,
                &text("Late/Failure"),
                &mut late_cache
            )),
            (
                "RangeError".into(),
                "Unsupported time zone: Late/Failure".into()
            )
        );
    }
    assert!(late_cache.is_empty(), "late host failures are not cached");
    assert_eq!(
        host.calls()
            .iter()
            .filter(|(kind, name, _)| kind == "resolve" && name == "Late/Failure")
            .count(),
        2
    );
}

#[test]
fn zoned_epoch_matches_gap_fold_and_strict_parsers() {
    let host = FixedHost::default();
    assert_eq!(
        zoned_epoch(
            &host,
            "2026-03-09",
            "09:30",
            &text("America/New_York"),
            "earlier"
        )
        .unwrap(),
        1_773_063_000_000.0
    );
    assert_eq!(
        error(zoned_epoch(
            &host,
            "2026-03-08",
            "02:30",
            &text("America/New_York"),
            "earlier"
        )),
        (
            "RangeError".into(),
            "Nonexistent local time at DST boundary".into()
        )
    );
    assert_eq!(
        zoned_epoch(
            &host,
            "2026-11-01",
            "01:30",
            &text("America/New_York"),
            "earlier"
        )
        .unwrap(),
        1_793_511_000_000.0
    );
    assert_eq!(
        zoned_epoch(
            &host,
            "2026-11-01",
            "01:30",
            &text("America/New_York"),
            "later"
        )
        .unwrap(),
        1_793_514_600_000.0
    );
    assert_eq!(
        error(zoned_epoch(
            &host,
            "2026-11-01",
            "01:30",
            &text("America/New_York"),
            "reject"
        )),
        ("RangeError".into(), "Ambiguous local time".into())
    );
    assert_eq!(
        error(zoned_epoch(
            &host,
            "2026-02-30",
            "09:30",
            &text("UTC"),
            "earlier"
        )),
        (
            "TypeError".into(),
            "ISO date and HH:mm[:ss] required".into()
        )
    );
}

#[test]
fn zoned_epoch_keeps_the_three_sample_supported_year_edges() {
    let host = FixedHost::default();
    assert_eq!(
        zoned_epoch(&host, "1000-01-01", "14:00", &text("Etc/GMT-14"), "earlier").unwrap(),
        date_utc(1000.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0)
    );
    assert_eq!(
        error(zoned_epoch(
            &host,
            "1000-01-01",
            "00:00",
            &text("UTC"),
            "earlier"
        )),
        (
            "RangeError".into(),
            "Time zone conversion year out of range".into()
        )
    );
    assert_eq!(
        error(zoned_epoch(
            &host,
            "9999-12-31",
            "00:00",
            &text("UTC"),
            "earlier"
        )),
        (
            "RangeError".into(),
            "Time zone conversion year out of range".into()
        )
    );
}

#[test]
fn market_date_and_shift_date_follow_gregorian_supported_years() {
    let host = FixedHost::default();
    assert_eq!(
        market_date(&host, 1_773_063_000_000.0, &text("America/New_York")).unwrap(),
        "2026-03-09"
    );
    assert_eq!(shift_date("2024-02-28", 1.0).unwrap(), "2024-02-29");
    assert_eq!(shift_date("1900-02-28", 1.0).unwrap(), "1900-03-01");
    assert_eq!(shift_date("2026-03-01", -1.0).unwrap(), "2026-02-28");
    assert_eq!(
        error(shift_date("2026-02-30", 1.0)),
        ("TypeError".into(), "ISO date required".into())
    );
    assert_eq!(
        error(shift_date("9999-12-31", 1.0)),
        (
            "RangeError".into(),
            "Time zone conversion year out of range".into()
        )
    );
}

fn symbol(timezone: &str) -> Symbol {
    Symbol {
        id: text("SYNTH:US"),
        exchange: text("SYNTH-US"),
        timezone: text(timezone),
        currency: text("USD"),
        volume_unit: text("shares"),
        price_decimals: 2,
        tick_size: 0.01,
        adjustment: Adjustment::Raw,
    }
}

#[test]
fn symbol_validation_checks_metadata_before_timezone_and_price_uses_dialect() {
    let host = FixedHost::default();
    let mut bad = symbol("Missing/Timezone");
    bad.price_decimals = 19;
    assert_eq!(
        error(validate_symbol(&host, bad)),
        ("TypeError".into(), "Invalid symbol metadata".into())
    );
    assert!(host.calls().is_empty());
    let valid = validate_symbol(&host, symbol("america/new_york")).unwrap();
    assert_eq!(format_price(0.125, &valid, NumberDialect::Ecma), "0.13");
    assert_eq!(format_price(-0.0, &valid, NumberDialect::QuickJs), "0.00");
}

#[derive(Default)]
struct WindowsProvider {
    calls: usize,
}

impl CalendarProvider for WindowsProvider {
    fn windows(&mut self, date: &str) -> Result<Vec<SessionWindowInput>, JsError> {
        self.calls += 1;
        let windows = match date {
            "2026-03-09" => vec![SessionWindowInput::new("09:30", "16:00", "regular")],
            "2026-01-31" => vec![SessionWindowInput::new("22:00", "02:00", "regular")],
            "2026-09-06" => vec![SessionWindowInput::new("09:00", "17:00", "regular")],
            _ => Vec::new(),
        };
        Ok(windows)
    }
}

#[test]
fn session_calendar_caches_windows_and_invalidates_fifo_state() {
    let host = FixedHost::default();
    let mut calendar = SessionCalendar::new(
        &host,
        text("America/New_York"),
        WindowsProvider::default(),
        2,
    )
    .unwrap();
    let first = calendar.sessions(&host, "2026-03-09").unwrap();
    let second = calendar.sessions(&host, "2026-03-09").unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(calendar.provider().calls, 1);
    calendar.invalidate();
    let third = calendar.sessions(&host, "2026-03-09").unwrap();
    assert!(!Arc::ptr_eq(&first, &third));
    assert_eq!(calendar.provider().calls, 2);

    let mut bounded =
        SessionCalendar::new(&host, text("UTC"), WindowsProvider::default(), 1).unwrap();
    bounded.sessions(&host, "2026-03-09").unwrap();
    bounded.sessions(&host, "2026-03-10").unwrap();
    bounded.sessions(&host, "2026-03-09").unwrap();
    assert_eq!(bounded.provider().calls, 3, "session cache is FIFO bounded");
}

#[test]
fn session_calendar_handles_overnight_at_and_numeric_buckets() {
    let host = FixedHost::default();
    let mut calendar =
        SessionCalendar::new(&host, text("UTC"), WindowsProvider::default(), 8).unwrap();
    let time = date_utc(2026.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0);
    let session = calendar
        .at(&host, time, &[text("regular")])
        .unwrap()
        .unwrap();
    assert_eq!(session.date, "2026-01-31");
    let bucket = calendar
        .bucket(
            &host,
            time,
            &CalendarInterval::Milliseconds(3_600_000.0),
            &[text("regular")],
        )
        .unwrap()
        .unwrap();
    assert_eq!(bucket.time, time);
    assert_eq!(bucket.session_date, "2026-01-31");
    assert_eq!(
        calendar
            .bucket(&host, time, &CalendarInterval::Week, &[text("regular")],)
            .unwrap()
            .unwrap()
            .time,
        date_utc(2026.0, 0.0, 26.0, 0.0, 0.0, 0.0, 0.0)
    );
    assert_eq!(
        calendar
            .bucket(&host, time, &CalendarInterval::Month, &[text("regular")],)
            .unwrap()
            .unwrap()
            .time,
        date_utc(2026.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0)
    );
}

#[test]
fn local_date_anchor_recovers_santiago_midnight_gap_only_for_calendar_bucket() {
    let host = FixedHost::default();
    assert_eq!(
        error(zoned_epoch(
            &host,
            "2026-09-06",
            "00:00",
            &text("America/Santiago"),
            "earlier"
        )),
        (
            "RangeError".into(),
            "Nonexistent local time at DST boundary".into()
        )
    );
    let mut calendar = SessionCalendar::new(
        &host,
        text("America/Santiago"),
        WindowsProvider::default(),
        8,
    )
    .unwrap();
    let time = date_utc(2026.0, 8.0, 6.0, 13.0, 0.0, 0.0, 0.0);
    let bucket = calendar
        .bucket(&host, time, &CalendarInterval::Day, &[text("regular")])
        .unwrap()
        .unwrap();
    assert_eq!(bucket.time, date_utc(2026.0, 8.0, 6.0, 4.0, 0.0, 0.0, 0.0));
}

#[test]
fn calendar_rejects_overlap_and_unknown_interval_with_exact_messages() {
    struct Overlap;
    impl CalendarProvider for Overlap {
        fn windows(&mut self, _date: &str) -> Result<Vec<SessionWindowInput>, JsError> {
            Ok(vec![
                SessionWindowInput::new("09:00", "12:00", "regular"),
                SessionWindowInput::new("11:00", "16:00", "regular"),
            ])
        }
    }
    let host = FixedHost::default();
    let mut calendar = SessionCalendar::new(&host, text("UTC"), Overlap, 1).unwrap();
    assert_eq!(
        error(calendar.sessions(&host, "2026-03-09")),
        (
            "RangeError".into(),
            "Ordered nonoverlapping sessions required".into()
        )
    );
    let mut calendar =
        SessionCalendar::new(&host, text("UTC"), WindowsProvider::default(), 1).unwrap();
    let time = date_utc(2026.0, 2.0, 9.0, 10.0, 0.0, 0.0, 0.0);
    assert_eq!(
        error(calendar.bucket(
            &host,
            time,
            &CalendarInterval::Named(text("quarter")),
            &[text("regular")]
        )),
        (
            "TypeError".into(),
            "Interval is milliseconds/day/week/month".into()
        )
    );
}

#[test]
fn adjustment_variants_are_distinct_contract_values() {
    assert_ne!(Adjustment::Raw, Adjustment::Split);
    assert_ne!(Adjustment::Split, Adjustment::TotalReturn);
}
