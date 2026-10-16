module.exports = {
  preset: 'jest-expo',
  roots: ['<rootDir>/src', '<rootDir>/tests/frontend'],
  testMatch: [
    '<rootDir>/src/**/__tests__/**/*.(test|spec).(ts|tsx)',
    '<rootDir>/src/**/*.(test|spec).(ts|tsx)',
    '<rootDir>/tests/frontend/**/*.(test|spec).(ts|tsx)',
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  setupFilesAfterEnv: ['<rootDir>/tests/frontend/setup/jest.setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!(?:.pnpm/)?((jest-)?react-native|@react-native(?:-community)?|expo(?:nent)?|@expo(?:nent)?/.*|@expo-google-fonts/.*|@react-navigation/.*|react-navigation|react-native-svg))',
  ],
  modulePathIgnorePatterns: ['<rootDir>/backend/', '<rootDir>/android/'],
  collectCoverageFrom: [
    'src/utils/colorCode.ts',
    'src/utils/format.ts',
    'src/utils/polyline.ts',
    'src/utils/segmentRoute.ts',
    'src/utils/lightingScore.ts',
    'src/services/openStreetMap.ts',
    'src/services/segmentScoring.ts',
    '!**/*.d.ts',
  ],
  coverageDirectory: '<rootDir>/coverage/frontend',
  coverageReporters: ['text', 'json-summary', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      statements: 70,
      lines: 70,
      functions: 75,
      branches: 50,
    },
  },
};
