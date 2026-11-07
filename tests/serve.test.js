import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

import {compareCodePoints, parsePort, readShares, sharedSection, sharesOf, stopArguments, tileOf} from '../src/serve.js';

const SELF = 'workstation.tail1234.ts.net';
const ok = stdout => ({exitCode: 0, stdout, stderr: ''});
const read = (config, self = SELF) => readShares(ok(JSON.stringify(config)), self);
const shares = (config, self = SELF) => sharesOf(config, self);

const web = (host, port, handlers) => ({[`${host}:${port}`]: {Handlers: handlers}});
const proxy = target => ({Proxy: target});

test('a Web share on http: the port stays unless it is 80', () => {
    const [share] = shares({
        TCP: {4173: {HTTP: true}},
        Web: web(SELF, 4173, {'/': proxy('http://127.0.0.1:4173')}),
    });
    assert.equal(share.kind, 'web');
    assert.equal(share.scheme, 'http');
    assert.equal(share.url, 'http://workstation.tail1234.ts.net:4173');
    assert.equal(share.label, 'http://workstation:4173');
    assert.equal(share.target, 'http://127.0.0.1:4173');
    const [on80] = shares({TCP: {80: {HTTP: true}}, Web: web(SELF, 80, {'/': proxy('x')})});
    assert.equal(on80.url, 'http://workstation.tail1234.ts.net');
    assert.equal(on80.label, 'http://workstation');
});

test('a Web share on https: 443 has no port, another port has one', () => {
    const [on443, on8443] = shares({
        TCP: {443: {HTTPS: true}, 8443: {HTTPS: true}},
        Web: {...web(SELF, 443, {'/docs': proxy('3000')}), ...web(SELF, 8443, {'/': proxy('4000')})},
    });
    assert.equal(on443.url, 'https://workstation.tail1234.ts.net/docs');
    assert.equal(on443.label, 'https://workstation/docs');
    assert.equal(on8443.url, 'https://workstation.tail1234.ts.net:8443');
    assert.equal(on8443.label, 'https://workstation:8443');
    // https on 80 and http on 443 keep their port.
    const [https80, http443] = shares({
        TCP: {80: {HTTPS: true}, 443: {HTTP: true}},
        Web: {...web(SELF, 80, {'/': {}}), ...web(SELF, 443, {'/': {}})},
    });
    assert.equal(https80.url, 'https://workstation.tail1234.ts.net:80');
    assert.equal(http443.url, 'http://workstation.tail1234.ts.net:443');
});

test('HTTPS wins over HTTP when both are true', () => {
    const [share] = shares({TCP: {443: {HTTPS: true, HTTP: true}}, Web: web(SELF, 443, {'/': {}})});
    assert.equal(share.scheme, 'https');
});

test('several mounts on one port are several shares, ordered by mount', () => {
    const list = shares({
        TCP: {443: {HTTPS: true}},
        Web: web(SELF, 443, {'/b': proxy('2'), '/': proxy('0'), '/a': proxy('1')}),
    });
    assert.deepEqual(list.map(share => share.mount), ['/', '/a', '/b']);
    assert.deepEqual(list.map(share => share.url), [
        'https://workstation.tail1234.ts.net',
        'https://workstation.tail1234.ts.net/a',
        'https://workstation.tail1234.ts.net/b',
    ]);
    assert.equal(new Set(list.map(share => share.key)).size, 3);
});

test('a TCP share, and a TLS-terminated one', () => {
    const [plain, terminated] = shares({
        TCP: {
            5432: {TCPForward: '127.0.0.1:5432'},
            8443: {TCPForward: '127.0.0.1:9000', TerminateTLS: 'workstation.tail1234.ts.net'},
        },
    });
    assert.equal(plain.kind, 'tcp');
    assert.equal(plain.terminated, false);
    assert.equal(plain.url, 'workstation.tail1234.ts.net:5432');
    assert.equal(plain.label, 'tcp://workstation:5432');
    assert.equal(plain.target, '127.0.0.1:5432');
    assert.equal(terminated.terminated, true);
    assert.equal(terminated.url, 'workstation.tail1234.ts.net:8443');
});

