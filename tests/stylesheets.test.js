import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const sheet = style => readFileSync(new URL(`../src/stylesheet-${style}.css`, import.meta.url), 'utf8');
const [dark, light] = [sheet('dark'), sheet('light')];

// The rules of a stylesheet: selector to its declarations, as written.
function rules(text) {
    const found = new Map();
    for (const [, selector, body] of text.replaceAll(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g))
        found.set(selector.trim().replaceAll(/\s+/g, ' '), body.trim().replaceAll(/\s+/g, ' '));
    return found;
}

const declaration = (style, selector, property) =>
    new RegExp(`${property}:\\s*([^;]+);`).exec(rules(sheet(style)).get(selector))?.[1];

test('each stylesheet is complete: both define the same selectors', () => {
    assert.deepEqual([...rules(dark).keys()].sort(), [...rules(light).keys()].sort());
    assert.ok(rules(dark).size > 15);
});

test('the two stylesheets differ only in the green, the pill, and the stop button', () => {
    const differing = [...rules(dark)].filter(([selector, body]) => rules(light).get(selector) !== body)
        .map(([selector]) => selector);
    assert.deepEqual(differing.sort(), [
        '.tailtray-pill', '.tailtray-state-connected', '.tailtray-stop', '.tailtray-stop:hover, .tailtray-stop:focus',
    ]);
});

test('the tile colors are the GNOME palette, in both styles', () => {
    const palette = {
        blue: '#3584e4', teal: '#2190a4', orange: '#e66100', brown: '#865e3c',
        grey: '#77767b', purple: '#9141ac', slate: '#6f8396', green: '#26a269',
    };
    for (const style of ['dark', 'light']) {
        for (const [name, color] of Object.entries(palette))
            assert.equal(declaration(style, `.tailtray-tile-${name}`, 'background-color'), color, `${style} ${name}`);
    }
});

test('the header green and the stop color follow the Shell style', () => {
    assert.equal(declaration('dark', '.tailtray-state-connected', 'color'), '#33d17a');
    assert.equal(declaration('light', '.tailtray-state-connected', 'color'), '#26a269');
    assert.equal(declaration('dark', '.tailtray-stop', 'color'), '#ff7b63');
    assert.equal(declaration('light', '.tailtray-stop', 'color'), '#c01c28');
});

test('captions are bold in the accent color, and a share text column is 22 em wide', () => {
    for (const style of ['dark', 'light']) {
        assert.equal(declaration(style, '.tailtray-caption', 'font-weight'), 'bold');
        assert.equal(declaration(style, '.tailtray-caption', 'color'), '-st-accent-color');
        assert.equal(declaration(style, '.tailtray-share-text', 'width'), '22em');
        assert.equal(declaration(style, '.tailtray-tile', 'width'), '24px');
        assert.equal(declaration(style, '.tailtray-tile-icon', 'icon-size'), '14px');
        assert.equal(declaration(style, '.tailtray-tile-icon', 'color'), '#ffffff');
    }
});
