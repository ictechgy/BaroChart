# Native verification toolchain

Recorded 2026-11-01 for the native SDK commercial-readiness work
([design](superpowers/specs/2026-11-01-native-sdk-commercial-design.md)).
These are the tools that produced the native results in this cycle. They are
not minimum requirements for SDK consumers.

| Tool | Version / path |
| --- | --- |
| Host | macOS 26.7.2 (25G332), arm64 |
| Xcode | 27.0 (27A266a) |
| Swift | 6.4 (swiftlang-6.4.0.34.1) |
| iOS Simulator runtime | iOS 27.0 (24A434) |
| Node.js | 22.20.0 (`~/.nvm/versions/node/v22.20.0/bin/node`) |
| TypeScript | 5.9.3, installed with `--prefix artifacts/toolchain/typescript-5.9.3` |
| Gradle | 8.14.5 wrapper distribution (`~/.gradle/wrapper/dists/gradle-8.14.5-bin/*/gradle-8.14.5/bin/gradle`) |
| Android Gradle Plugin | 8.13.2 |
| JDK for Gradle | OpenJDK 17.0.20 (`/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`) |
| JDK for Java runners | OpenJDK 21.0.12 (`ASTER_JAVA`) |
| Android SDK | platforms 34–36, build-tools 36.0.0, NDK 29.0.14033849, CMake 3.22.1 |
| Android emulator | 36.1.9.0, AVD `aster-validation` (`system-images;android-36;google_apis_ps16k;arm64-v8a`, Pixel 8), console port 5580 |

## Environment conventions

| Variable | Value |
| --- | --- |
| `TSC_PATH` | `artifacts/toolchain/typescript-5.9.3/node_modules/typescript/lib/tsc.js` |
| `ASTER_GRADLE` | the Gradle 8.14.5 path above (scripts also discover it automatically) |
| `ASTER_GRADLE_JAVA_HOME` | the JDK 17 home above |
| `ASTER_ANDROID_SERIAL` | `emulator-5580` (`emulator -avd aster-validation -port 5580`) |
| `ANDROID_ADB_SERVER_PORT`, `ASTER_ADB_PORT`, `ASTER_ANDROID_ADB_PORT` | `5038`, a private adb server separate from the default 5037 |
| `ASTER_JAVA` | `/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java` |

## Bootstrap notes

- Homebrew Gradle 9.6.1 cannot configure AGP 8.x projects, and that includes
  `gradle wrapper`. The 8.14.5 wrapper was therefore generated in an empty
  project (`artifacts/toolchain/gradle-bootstrap`) and its distribution reused.
- `scripts/build-android-library.mjs` copies `~/.gradle/caches/modules-2` into
  an isolated Gradle home, so the cache had to be populated once by an online
  `assembleRelease` of `native/android/library` first.
- The dedicated AVD keeps other projects' emulators untouched. Hover, mobile-UX and
  ingestion runners accept only `emulator-5580` on adb server 5038, and the ingestion
  runner also checks the AVD name `aster-validation`. The host is
  arm64, so x86_64 Android binaries are executed only in CI (KVM), not locally.
- Free space on the data volume was 84 GiB when the work started.
