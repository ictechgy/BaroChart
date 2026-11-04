use barochart_core::data::{Bar,ModelDataState,StoreOptions};
// 검증용 FFI fixture다. 실제 public Core aggregate를 실행하며 배포하지 않는다.
#[unsafe(no_mangle)]
pub extern "C" fn aggregate_probe()->u32 {
 let n=131_072usize;
 let bars=(0..n).map(|i|Bar{time:i as f64,open:1.0,high:2.0,low:0.0,close:1.0,volume:1.0}).collect();
 let state=ModelDataState::new(StoreOptions::default(),bars).unwrap();
 match state.store().aggregate(0.0,n as f64,65_536) {
  Ok(rows) if rows.len()==65_536 && rows[32_768].start==65_536 && rows.last().unwrap().end==n => n as u32,
  _=>0,
 }
}
