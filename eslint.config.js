import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

// GJS provides these globals inside GNOME Shell and the preferences process.
const gjsGlobals = {
    ARGV: 'readonly',
    global: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    console: 'readonly',
};

export default [
    {ignores: ['dist/', 'node_modules/']},
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: gjsGlobals,
        },
        plugins: {'@stylistic': stylistic},
        rules: {
            'eqeqeq': ['error', 'always'],
            'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_'}],
            'prefer-const': 'error',
            'no-var': 'error',
            'curly': ['error', 'multi-or-nest', 'consistent'],
            '@stylistic/indent': ['error', 4, {SwitchCase: 0}],
            '@stylistic/quotes': ['error', 'single', {avoidEscape: true}],
            '@stylistic/semi': ['error', 'always'],
            // Trailing commas in literals and imports, never in call arguments (GNOME style).
            '@stylistic/comma-dangle': ['error', {
                arrays: 'always-multiline',
                objects: 'always-multiline',
                imports: 'always-multiline',
                exports: 'always-multiline',
                functions: 'never',
            }],
            '@stylistic/brace-style': ['error', '1tbs', {allowSingleLine: true}],
            '@stylistic/object-curly-spacing': ['error', 'never'],
            '@stylistic/array-bracket-spacing': ['error', 'never'],
            '@stylistic/arrow-parens': ['error', 'as-needed'],
            '@stylistic/keyword-spacing': 'error',
            '@stylistic/space-infix-ops': 'error',
            '@stylistic/no-trailing-spaces': 'error',
            '@stylistic/eol-last': 'error',
            '@stylistic/max-len': ['error', {
                code: 110,
                ignoreStrings: true,
                ignoreTemplateLiterals: true,
                ignoreRegExpLiterals: true,
            }],
        },
    },
    {
        files: ['tests/**/*.js', 'eslint.config.js'],
        languageOptions: {globals: globals.node},
    },
];