test('without this device\'s name, TCP shares are not listed but Web shares are', () => {
    const config = {
        TCP: {5432: {TCPForward: '127.0.0.1:5432'}, 443: {HTTPS: true}},
        Web: web(SELF, 443, {'/': proxy('x')}),
    };
    const list = shares(config, '');
    assert.deepEqual(list.map(share => share.kind), ['web']);
    assert.equal(list[0].canStop, false);
});

test('a share is public when AllowFunnel is true for its host and port in its own config', () => {
    const list = shares({
        TCP: {443: {HTTPS: true}, 5432: {TCPForward: '127.0.0.1:5432'}, 8080: {HTTP: true}},
        Web: {...web(SELF, 443, {'/': {}}), ...web(SELF, 8080, {'/': {}})},
        AllowFunnel: {[`${SELF}:443`]: true, [`${SELF}:5432`]: true, [`${SELF}:8080`]: false},
    });
    assert.deepEqual(list.map(share => [share.port, share.public]),
        [[443, true], [5432, true], [8080, false]]);
    // A foreground Funnel does not make a background share public, nor the other way round.
    const mixed = shares({
        TCP: {443: {HTTPS: true}},
        Web: web(SELF, 443, {'/': {}}),
        Foreground: {s1: {AllowFunnel: {[`${SELF}:443`]: true}}},
    });
    assert.deepEqual(mixed.map(share => share.public), [false]);
});

test('a foreground share comes from its session, reads like a background one, and has no stop', () => {
    const list = shares({
        Foreground: {
            'session-1': {
                TCP: {8443: {HTTPS: true}},
                Web: web(SELF, 8443, {'/': proxy('http://127.0.0.1:3000')}),
                AllowFunnel: {[`${SELF}:8443`]: true},
            },
        },
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].background, false);
    assert.equal(list[0].public, true);
    assert.equal(list[0].canStop, false);
    assert.equal(list[0].stopArgs, null);
    assert.equal(list[0].url, 'https://workstation.tail1234.ts.net:8443');
    // Sessions with the same share have distinct keys, and so does the background one.
    const same = {TCP: {443: {HTTPS: true}}, Web: web(SELF, 443, {'/': {}})};
    const keys = shares({...same, Foreground: {a: same, b: same}}).map(share => share.key);
    assert.equal(new Set(keys).size, 3);
});

test('a Web entry whose port has neither HTTPS nor HTTP, and a missing TCP entry, are ignored', () => {
    assert.deepEqual(shares({TCP: {443: {}}, Web: web(SELF, 443, {'/': {}})}), []);
    assert.deepEqual(shares({TCP: {443: {HTTPS: false, HTTP: false}}, Web: web(SELF, 443, {'/': {}})}), []);
    assert.deepEqual(shares({Web: web(SELF, 443, {'/': {}})}), []);
    assert.deepEqual(shares({TCP: {443: {HTTPS: 'true'}}, Web: web(SELF, 443, {'/': {}})}), []);
});

test('Services and every other key are ignored', () => {
    assert.deepEqual(shares({
        Services: {'svc:web': {TCP: {443: {HTTPS: true}}, Web: web('svc', 443, {'/': {}})}},
        Something: {TCP: {1: {TCPForward: 'x'}}},
    }), []);
});

test('a host other than this device\'s is listed without a stop', () => {
    const [share] = shares({
        TCP: {443: {HTTPS: true}},
        Web: web('other.tail1234.ts.net', 443, {'/': proxy('x')}),
    });
    assert.equal(share.url, 'https://other.tail1234.ts.net');
    assert.equal(share.label, 'https://other');
    assert.equal(share.canStop, false);
});

test('this device\'s name is matched without regard to case', () => {
    const [share] = shares({TCP: {443: {HTTPS: true}}, Web: web('WorkStation.TAIL1234.ts.net', 443, {'/': {}})});
    assert.equal(share.canStop, true);
});

test('two hosts on one port: neither has a stop', () => {
    const list = shares({
        TCP: {443: {HTTPS: true}},
        Web: {...web(SELF, 443, {'/': {}}), ...web('other.tail1234.ts.net', 443, {'/': {}})},
    });
    assert.equal(list.length, 2);
    assert.deepEqual(list.map(share => share.canStop), [false, false]);
    // Another host on another port does not matter.
    const apart = shares({
        TCP: {443: {HTTPS: true}, 8443: {HTTPS: true}},
        Web: {...web(SELF, 443, {'/': {}}), ...web('other.tail1234.ts.net', 8443, {'/': {}})},
    });
    assert.deepEqual(apart.map(share => share.canStop), [true, false]);
    // A TCP share on that port is in the same case.
    const tcp = shares({
        TCP: {5432: {TCPForward: '127.0.0.1:5432'}},
        Web: web('other.tail1234.ts.net', 5432, {'/': {}}),
    });
    assert.equal(tcp.find(share => share.kind === 'tcp').canStop, true);
});

