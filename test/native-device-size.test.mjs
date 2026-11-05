import assert from 'node:assert/strict';
import test from 'node:test';

import {sdkCodeBytesFromLinkMap} from '../scripts/native-device-size.mjs';

test('iOS SDK size includes linked Rust archive symbols alongside Swift symbols',()=>{
 const map=`# Object files:
[  0] linker synthesized
[  1] /build/BaroChart.build/Objects-normal/arm64/BaroChartEngine.o
[  2] /package/BaroChartCoreRust.xcframework/ios-arm64/libbarochart_ffi.a(barochart_core.o)
[  3] /build/BaroChartSample.build/Objects-normal/arm64/App.o
[  4] /usr/lib/libSystem.tbd
# Sections:
0x100000000 0x000000F0 __TEXT __text
# Symbols:
# Address Size File Name
0x100000000 0x00000020 [  1] swiftEngine
0x100000020 0x00000080 [  2] rustEngine
0x1000000A0 0x00000030 [  3] app
0x1000000D0 0x00000020 [  4] system
# Dead Stripped Symbols:
0x000000000 0x00001000 [  2] unusedRust
`;
 assert.equal(sdkCodeBytesFromLinkMap(map),160);
});

test('iOS SDK accounting accepts indexed archive members and counts overlapping aliases once',()=>{
 const map=`# Object files:
[  1] /build/BaroChart.o
[  2] /package/libbarochart_ffi.a[6](alloc.o)
[  3] /package/not_barochart_ffi.a[2](other.o)
# Symbols:
0x100000000 0x00000020 [  1] swift
0x100000020 0x00000040 [  2] rust
0x100000020 0x00000040 [  2] alias
0x100000060 0x00000040 [  3] other
`;
 assert.equal(sdkCodeBytesFromLinkMap(map),96);
});
