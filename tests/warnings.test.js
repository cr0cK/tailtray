import assert from 'node:assert/strict';
import {test} from 'node:test';

import {buildWarnings, keyExpiryWarning} from '../src/warnings.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = ms => new Date(NOW + ms).toISOString();

test('a key that expires in 8 days gives no warning', () => {
    assert.equal(keyExpiryWarning(at(8 * DAY), NOW), null);
    assert.equal(keyExpiryWarning(at(7 * DAY + 1000), NOW), null);
});

test('a key that expires in 7 days gives a warning in days', () => {
    assert.equal(keyExpiryWarning(at(7 * DAY), NOW), 'This device\'s key expires in 7 days.');
    assert.equal(keyExpiryWarning(at(2 * DAY + 5 * HOUR), NOW), 'This device\'s key expires in 2 days.');
});

test('a key that expires in one day says day, not days', () => {
    assert.equal(keyExpiryWarning(at(DAY), NOW), 'This device\'s key expires in 1 day.');
});

test('a key that expires in under 24 hours says less than a day', () => {
    assert.equal(keyExpiryWarning(at(23 * HOUR), NOW), 'This device\'s key expires in less than a day.');
    assert.equal(keyExpiryWarning(at(1000), NOW), 'This device\'s key expires in less than a day.');
});

test('a key past its expiry has expired', () => {
    assert.equal(keyExpiryWarning(at(-1000), NOW), 'This device\'s key has expired.');
    assert.equal(keyExpiryWarning(at(0), NOW), 'This device\'s key has expired.');
});

test('a missing, zero, or unreadable KeyExpiry means the key does not expire', () => {
    assert.equal(keyExpiryWarning(undefined, NOW), null);
    assert.equal(keyExpiryWarning('', NOW), null);
    assert.equal(keyExpiryWarning('0001-01-01T00:00:00Z', NOW), null);
    assert.equal(keyExpiryWarning('garbage', NOW), null);
});

test('buildWarnings puts the key expiry first, then Health in its order', () => {
    const status = {
        Self: {KeyExpiry: at(2 * DAY)},
        Health: ['first problem', 'second problem'],
    };
    assert.deepEqual(buildWarnings(status, NOW), [
        'This device\'s key expires in 2 days.',
        'first problem',
        'second problem',
    ]);
});

test('buildWarnings removes the Tailscale is stopped entry only', () => {
    const status = {Health: ['Tailscale is stopped.', 'Tailscale is stopped. Really.', 'other']};
    assert.deepEqual(buildWarnings(status, NOW), ['Tailscale is stopped. Really.', 'other']);
});

test('buildWarnings tolerates a missing or null Health', () => {
    assert.deepEqual(buildWarnings({Health: null}, NOW), []);
    assert.deepEqual(buildWarnings({}, NOW), []);
    assert.deepEqual(buildWarnings({Health: [null, 3, '']}, NOW), []);
});
