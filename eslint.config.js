const typescriptEslint = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const n8nNodesBase = require('eslint-plugin-n8n-nodes-base');

module.exports = [
	{
		ignores: ['.eslintrc.js', '**/*.js', '**/node_modules/**', '**/dist/**'],
	},
	{
		files: ['package.json'],
		languageOptions: {
			parser: require('jsonc-eslint-parser'),
		},
		plugins: {
			'n8n-nodes-base': n8nNodesBase,
		},
		rules: {
			...n8nNodesBase.configs.community.rules,
			'n8n-nodes-base/community-package-json-name-still-default': 'off',
		},
	},
	{
		files: ['./credentials/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: ['./tsconfig.json'],
				sourceType: 'module',
				extraFileExtensions: ['.json'],
			},
		},
		plugins: {
			'@typescript-eslint': typescriptEslint,
			'n8n-nodes-base': n8nNodesBase,
		},
		rules: {
			...n8nNodesBase.configs.credentials.rules,
			'n8n-nodes-base/cred-class-field-documentation-url-missing': 'off',
			'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
		},
	},
	{
		files: ['./nodes/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: ['./tsconfig.json'],
				sourceType: 'module',
				extraFileExtensions: ['.json'],
			},
		},
		plugins: {
			'@typescript-eslint': typescriptEslint,
			'n8n-nodes-base': n8nNodesBase,
		},
		rules: {
			...n8nNodesBase.configs.nodes.rules,
			'n8n-nodes-base/node-execute-block-missing-continue-on-fail': 'off',
			'n8n-nodes-base/node-resource-description-filename-against-convention': 'off',
			'n8n-nodes-base/node-param-fixed-collection-type-unsorted-items': 'off',
			'n8n-nodes-base/node-class-description-outputs-wrong': 'off',
		},
	},
];