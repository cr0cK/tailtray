import assert from 'node:assert/strict';
import {test} from 'node:test';

import {parseTime, relativeTime} from '../src/time.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('relativeTime counts under a minute as just now', () => {
    assert.equal(relativeTime(ago(0), NOW), 'just now');
    assert.equal(relativeTime(ago(59 * SECOND + 999), NOW), 'just now');
});

test('relativeTime treats a time in the future as just now', () => {
    assert.equal(relativeTime(ago(-5 * MINUTE), NOW), 'just now');
});

test('relativeTime switches to minutes at one minute and hours at one hour', () => {
    assert.equal(relativeTime(ago(MINUTE), NOW), '1 min ago');
    assert.equal(relativeTime(ago(59 * MINUTE + 59 * SECOND), NOW), '59 min ago');
    assert.equal(relativeTime(ago(HOUR), NOW), '1 h ago');
    assert.equal(relativeTime(ago(23 * HOUR + 59 * MINUTE), NOW), '23 h ago');
});

test('relativeTime switches to days at one day, singular for one', () => {
    assert.equal(relativeTime(ago(DAY), NOW), '1 day ago');
    assert.equal(relativeTime(ago(2 * DAY), NOW), '2 days ago');
    assert.equal(relativeTime(ago(29 * DAY + 23 * HOUR), NOW), '29 days ago');
});

test('relativeTime counts 30 days per month', () => {
    assert.equal(relativeTime(ago(30 * DAY), NOW), '1 month ago');
    assert.equal(relativeTime(ago(59 * DAY), NOW), '1 month ago');
    assert.equal(relativeTime(ago(60 * DAY), NOW), '2 months ago');
    assert.equal(relativeTime(ago(400 * DAY), NOW), '13 months ago');
});

test('relativeTime shows nothing for a missing, zero, or unreadable time', () => {
    assert.equal(relativeTime(undefined, NOW), '');
    assert.equal(relativeTime(null, NOW), '');
    assert.equal(relativeTime('', NOW), '');
    assert.equal(relativeTime('0001-01-01T00:00:00Z', NOW), '');
    assert.equal(relativeTime('not a date', NOW), '');
    assert.equal(relativeTime(12345, NOW), '');
});

test('parseTime reads an ISO time and rejects the zero time', () => {
    assert.equal(parseTime('2026-11-02T12:00:00Z'), NOW);
    assert.equal(parseTime('0001-01-01T00:00:00Z'), null);
});
