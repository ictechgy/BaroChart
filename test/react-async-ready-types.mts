import type {AsterChartProps} from 'barochart/react';

// Intentional negative consumer: tsc must reject both asynchronous setup forms.
export const rejectedAsyncReady: AsterChartProps = {
  onReady: async () => {throw new Error('unsupported async setup');},
};
export const promisedCleanup: AsterChartProps = {
  onReady: () => Promise.resolve(() => {}),
};
