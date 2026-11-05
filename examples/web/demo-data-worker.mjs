import {makeDemoData, DATA_FIELDS} from './demo-data.mjs';

function errorMessage(error) {
  return String(error?.message ?? error).slice(0, 256);
}

self.onmessage = ({data}) => {
  try {
    const columns = makeDemoData({
      market: data?.market,
      count: data?.count,
      onProgress: progress => self.postMessage({progress}),
    });
    const transfer = DATA_FIELDS.map(key => columns[key].buffer);
    self.postMessage({schema: 'aster.demo-data-result', version: 1, market: data.market, count: data.count, columns}, transfer);
  } catch (error) {
    self.postMessage({error: errorMessage(error)});
  }
};
