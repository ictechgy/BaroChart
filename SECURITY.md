# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.3.x (pre-release) | Yes. Fixes land on `main` and the next release |
| 0.2.x and earlier | No. Upgrade to 0.3.x ([migration guide](docs/MIGRATING-FROM-ASTER.md)) |

After 1.0, the latest minor release of the current major version receives security fixes.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a suspected vulnerability.

Include the affected platform (web, iOS, Android), version or commit, a minimal reproduction, and the impact you observed. You will receive an acknowledgement within 5 business days and a status update at least every 14 days until the report is resolved. We credit reporters in the release notes unless you ask us not to.

## Scope

In scope: the chart core (`src/`), the native SDKs (`native/`, Swift and Android), the bundled QuickJS integration and the build/publishing scripts in this repository.

Out of scope: vulnerabilities in your app's data sources, network code or account systems (BaroChart never fetches data), and issues that require a modified copy of the SDK.

BaroChart evaluates only its bundled core and indicator modules that your app links explicitly; it never downloads or evaluates remote code. Report any path that would let untrusted chart data execute code.
