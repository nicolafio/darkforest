const { open } = require('fs/promises');
const { join } = require('path');

const TRACK_DATA_FILE_NAME = 'metrics.log';

module.exports.init = async function init(puppeteerPage, dataDir) {
  console.log('Initializing metrics');
  const metricsLogPath = join(dataDir, TRACK_DATA_FILE_NAME);
  const metricsLog = (await open(metricsLogPath, 'a')).createWriteStream();
  await trackMoveLag(puppeteerPage, metricsLog);
};

async function trackMoveLag(puppeteerPage, metricsLog) {
  await puppeteerPage.exposeFunction('DF_CLI_METRICS_LOG_MOVE_LAG', (lag) => {
    metricsLog.write(`${new Date()} MOVE_LAG_MILLISECONDS ${lag}\n`);
  });
  await puppeteerPage.evaluate(lagTrackingRuntimeLogic);
}

function lagTrackingRuntimeLogic() {
  const moveFn = window.df.move.bind(window.df);
  const txEndEvents = ['TxConfirmed', 'TxErrored', 'TxCancelled'];
  const { contractsAPI } = window.df;

  window.df.move = (...args) => {
    const startTime = Date.now();
    const txPromise = moveFn(...args);
    let ended = false;
    let tx;

    const onTx = (startedTx) => {
      tx = startedTx;
      startListeningTxEnd();
    };

    const onTxEnd = (endedTx) => {
      if (ended) {
        stopListeningTxEnd();
        return;
      }
      if (tx.hash === endedTx.hash) {
        ended = true;
        const endTime = Date.now();
        const lag = endTime - startTime;
        stopListeningTxEnd();
        window['DF_CLI_METRICS_LOG_MOVE_LAG'](lag);
      }
    };

    const startListeningTxEnd = () => {
      for (const endEvent of txEndEvents) contractsAPI.once(endEvent, onTxEnd);
    };

    const stopListeningTxEnd = () => {
      for (const endEvent of txEndEvents) contractsAPI.off(endEvent, onTxEnd);
    };

    txPromise.then(onTx, () => {});

    return txPromise;
  };
}
