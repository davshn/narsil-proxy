import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

const root = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig(
  {
    basePath: root,
    ignores: ['out/', 'dist/', '.claude/', 'tools/eslint/node_modules/']
  },
  {
    basePath: root,
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }
      ],
      'preserve-caught-error': 'off'
    }
  },
  {
    basePath: root,
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/preserve-manual-memoization': 'off'
    }
  }
)
