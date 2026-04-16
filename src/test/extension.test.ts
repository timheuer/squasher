import * as assert from 'assert';
import { buildCombinedMessage } from '../squash';
import { stripCommentLines } from '../messageEditor';

suite('Squasher Unit Tests', () => {
	test('buildCombinedMessage orders newest-first with short-hash headers', () => {
		const out = buildCombinedMessage([
			{ hash: 'aaaaaaa1111111111111111111111111111111aa', message: 'oldest' },
			{ hash: 'bbbbbbb2222222222222222222222222222222bb', message: 'middle' },
			{ hash: 'ccccccc3333333333333333333333333333333cc', message: 'newest' },
		]);
		const lines = out.split('\n');
		assert.strictEqual(lines[0], '# ccccccc');
		assert.strictEqual(lines[1], 'newest');
		assert.ok(out.indexOf('# bbbbbbb') > out.indexOf('# ccccccc'));
		assert.ok(out.indexOf('# aaaaaaa') > out.indexOf('# bbbbbbb'));
	});

	test('stripCommentLines removes lines starting with #', () => {
		const input = '# comment\nreal message\n# another\nbody line';
		assert.strictEqual(stripCommentLines(input), 'real message\nbody line');
	});

	test('stripCommentLines handles CRLF', () => {
		const input = '# c\r\nkeep\r\n# c2';
		assert.strictEqual(stripCommentLines(input), 'keep');
	});
});

