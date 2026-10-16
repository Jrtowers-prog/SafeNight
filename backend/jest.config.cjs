module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/coverage/'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/jest.setup.js'],
  clearMocks: true,
  restoreMocks: true,
  silent: true,
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/server.js',
    '!src/**/migrations/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageThreshold: {
    global: {
      statements: 70,
      lines: 70,
      functions: 75,
      branches: 50,
    },
  },
};
