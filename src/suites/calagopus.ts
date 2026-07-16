import { Suite, type SuiteObserver } from '../core/suite.ts';
import type { ResourceLimit, Scenario } from '../core/types.ts';
import { CalagopusPanel, type CalagopusPanelOptions } from '../panels/calagopus.ts';

export interface CalagopusSuiteOptions {
  readonly panel?: CalagopusPanelOptions;
  readonly scenarios?: readonly Scenario[];
  readonly variants?: readonly ResourceLimit[];
  readonly observer?: SuiteObserver;
}

export function calagopusSuite(options: CalagopusSuiteOptions = {}): Suite {
  return new Suite({
    panel: new CalagopusPanel(options.panel),
    scenarios: options.scenarios,
    variants: options.variants,
    observer: options.observer,
  });
}
