import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {accountRows, currentTailnet, parseProfiles} from '../src/accounts.js';

const LIST = readFileSync(new URL('fixtures/switch-list.json', import.meta.url), 'utf8');

test('parseProfiles reads the profiles in order, with the selected one marked', () => {
    assert.deepEqual(parseProfiles(LIST), [
        {id: '1a2b', tailnet: 'example.org', nickname: '', account: 'alex@example.org', selected: true},
        {id: '3c4d', tailnet: 'example.net', nickname: '', account: 'alex@example.net', selected: false},
    ]);
});

test('parseProfiles treats a missing account as empty and keeps the profile', () => {
    const [profile] = parseProfiles('[{"id": "9z", "tailnet": "example.org", "selected": false}]');
    assert.equal(profile.account, '');
    assert.equal(profile.tailnet, 'example.org');
});

test('parseProfiles gives null for output that is not a usable list', () => {
    assert.equal(parseProfiles(''), null);
    assert.equal(parseProfiles('not json'), null);
    assert.equal(parseProfiles('{"id": "1a2b"}'), null);
    assert.equal(parseProfiles('[]'), null);
    // An entry without an id cannot be switched to.
    assert.equal(parseProfiles('[{"tailnet": "example.org"}, null, 3]'), null);
    assert.equal(parseProfiles('[{"id": ""}]'), null);
});

test('parseProfiles skips an entry without an id and keeps the others', () => {
    const profiles = parseProfiles('[{"tailnet": "a"}, {"id": "2", "tailnet": "b", "selected": true}]');
    assert.deepEqual(profiles.map(profile => profile.id), ['2']);
});

const profiles = parseProfiles(LIST);
const idle = {profiles, loading: false, failed: false};

test('accountRows shows one row per profile, the selected one marked, account under the tailnet', () => {
    assert.deepEqual(accountRows(idle, null), {
        profiles: [
            {id: '1a2b', title: 'example.org', account: 'alex@example.org', selected: true,
                sensitive: true, progress: ''},
            {id: '3c4d', title: 'example.net', account: 'alex@example.net', selected: false,
                sensitive: true, progress: ''},
        ],
    });
});

test('accountRows names a profile without a tailnet by its nickname, then its id', () => {
    const rows = accountRows({
        profiles: parseProfiles('[{"id": "a1", "nickname": "work"}, {"id": "b2"}]'),
        loading: false,
        failed: false,
    }, null).profiles;
    assert.deepEqual(rows.map(row => row.title), ['work', 'b2']);
    assert.deepEqual(rows.map(row => row.account), ['', '']);
});

test('accountRows shows Loading… until a first answer, and the previous profiles while loading', () => {
    assert.deepEqual(accountRows({profiles: null, loading: false, failed: false}, null), {message: 'Loading…'});
    assert.deepEqual(accountRows({profiles: null, loading: true, failed: false}, null), {message: 'Loading…'});
    const rows = accountRows({profiles, loading: true, failed: false}, null).profiles;
    assert.deepEqual(rows.map(row => row.sensitive), [false, false]);
    assert.deepEqual(rows.map(row => row.selected), [true, false]);
});

test('accountRows shows a single message when the list failed', () => {
    assert.deepEqual(accountRows({profiles: null, loading: false, failed: true}, null),
        {message: 'Could not list accounts'});
});

test('accountRows locks every row while an action is pending and shows Switching… on the chosen one', () => {
    const rows = accountRows(idle, {kind: 'switch', id: '3c4d'}).profiles;
    assert.deepEqual(rows.map(row => row.sensitive), [false, false]);
    assert.deepEqual(rows.map(row => row.progress), ['', 'Switching…']);
    // Another action locks the rows without naming a profile.
    const other = accountRows(idle, {kind: 'set', flag: 'shields-up', value: true}).profiles;
    assert.deepEqual(other.map(row => row.sensitive), [false, false]);
    assert.deepEqual(other.map(row => row.progress), ['', '']);
});

test('currentTailnet prefers the status, then the selected profile, then nothing', () => {
    assert.equal(currentTailnet({CurrentTailnet: {Name: 'example.org'}}, profiles), 'example.org');
    assert.equal(currentTailnet({}, profiles), 'example.org');
    assert.equal(currentTailnet(null, null), '');
    assert.equal(currentTailnet({CurrentTailnet: {Name: ''}}, [{...profiles[1], selected: false}]), '');
});