test('a host in the foreground config does not take the stop from a background share', () => {
    const list = shares({
        TCP: {443: {HTTPS: true}},
        Web: web(SELF, 443, {'/': {}}),
        Foreground: {s: {TCP: {443: {HTTPS: true}}, Web: web('other.tail1234.ts.net', 443, {'/': {}})}},
    });
    assert.deepEqual(list.map(share => [share.background, share.canStop]), [[true, true], [false, false]]);
});

test('the target is the first non-empty field, in order', () => {
    const target = handler => shares({TCP: {443: {HTTPS: true}}, Web: web(SELF, 443, {'/': handler})})[0].target;
    assert.equal(target({Proxy: 'http://127.0.0.1:3000', Path: '/x', Text: 't', Redirect: 'r'}), 'http://127.0.0.1:3000');
    assert.equal(target({Proxy: '', Path: '/srv/www', Text: 't', Redirect: 'r'}), '/srv/www');
    assert.equal(target({Text: 'hello', Redirect: 'https://example.org'}), 'text');
    assert.equal(target({Redirect: 'https://example.org'}), 'redirect https://example.org');
    assert.equal(target({}), '');
    assert.equal(target({Proxy: 7, Path: ['x'], Text: null, Redirect: false}), '');
    assert.equal(target(null), '');
    assert.equal(target('proxy'), '');
});

test('null, {} and an empty config are good reads with no share', () => {
    for (const text of ['null', '{}', '{"TCP": {}, "Web": {}}'])
        assert.deepEqual(readShares(ok(text), SELF), {ok: true, shares: []}, text);
});

test('an array, a scalar, garbage, and an empty output cannot be read', () => {
    for (const text of ['[]', '[{"TCP": {}}]', '"text"', '12', 'true', 'not json', '', '<html>', '{"TCP":'])
        assert.deepEqual(readShares(ok(text), SELF), {ok: false, shares: []}, text);
});

test('a failing, missing or timed out command cannot be read, whatever it printed', () => {
    const good = JSON.stringify({TCP: {5432: {TCPForward: 'x'}}});
    for (const result of [
        {exitCode: 1, stdout: good, stderr: 'boom'},
        {missing: true, exitCode: -1, stdout: '', stderr: ''},
        {timedOut: true, exitCode: -1, stdout: good, stderr: ''},
    ])
        assert.deepEqual(readShares(result, SELF), {ok: false, shares: []});
});

test('fields of the wrong type read as empty or false', () => {
    const odd = [
        {TCP: 'x', Web: 'x', AllowFunnel: 'x', Foreground: 'x'},
        {TCP: [], Web: [], AllowFunnel: [], Foreground: []},
        {TCP: {5432: null}, Web: {[`${SELF}:443`]: null}},
        {TCP: {5432: {TCPForward: 7}, 5433: {TCPForward: ['x']}}},
        {TCP: {443: {HTTPS: true}}, Web: web(SELF, 443, 'handlers')},
        {TCP: {443: {HTTPS: true}}, Web: {[`${SELF}:443`]: {Handlers: null}}},
        {TCP: {443: {HTTPS: true}}, Web: {[`${SELF}:443`]: 'x'}},
        {Foreground: {s: null, t: 'x', u: []}},
    ];
    for (const config of odd)
        assert.deepEqual(shares(config), [], JSON.stringify(config));
    // A wrongly typed funnel flag is not public.
    const [share] = shares({
        TCP: {443: {HTTPS: true}}, Web: web(SELF, 443, {'/': {}}), AllowFunnel: {[`${SELF}:443`]: 'true'},
    });
    assert.equal(share.public, false);
    // A TerminateTLS of the wrong type does not terminate.
    const [tcp] = shares({TCP: {5432: {TCPForward: 'x', TerminateTLS: true}}});
    assert.equal(tcp.terminated, false);
});

