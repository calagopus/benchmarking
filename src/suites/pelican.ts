import { Suite, type SuiteObserver } from '../core/suite.ts';
import type { ResourceLimit, Scenario } from '../core/types.ts';
import { PelicanPanel, type PelicanPanelOptions } from '../panels/pelican.ts';

export interface PelicanSuiteOptions {
  readonly panel?: PelicanPanelOptions;
  readonly scenarios?: readonly Scenario[];
  readonly variants?: readonly ResourceLimit[];
  readonly observer?: SuiteObserver;
}

export function pelicanSuite(options: PelicanSuiteOptions = {}): Suite {
  return new Suite({
    panel: new PelicanPanel(options.panel),
    scenarios: options.scenarios,
    variants: options.variants,
    observer: options.observer,
  });
}
