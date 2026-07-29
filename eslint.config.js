/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
import config from '@digitalbazaar/eslint-config/node-recommended';

export default [
  ...config,
  {
    ignores: ['vendor/**', 'node_modules/**']
  },
  {
    /* Metro and Babel load their configs through `require`, so these files must
    stay CommonJS. The `prefer-module` rule cannot apply to them. */
    files: [
      'metro.config.js', 'app/metro.config.js', 'app/babel.config.js'
    ],
    languageOptions: {
      sourceType: 'commonjs'
    },
    rules: {
      'unicorn/prefer-module': 'off'
    }
  },
  {
    /* The React Native harness app entry point. Not JSX, but it uses RN globals
    and a dynamic `require` (deliberately -- see the file's comment on why the
    bootstrap cannot be an `import`). */
    files: ['app/index.js'],
    languageOptions: {
      globals: {
        __DEV__: 'readonly',
        console: 'readonly',
        require: 'readonly'
      }
    },
    rules: {
      'unicorn/prefer-module': 'off'
    }
  },
  {
    /* JSX is excluded from root lint rather than half-linted.
    `@digitalbazaar/eslint-config/node-recommended` has no React plugin, so it
    parses JSX (with the option below) but then reports every JSX-referenced
    import as unused -- noise that would train us to ignore lint output. The RN
    app should get its own eslint config with `eslint-plugin-react` once it
    grows past this harness. Library code under `src/` is unaffected and
    keeps the full DB ruleset. */
    ignores: ['app/src/**']
  }
];