test('a port that is not an integer from 1 to 65535 makes its entry ignored', () => {
    for (const port of ['0', '65536', 'abc', '-1', '1.5', '', '00443', ' 443', '443 ', '1e3', '99999999']) {
        assert.deepEqual(shares({
            TCP: {[port]: {HTTPS: true, TCPForward: 'x'}},
            Web: {[`${SELF}:${port}`]: {Handlers: {'/': {}}}},
            Foreground: {s: {TCP: {[port]: {TCPForward: 'x'}}}},
        }), [], `port ${JSON.stringify(port)}`);
    }
    assert.deepEqual(shares({TCP: {1: {TCPForward: 'x'}, 65535: {TCPForward: 'y'}}}).map(share => share.port), [1, 65535]);
    // A Web key without a port, or with an empty host, is ignored too.
    assert.deepEqual(shares({TCP: {443: {HTTPS: true}}, Web: {[SELF]: {Handlers: {'/': {}}}}}), []);
    assert.deepEqual(shares({TCP: {443: {HTTPS: true}}, Web: {':443': {Handlers: {'/': {}}}}}), []);
});

test('parsePort accepts canonical integers only', () => {
    assert.equal(parsePort('443'), 443);
    assert.equal(parsePort('65535'), 65535);
    assert.equal(parsePort('0'), null);
    assert.equal(parsePort(443), null);
    assert.equal(parsePort(null), null);
});

test('the order: background first, then foreground sessions, each by port, host, mount', () => {
    const config = {
        TCP: {9000: {HTTPS: true}, 443: {HTTPS: true}, 5432: {TCPForward: '127.0.0.1:5432'}},
        Web: {
            ...web('b.tail1234.ts.net', 9000, {'/': {}}),
            ...web('a.tail1234.ts.net', 9000, {'/z': {}, '/a': {}}),
            ...web(SELF, 443, {'/': {}}),
        },
        Foreground: {
            'b-session': {TCP: {80: {TCPForward: 'x'}}},
            'a-session': {TCP: {8080: {TCPForward: 'y'}, 90: {TCPForward: 'z'}}},
        },
    };
    const order = list => list.map(share => `${share.background ? 'bg' : 'fg'} ${share.port} ${share.host}${share.mount}`);
    const expected = [
        'bg 443 workstation.tail1234.ts.net/',
        'bg 5432 workstation.tail1234.ts.net',
        'bg 9000 a.tail1234.ts.net/a',
        'bg 9000 a.tail1234.ts.net/z',
        'bg 9000 b.tail1234.ts.net/',
        'fg 90 workstation.tail1234.ts.net',
        'fg 8080 workstation.tail1234.ts.net',
        'fg 80 workstation.tail1234.ts.net',
    ];
    assert.deepEqual(order(shares(config)), expected);
    // The same shares with their keys written in another order come out the same.
    const reversed = value => {
        if (Array.isArray(value) || value === null || typeof value !== 'object')
            return value;
        return Object.fromEntries(
            Object.entries(value).reverse().map(([key, inner]) => [key, reversed(inner)]));
    };
    assert.deepEqual(order(shares(reversed(config))), expected);
    assert.deepEqual(
        shares(reversed(config)).map(share => share.key), shares(config).map(share => share.key));
});

test('the order compares code points, not UTF-16 units', () => {
    assert.ok(compareCodePoints('a', 'b') < 0);
    assert.ok(compareCodePoints('b', 'a') > 0);
    assert.equal(compareCodePoints('a', 'a'), 0);
    assert.ok(compareCodePoints('a', 'ab') < 0);
    // U+1F600 is a surrogate pair in UTF-16, which sorts before U+FF5E there but after by code point.
    assert.ok(compareCodePoints('\u{1F600}', '～') > 0);
    const [first, second] = shares({
        TCP: {443: {HTTPS: true}},
        Web: web(SELF, 443, {'/\u{1F600}': {}, '/～': {}}),
    });
    assert.equal(first.mount, '/～');
    assert.equal(second.mount, '/\u{1F600}');
});

