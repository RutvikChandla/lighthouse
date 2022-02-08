/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/**
 * @fileoverview
 * 1) sets global.expect
 * 2) configures the mocha test runner to use jest-snapshot
 */

// TODO jest-fake-timers
// TODO why cant i require expect/build/matchers.js now
// TODO use ts-node

const path = require('path');
const expect = require('expect');
const {SnapshotState, toMatchSnapshot, toMatchInlineSnapshot} = require('jest-snapshot');
// TODO
// const {default: {toBeCloseTo}} = require('expect/build/matchers.js');
const format = require('../../shared/localization/format.js');

/** @type {Map<string, SnapshotState['prototype']>} */
const snapshotStatesByTestFile = new Map();
let snapshotTestFailed = false;

/**
 * @param {string} testFile
 */
function getSnapshotState(testFile) {
  // For every test file, persist the same snapshot state object so there is
  // not a read/write per snapshot access/change, but one per file.
  let snapshotState = snapshotStatesByTestFile.get(testFile);
  if (snapshotState) return snapshotState;

  const snapshotDir = path.join(path.dirname(testFile), '__snapshots__');
  const snapshotFile = path.join(snapshotDir, path.basename(testFile) + '.snap');
  snapshotState = new SnapshotState(snapshotFile, {
    updateSnapshot: process.env.SNAPSHOT_UPDATE ? 'all' : 'new',
    prettierPath: '',
    snapshotFormat: {},
  });
  snapshotStatesByTestFile.set(testFile, snapshotState);
  return snapshotState;
}

/**
 * @param {Mocha.Test} test
 * @return {string}
 */
function makeTestTitle(test) {
  /** @type {Mocha.Test | Mocha.Suite} */
  let next = test;
  const title = [];

  for (;;) {
    if (!next.parent) {
      break;
    }

    title.push(next.title);
    next = next.parent;
  }

  return title.reverse().join(' ');
}

expect.extend({
  /**
   * @param {any} actual
   */
  toMatchSnapshot(actual) {
    const test = mochaCurrentTest;
    if (!test.file) throw new Error('unexpected value');

    const title = makeTestTitle(test);
    const snapshotState = getSnapshotState(test.file);
    /** @type {import('jest-snapshot/build/types').Context} */
    // @ts-expect-error - this is enough for snapshots to work.
    const context = {snapshotState, currentTestName: title};
    const matcher = toMatchSnapshot.bind(context);
    const result = matcher(actual);
    if (!result.pass) snapshotTestFailed = true;
    return result;
  },
  /**
   * @param {any} actual
   * @param {any} expected
   */
  toMatchInlineSnapshot(actual, expected) {
    const test = mochaCurrentTest;
    if (!test.file) throw new Error('unexpected value');

    const title = makeTestTitle(test);
    const snapshotState = getSnapshotState(test.file);
    /** @type {import('jest-snapshot/build/types').Context} */
    // @ts-expect-error - this is enough for snapshots to work.
    const context = {snapshotState, currentTestName: title};
    const matcher = toMatchInlineSnapshot.bind(context);
    const result = matcher(actual, expected);
    if (!result.pass) snapshotTestFailed = true;
    return result;
  },
});

expect.extend({
  toBeDisplayString(received, expected) {
    if (!format.isIcuMessage(received)) {
      const message = () =>
      [
        `${this.utils.matcherHint('.toBeDisplayString')}\n`,
        `Expected object to be an ${this.utils.printExpected('LH.IcuMessage')}`,
        `Received ${typeof received}`,
        `  ${this.utils.printReceived(received)}`,
      ].join('\n');

      return {message, pass: false};
    }

    const actual = format.getFormatted(received, 'en-US');
    const pass = expected instanceof RegExp ?
      expected.test(actual) :
      actual === expected;

    const message = () =>
      [
        `${this.utils.matcherHint('.toBeDisplayString')}\n`,
        `Expected object to be a display string matching:`,
        `  ${this.utils.printExpected(expected)}`,
        `Received:`,
        `  ${this.utils.printReceived(actual)}`,
      ].join('\n');

    return {message, pass};
  },

  // Expose toBeCloseTo() so it can be used as an asymmetric matcher.
  toBeApproximately(...args) {
    // If called asymmetrically, a fake matcher `this` object needs to be passed
    // in (see https://github.com/facebook/jest/issues/8295). There's no effect
    // because it's only used for the printing of full failures, which isn't
    // done for asymmetric matchers anyways.
    const thisObj = (this && this.utils) ? this :
        {isNot: false, promise: ''};
    // @ts-expect-error
    return toBeCloseTo.call(thisObj, ...args);
  },
  /**
    * Asserts that an inspectable promise created by makePromiseInspectable is currently resolved or rejected.
    * This is useful for situations where we want to test that we are actually waiting for a particular event.
    *
    * @param {ReturnType<typeof import('./test-utils')['makePromiseInspectable']>} received
    * @param {string} failureMessage
    */
  toBeDone(received, failureMessage) {
    const pass = received.isDone();

    const message = () =>
      [
        `${this.utils.matcherHint('.toBeDone')}\n`,
        `Expected promise to be resolved: ${this.utils.printExpected(failureMessage)}`,
        `  ${this.utils.printReceived(received.getDebugValues())}`,
      ].join('\n');

    return {message, pass};
  },
});

// @ts-expect-error
global.expect = expect;

/**
 * @param {Mocha.HookFunction} mochaFn
 * @return {jest.Lifecycle}
 */
const makeFn = (mochaFn) => (fn, timeout) => {
  mochaFn(function() {
    // eslint-disable-next-line no-invalid-this
    if (timeout !== undefined) this.timeout(timeout);

    /** @type {jest.DoneCallback} */
    const cb = () => {};
    cb.fail = (error) => {
      throw new Error(typeof error === 'string' ? error : error?.message);
    };
    return fn(cb);
  });
};

const {before, after} = require('mocha');
global.beforeAll = makeFn(before);
global.afterAll = makeFn(after);

/** @type {Mocha.Test} */
let mochaCurrentTest;
module.exports = {
  mochaHooks: {
    /** @this {Mocha.Context} */
    beforeEach() {
      if (!this.currentTest) throw new Error('unexpected value');

      // Needed so `expect` extension method can access information about the current test.
      mochaCurrentTest = this.currentTest;
    },
    afterAll() {
      for (const snapshotState of snapshotStatesByTestFile.values()) {
        // Jest adds `file://` to inline snapshot paths, and uses its own fs module to read things,
        // falling back to fs.readFileSync if not defined. node `fs` does not support
        // protocols in the path specifier, so we remove it here.
        // @ts-expect-error - private property.
        for (const snapshot of snapshotState._inlineSnapshots) {
          snapshot.frame.file = snapshot.frame.file.replace('file://', '');
        }

        snapshotState.save();
      }

      if (!process.env.SNAPSHOT_UPDATE && snapshotTestFailed) {
        process.on('exit', () => {
          console.log('To update snapshots, run again with `yarn mocha -u`');
        });
      }
    },
  },
};
