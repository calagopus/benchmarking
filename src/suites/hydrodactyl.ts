import { Suite, type SuiteObserver } from '../core/suite.ts';
import type { ResourceLimit, Scenario } from '../core/types.ts';
import { HydrodactylPanel, type HydrodactylPanelOptions } from '../panels/hydrodactyl.ts';

export interface HydrodactylSuiteOptions {
  readonly panel?: HydrodactylPanelOptions;
  readonly scenarios?: readonly Scenario[];
  readonly variants?: readonly ResourceLimit[];
  readonly observer?: SuiteObserver;
}

export function hydrodactylSuite(options: HydrodactylSuiteOptions = {}): Suite {
  return new Suite({
    panel: new HydrodactylPanel(options.panel),
    scenarios: options.scenarios,
    variants: options.variants,
    observer: options.observer,
  });
}