test('the URL percent-encodes each segment of the mount, the label and the command keep it raw', () => {
    const mounts = {
        '/a#b': 'https://workstation.tail1234.ts.net/a%23b',
        '/a?b': 'https://workstation.tail1234.ts.net/a%3Fb',
        '/50%': 'https://workstation.tail1234.ts.net/50%25',
        '/é': 'https://workstation.tail1234.ts.net/%C3%A9',
        '/a b/c': 'https://workstation.tail1234.ts.net/a%20b/c',
        '/docs/': 'https://workstation.tail1234.ts.net/docs/',
        '/': 'https://workstation.tail1234.ts.net',
    };
    for (const [mount, url] of Object.entries(mounts)) {
        const [share] = shares({TCP: {443: {HTTPS: true}}, Web: web(SELF, 443, {[mount]: {}})});
        assert.equal(share.url, url, mount);
        assert.equal(share.label, mount === '/' ? 'https://workstation' : `https://workstation${mount}`);
        assert.deepEqual(share.stopArgs, ['serve', '--https=443', `--set-path=${mount}`, 'off']);
    }
});

test('a mount that cannot be encoded is ignored', () => {
    assert.deepEqual(shares({TCP: {443: {HTTPS: true}}, Web: web(SELF, 443, {'/\uD800': {}})}), []);
});

test('the stop command of each kind', () => {
    const [https, http, tcp, tls] = shares({
        TCP: {
            443: {HTTPS: true},
            4173: {HTTP: true},
            5432: {TCPForward: '127.0.0.1:5432'},
            8443: {TCPForward: '127.0.0.1:9000', TerminateTLS: SELF},
        },
        Web: {...web(SELF, 443, {'/docs': {}}), ...web(SELF, 4173, {'/': {}})},
    });
    assert.deepEqual(https.stopArgs, ['serve', '--https=443', '--set-path=/docs', 'off']);
    assert.deepEqual(http.stopArgs, ['serve', '--http=4173', '--set-path=/', 'off']);
    assert.deepEqual(tcp.stopArgs, ['serve', '--tcp=5432', 'off']);
    assert.deepEqual(tls.stopArgs, ['serve', '--tls-terminated-tcp=8443', 'off']);
    assert.deepEqual(stopArguments(https), https.stopArgs);
    // A public share stops with the same command, and the command never names funnel.
    const [pub] = shares({
        TCP: {443: {HTTPS: true}}, Web: web(SELF, 443, {'/': {}}), AllowFunnel: {[`${SELF}:443`]: true},
    });
    assert.equal(pub.public, true);
    assert.deepEqual(pub.stopArgs, ['serve', '--https=443', '--set-path=/', 'off']);
});

test('only a background share of this device alone on its port has a stop command', () => {
    const list = shares({
        TCP: {443: {HTTPS: true}, 8443: {HTTPS: true}},
        Web: {...web(SELF, 443, {'/': {}}), ...web('other.tail1234.ts.net', 8443, {'/': {}})},
        Foreground: {s: {TCP: {80: {HTTP: true}}, Web: web(SELF, 80, {'/': {}})}},
    });
    assert.deepEqual(list.map(share => [share.canStop, share.stopArgs !== null]),
        [[true, true], [false, false], [false, false]]);
});

test('the same key for the same share, a different one for another config, kind, host, port or mount', () => {
    const base = {TCP: {443: {HTTPS: true}, 5432: {TCPForward: 'x'}}, Web: web(SELF, 443, {'/a': {}, '/b': {}})};
    const first = shares(base).map(share => share.key);
    assert.deepEqual(shares(JSON.parse(JSON.stringify(base))).map(share => share.key), first);
    assert.equal(new Set(first).size, 3);
    // The key does not depend on the target or the funnel, which can change between refreshes.
    const changed = shares({...base, AllowFunnel: {[`${SELF}:443`]: true}, Web: web(SELF, 443, {'/a': proxy('x'), '/b': {}})});
    assert.deepEqual(changed.map(share => share.key), first);
});

test('the tile: public orange, foreground grey, TCP brown, Web teal', () => {
    const tiles = shares({
        TCP: {443: {HTTPS: true}, 4173: {HTTP: true}, 5432: {TCPForward: 'x'}, 6000: {TCPForward: 'y'}},
        Web: {...web(SELF, 443, {'/': {}}), ...web(SELF, 4173, {'/': {}})},
        AllowFunnel: {[`${SELF}:443`]: true, [`${SELF}:6000`]: true},
        Foreground: {s: {TCP: {8443: {TCPForward: 'z'}}, AllowFunnel: {}}, p: {TCP: {9000: {TCPForward: 'z'}}, AllowFunnel: {[`${SELF}:9000`]: true}}},
    }).map(tileOf);
    assert.deepEqual(tiles.map(tile => `${tile.color} ${tile.icon}`), [
        'orange web-browser-symbolic',
        'teal send-to-symbolic',
        'brown network-wired-symbolic',
        'orange web-browser-symbolic',
        'orange web-browser-symbolic',
        'grey utilities-terminal-symbolic',
    ]);
});

