/**
 * Copyright 2019 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from 'fs';
import rimraf from 'rimraf';
import { promisify } from 'util';
import { Dispatcher } from './dispatcher';
import './expect';
import { matrix, ParameterRegistration, parameterRegistrations, setParameterValues } from './fixtures';
import { Reporter } from './reporter';
import { Config } from './config';
import { generateTests } from './testGenerator';
import { raceAgainstTimeout, serializeError } from './util';
import { RunnerSuite } from './runnerTest';
import { runnerSpec } from './runnerSpec';
import { debugLog } from './debug';
import { Suite } from './test';
export { Reporter } from './reporter';
export { Config } from './config';

const removeFolderAsync = promisify(rimraf);

type RunResult = 'passed' | 'failed' | 'forbid-only' | 'no-tests';

export class Runner {
  private _config: Config;
  private _reporter: Reporter;
  private _beforeFunctions: Function[] = [];
  private _afterFunctions: Function[] = [];
  private _rootSuite: RunnerSuite;
  private _hasBadFiles = false;
  private _suites: RunnerSuite[] = [];

  constructor(config: Config, reporter: Reporter) {
    this._config = config;
    this._reporter = reporter;
  }

  loadFiles(files: string[]): { parameters: ParameterRegistration[] } {
    // Resolve symlinks. TODO: do this asynchronously?
    files = files.map(file => fs.realpathSync(file));
    debugLog(`loadFiles`, files);
    // First traverse tests.
    for (const file of files) {
      const suite = new RunnerSuite('');
      suite.file = file;
      const revertBabelRequire = runnerSpec(suite, this._config.timeout);
      try {
        require(file);
        this._suites.push(suite);
      } catch (error) {
        this._reporter.onError(serializeError(error), file);
        this._hasBadFiles = true;
      } finally {
        revertBabelRequire();
      }
    }

    // Set default values
    for (const param of parameterRegistrations.values()) {
      if (!(param.name in matrix))
        setParameterValues(param.name, [param.defaultValue]);
    }
    return { parameters: [...parameterRegistrations.values()] };
  }

  generateTests(options: { parameters?: any } = {}): Suite {
    if (options.parameters) {
      for (const name of Object.keys(options.parameters))
        setParameterValues(name, [options.parameters[name]]);
    }

    // We can only generate tests after parameters have been assigned.
    this._rootSuite = generateTests(this._suites, this._config);
    return this._rootSuite;
  }

  list() {
    this._reporter.onBegin(this._config, this._rootSuite);
    this._reporter.onEnd();
  }

  async run(): Promise<RunResult> {
    await removeFolderAsync(this._config.outputDir).catch(e => {});
    fs.mkdirSync(this._config.outputDir, { recursive: true });

    if (this._config.forbidOnly) {
      const hasOnly = this._rootSuite.findSpec(t => t._only) || this._rootSuite.findSuite(s => s._only);
      if (hasOnly)
        return 'forbid-only';
    }

    const total = this._rootSuite.total;
    if (!total && !this._hasBadFiles)
      return 'no-tests';
    const { result, timedOut } = await raceAgainstTimeout(this._runTests(this._rootSuite), this._config.globalTimeout);
    if (timedOut) {
      this._reporter.onTimeout(this._config.globalTimeout);
      process.exit(1);
    }
    return result;
  }

  private async _runTests(suite: RunnerSuite): Promise<RunResult> {
    // Trial run does not need many workers, use one.
    const runner = new Dispatcher(suite, { ...this._config, jobs: this._config.jobs }, this._reporter);
    try {
      for (const f of this._beforeFunctions)
        await f();
      this._reporter.onBegin(this._config, suite);
      await runner.run();
      await runner.stop();
      this._reporter.onEnd();
    } finally {
      for (const f of this._afterFunctions)
        await f();
    }
    return this._hasBadFiles || runner.hasWorkerErrors() || suite.findSpec(spec => !spec._ok()) ? 'failed' : 'passed';
  }
}
