// JavaScriptCore companion for the layout oracle. Uses the same public API and scenarios.
import {layoutScenarios, runLayoutScenarios} from './layout-oracle-runtime.mjs';

const scenarios = JSON.parse(arguments[0] ?? '[]');
const rows = runLayoutScenarios(scenarios.length ? scenarios : layoutScenarios);
for (const row of rows) {
  print(JSON.stringify({scenarioId: row.scenarioId, expected: row.expected, error: row.error}));
}
