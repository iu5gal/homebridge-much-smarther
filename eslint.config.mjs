import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', '**/coverage/', 'reference/', 'captures/', 'pack/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
    rules: {
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // The setup page runs in the browser, inside the Homebridge UI.
    files: ['packages/homebridge-plugin/homebridge-ui/public/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        homebridge: 'readonly',
        setInterval: 'readonly',
        IntersectionObserver: 'readonly',
      },
    },
  },
);