test('the Shared section: hidden before a read and with no share, a failure line on a failed read', () => {
    assert.equal(sharedSection(null, null).shown, false);
    assert.equal(sharedSection(undefined, null).shown, false);
    assert.equal(sharedSection(read({}), null).shown, false);
    assert.deepEqual(sharedSection(readShares(ok('nope'), SELF), null), {shown: true, failed: true, rows: []});
});

test('the Shared section rows: label, public mark, second line, stop button', () => {
    const config = {
        TCP: {
            443: {HTTPS: true}, 4173: {HTTP: true}, 5432: {TCPForward: '127.0.0.1:5432'},
            8080: {HTTPS: true},
        },
        Web: {
            ...web(SELF, 443, {'/docs': {Path: '/srv/docs'}}),
            ...web(SELF, 4173, {'/': proxy('http://127.0.0.1:4173')}),
            ...web(SELF, 8080, {'/': {}}),
        },
        AllowFunnel: {[`${SELF}:443`]: true},
        Foreground: {s: {TCP: {8443: {TCPForward: '127.0.0.1:3000'}}}},
    };
    const section = sharedSection(read(config), null);
    assert.equal(section.shown, true);
    const summary = row => [row.label, row.public, row.line, row.canStop, row.stopSensitive];
    assert.deepEqual(section.rows.map(summary), [
        ['https://workstation/docs', true, '→ /srv/docs', true, true],
        ['http://workstation:4173', false, '→ http://127.0.0.1:4173', true, true],
        ['tcp://workstation:5432', false, '→ 127.0.0.1:5432', true, true],
        ['https://workstation:8080', false, '', true, true],
        ['tcp://workstation:8443', false, '→ 127.0.0.1:3000', false, false],
    ]);
    assert.deepEqual(section.rows.map(row => row.stopName), [
        'Stop sharing https://workstation.tail1234.ts.net/docs',
        'Stop sharing http://workstation.tail1234.ts.net:4173',
        'Stop sharing workstation.tail1234.ts.net:5432',
        'Stop sharing https://workstation.tail1234.ts.net:8080',
        'Stop sharing workstation.tail1234.ts.net:8443',
    ]);
});

test('while a stop is pending, its row reads Stopping… and every stop button is insensitive', () => {
    const config = {
        TCP: {4173: {HTTP: true}, 5432: {TCPForward: '127.0.0.1:5432'}},
        Web: web(SELF, 4173, {'/': proxy('http://127.0.0.1:4173')}),
    };
    const list = read(config);
    const key = list.shares[0].key;
    const section = sharedSection(list, {kind: 'stop', key});
    assert.deepEqual(section.rows.map(row => row.line), ['Stopping…', '→ 127.0.0.1:5432']);
    assert.deepEqual(section.rows.map(row => row.stopSensitive), [false, false]);
    assert.deepEqual(section.rows.map(row => row.canStop), [true, true]);
    // Any other action locks the stop buttons too, but no row reads Stopping….
    const other = sharedSection(list, {kind: 'set', flag: 'shields-up', value: true});
    assert.deepEqual(other.rows.map(row => row.line), ['→ http://127.0.0.1:4173', '→ 127.0.0.1:5432']);
    assert.deepEqual(other.rows.map(row => row.stopSensitive), [false, false]);
});

test('the fixture config gives the four shares of the screenshots, in order', () => {
    const text = readFileSync(new URL('fixtures/serve.json', import.meta.url), 'utf8');
    const result = readShares(ok(text), 'laptop.tail1234.ts.net');
    assert.equal(result.ok, true);
    assert.deepEqual(result.shares.map(share => [share.label, share.public, share.canStop]), [
        ['https://laptop/docs', true, true],
        ['http://laptop:4173', false, true],
        ['tcp://laptop:5432', false, true],
        ['https://laptop:8443', false, false],
    ]);
});
