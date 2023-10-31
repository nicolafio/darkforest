const { unlink } = require('fs/promises');
const { argv, stdin, stdout, exit } = require('process');
const { once } = require('events');
const { join } = require('path');
const puppeteer = require('puppeteer');
const readline = require('readline');
const HDWallet = require('ethereum-hdwallet');
const { privateToAddress, stripHexPrefix, addHexPrefix, bufferToHex } = require('ethereumjs-util');

const DEFAULT_HTTP_CLIENT_HOST = 'localhost';
const DEFAULT_HTTP_CLIENT_PORT = 8081;

const HD_KEYS_MNEMONIC = 'change typical hire slam amateur loan grid fix drama electric seed label';
const HD_KEYS_PATH = "m/44'/60'/0'/0";
const DATA_DIR = join(__dirname, '.data');

const GAME_TERMINAL_INPUT_CSS_SELECTOR = '[class*="Terminal"] textarea';

const REQUEST_PRIVATE_KEY_COMMAND = 'id';
const REQUEST_METRICS_COMMAND = 'meter';
const REQUEST_BROWSER_COMMAND = 'browser';

async function main() {
  const parameters = getParameters();

  if (parameters.requestingPrivateKey) {
    console.log(parameters.privateKey);
    return;
  }

  const privKeyBuf = Buffer.from(stripHexPrefix(parameters.privateKey), 'hex');
  const userAddress = addHexPrefix(bufferToHex(privateToAddress(privKeyBuf)));
  const userDataDir = join(DATA_DIR, userAddress);

  try {
    // https://github.com/puppeteer/puppeteer/issues/10517
    await unlink(join(userDataDir, 'SingletonLock'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  const browser = await puppeteer.launch({
    headless: parameters.requestingBrowser ? false : 'new',
    userDataDir,
    args: ['--no-sandbox'],
  });

  process.on('exit', (code) => {
    browser
      .close()
      .catch(console.error)
      .finally(() => {
        process.exit(code);
      });
  });

  const page = await browser.newPage();

  await navigateToLandingPage(page, parameters.host, parameters.port);
  await enterInGameRound(page);

  handleUnknownErrors(page).catch(handleAsFatalError);
  handleOutOfMoneyCase(page).catch(handleAsFatalError);
  handleGameJoinFail(page).catch(handleAsFatalError);

  await connectToDarkForestContract(page, parameters.privateKey);

  console.log('Connected to Dark Forest');

  await forwardGameTerminalOutputToStdout(page);

  require('./custom-fns').init(page).catch(handleAsFatalError);

  if (parameters.requestingMetrics)
    require('./metrics').init(page, userDataDir).catch(handleAsFatalError);

  const sideTasksAC = new AbortController();

  handleMissingHomeCoords(page, sideTasksAC.signal).catch(handleAsFatalError);

  findHomePlanetIfAsked(page, sideTasksAC.signal).catch(handleAsFatalError);

  await page.waitForSelector('text/Press ENTER to begin', { timeout: 0 });

  sideTasksAC.abort();
  await page.focus(GAME_TERMINAL_INPUT_CSS_SELECTOR);
  await page.keyboard.press('Enter');

  const input = readline.createInterface({
    input: stdin,
    output: stdout,
    prompt: '> ',
  });

  while (true) {
    stdout.write('> ');
    const line = await once(input, 'line');
    clearStdoutLine();
    await inputLineToGameTerminal(page, `with (dfcli) { ${line} }`);
  }
}

async function navigateToLandingPage(page, host, port) {
  const landingPageURL = `http://${host}:${port}`;
  console.log(`Navigating to ${landingPageURL}...`);
  let waitTime = 0;
  const maxWaitTime = 1000;
  while (true) {
    try {
      await page.goto(landingPageURL);
      return;
    } catch (e) {
      if (!isConnectionRefusedError(e)) throw e;
    }
    await new Promise((res) => {
      setTimeout(res, waitTime);
    });
    waitTime *= 2;
    if (waitTime === 0) waitTime = 1;
    if (waitTime > maxWaitTime) waitTime = maxWaitTime;
  }
}

function isConnectionRefusedError(error) {
  if (error.code === 'ECONNREFUSED') return true;
  if (String(error).includes('CONNECTION_REFUSED')) return true;
  return false;
}

async function enterInGameRound(page) {
  const btn = await page.waitForSelector('df-button::-p-text("Enter Round")');
  await Promise.all([page.waitForNavigation(), btn.click()]);
}

async function connectToDarkForestContract(page, privateKey) {
  await page.waitForSelector('text/(i) Import private key.');
  await page.waitForSelector(GAME_TERMINAL_INPUT_CSS_SELECTOR);
  await inputLineToGameTerminal(page, 'i');

  await page.waitForSelector('text/Enter the 0x-prefixed private key');
  await inputLineToGameTerminal(page, privateKey);

  await page.waitForSelector('text/Connected to Dark Forest');
}

async function handleMissingHomeCoords(page, signal) {
  const importKeyMsg = 'Import account home coordinates? (y/n)';
  try {
    await waitForSelectorForever(page, 'text/' + importKeyMsg, { signal });
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }
  if (signal.aborted) return;
  console.error('Home coordinates missing. Have you deleted session data?');
  console.error('Terminating.');
  exit(1);
}

async function findHomePlanetIfAsked(page, signal) {
  const findHomePlanetMsg = 'Press ENTER to find a home planet.';
  try {
    await waitForSelectorForever(page, `text/` + findHomePlanetMsg, { signal });
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }
  if (signal.aborted) return;
  await page.focus('textarea');
  await page.keyboard.press('Enter');
}

async function forwardGameTerminalOutputToStdout(page) {
  await page.exposeFunction('DF_CLI_PRINT', (str) => {
    stdout.write(str);
  });
  await page.exposeFunction('DF_CLI_RM_LINE', () => {
    clearStdoutLine();
  });
  await page.exposeFunction('DF_CLI_NEW_LINE', () => {
    stdout.write('\n');
  });
  await page.evaluate(() => {
    const outputEmitter = window.df.terminal.current.getOutputEmitter();
    outputEmitter.on('ON_OUTPUT', (output) => {
      if (output.type === 'print') window['DF_CLI_PRINT'](output.str);
      if (output.type === 'remove-line') window['DF_CLI_RM_LINE']();
      if (output.type === 'new-line') window['DF_CLI_NEW_LINE']();
    });
  });
}

async function inputLineToGameTerminal(page, line) {
  await page.focus(GAME_TERMINAL_INPUT_CSS_SELECTOR);
  await page.type(GAME_TERMINAL_INPUT_CSS_SELECTOR, line);
  await page.keyboard.press('Enter');
}

function clearStdoutLine() {
  stdout.moveCursor(0, -1);
  stdout.clearLine(1);
}

function handleAsFatalError(err) {
  console.error(err);
  process.exit(1);
}

function getParameters() {
  const args = argv.slice(2);
  let privateKey;

  const playerIndex = args.find((a) => /[0-9]+/.test(a));
  const playerIndexGiven = typeof playerIndex === 'string';
  const requestingPrivateKey = args.includes(REQUEST_PRIVATE_KEY_COMMAND);
  const requestingMetrics = args.includes(REQUEST_METRICS_COMMAND);
  const requestingBrowser = args.includes(REQUEST_BROWSER_COMMAND);

  if (playerIndexGiven) privateKey = getPrivateKeyFromPlayerIndex(playerIndex);
  if (!privateKey) privateKey = args.find((a) => a.startsWith('0x'));
  if (!privateKey) privateKey = getPrivateKeyFromPlayerIndex(0);

  const [host, port] = args.find((a) => a.includes(':'))?.split(':') || [
    DEFAULT_HTTP_CLIENT_HOST,
    DEFAULT_HTTP_CLIENT_PORT,
  ];

  return {
    privateKey,
    host,
    port,
    requestingPrivateKey,
    requestingMetrics,
    requestingBrowser,
  };
}

function getPrivateKeyFromPlayerIndex(index) {
  return addHexPrefix(
    HDWallet.fromMnemonic(HD_KEYS_MNEMONIC)
      .derive(HD_KEYS_PATH)
      .derive(index)
      .getPrivateKey()
      .toString('hex')
  );
}

async function handleUnknownErrors(page) {
  await waitForSelectorForever(page, 'text/An unknown error occurred.');
  handleAsFatalError('Unkown error occurred');
}

async function handleOutOfMoneyCase(page) {
  await waitForSelectorForever(page, 'text/xDAI balance too low!');
  handleAsFatalError('Out of money. Terminating');
}

async function handleGameJoinFail(page) {
  await waitForSelectorForever(page, 'text/Error Joining Game:');
  handleAsFatalError('Cloud not join game. Terminating');
}

async function waitForSelectorForever(page, selector, options = {}) {
  while (true) {
    try {
      return await page.waitForSelector(selector, {
        timeout: 0,
        ...options,
      });
    } catch (e) {
      const isTimeoutError = e.message?.includes('timed out');
      if (!isTimeoutError) throw e;
    }
  }
}

main().catch(console.error);
