import assert from 'node:assert/strict';
import {test} from 'node:test';

import {describeFailure} from '../src/errors.js';

const failure = (fields = {}) => ({exitCode: 1, stdout: '', stderr: '', ...fields});

test('a missing CLI explains itself and offers the download page', () => {
    const error = describeFailure(failure({missing: true, exitCode: -1}), 'alex');
    assert.equal(error.text, 'The Tailscale CLI is not installed.');
    assert.deepEqual(error.link, {label: 'Install Tailscale', url: 'https://tailscale.com/download/linux'});
    assert.equal(error.command, null);
});

test('a daemon that is down gives the service command, for both messages', () => {
    for (const stderr of [
        'failed to connect to local tailscaled; it doesn\'t appear to be running',
        'Failed to connect: is Tailscale running?',
    ]) {
        const error = describeFailure(failure({stderr}), 'alex');
        assert.equal(error.text, 'The Tailscale service is not running.');
        assert.equal(error.command, 'sudo systemctl enable --now tailscaled');
    }
});

test('the output is searched on stdout too', () => {
    const error = describeFailure(failure({stdout: 'failed to connect to local tailscaled'}), 'alex');
    assert.equal(error.text, 'The Tailscale service is not running.');
});

test('an access denied gives the operator command with the user name', () => {
    for (const stderr of ['Access denied: prefs write access denied', 'error: access denied']) {
        const error = describeFailure(failure({stderr}), 'alex');
        assert.equal(error.text, 'Tailtray needs you to be the Tailscale operator.');
        assert.equal(error.command, 'sudo tailscale set --operator=alex');
    }
});

test('a timeout says so', () => {
    const error = describeFailure(failure({timedOut: true, exitCode: -1}), 'alex');
    assert.equal(error.text, 'The command timed out.');
});

test('an unreadable status says so', () => {
    const error = describeFailure(failure({unreadable: true, exitCode: 0, stdout: '<html>'}), 'alex');
    assert.equal(error.text, 'Tailscale returned a status Tailtray cannot read.');
});

test('anything else shows the first non-empty line of stderr', () => {
    const error = describeFailure(failure({stderr: '\n  \nsomething broke\nsecond line\n'}), 'alex');
    assert.equal(error.text, 'something broke');
    assert.equal(error.command, null);
    assert.equal(error.link, null);
});

test('anything else with an empty stderr says the command failed', () => {
    assert.equal(describeFailure(failure({stderr: ' \n'}), 'alex').text, 'The command failed.');
    assert.equal(describeFailure(failure(), 'alex').text, 'The command failed.');
});

test('the table is checked in order', () => {
    // Missing wins over everything, then the service, then access, then the timeout.
    const all = {missing: true, timedOut: true, unreadable: true, stderr: 'is Tailscale running? Access denied'};
    assert.equal(describeFailure(failure(all), 'a').text, 'The Tailscale CLI is not installed.');
    delete all.missing;
    assert.equal(describeFailure(failure(all), 'a').text, 'The Tailscale service is not running.');
    all.stderr = 'Access denied';
    assert.equal(describeFailure(failure(all), 'a').text, 'Tailtray needs you to be the Tailscale operator.');
    all.stderr = 'other';
    assert.equal(describeFailure(failure(all), 'a').text, 'The command timed out.');
    delete all.timedOut;
    assert.equal(describeFailure(failure(all), 'a').text, 'Tailscale returned a status Tailtray cannot read.');
    delete all.unreadable;
    assert.equal(describeFailure(failure(all), 'a').text, 'other');
});
