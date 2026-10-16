const originalEmitWarning = process.emitWarning;

beforeAll(() => {
  process.emitWarning = (...args) => {
    const warning = args[0];
    const message = typeof warning === 'string' ? warning : warning?.message;

    // Ignore noisy runtime warning that does not affect backend test outcomes.
    if (typeof message === 'string' && message.includes('--localstorage-file')) {
      return;
    }

    return originalEmitWarning.apply(process, args);
  };
});

afterAll(() => {
  process.emitWarning = originalEmitWarning;
});
